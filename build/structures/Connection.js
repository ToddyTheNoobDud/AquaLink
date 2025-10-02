'use strict'
const { AqualinkEvents } = require('./AqualinkEvents')

const POOL_SIZE = 12
const UPDATE_TIMEOUT = 4000
const RECONNECT_DELAY = 1000
const MAX_RECONNECT_ATTEMPTS = 3
const RESUME_BACKOFF_MAX = 8000
const VOICE_DATA_TIMEOUT = 30000

const STATE_FLAGS = {
  CONNECTED: 1,
  PAUSED: 2,
  SELF_DEAF: 4,
  SELF_MUTE: 8,
  HAS_DEBUG: 16,
  HAS_MOVE: 32,
  UPDATE_SCHEDULED: 64,
  DISCONNECTING: 128,
  ATTEMPTING_RESUME: 256,
  VOICE_DATA_STALE: 512
}

const ENDPOINT_REGION_REGEX = /^([a-z-]+)(?:\d+)?/i

const helpers = {
  safeUnref: timer => timer && typeof timer.unref === 'function' && timer.unref(),
  isValidString: str => typeof str === 'string' && str.length > 0,
  isValidNumber: num => typeof num === 'number' && num >= 0 && Number.isFinite(num),
  resetVoicePayload: voice => {
    voice.token = voice.endpoint = voice.sessionId = null
    voice.resume = voice.sequence = undefined
  },
  extractRegionFromEndpoint: endpoint => {
    const match = ENDPOINT_REGION_REGEX.exec(endpoint)
    return match ? match[1] : 'unknown'
  },
  isNetworkError: err => !!err && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT')
}

class OptimizedPayloadPool {
  constructor () {
    this.pool = new Array(POOL_SIZE)
    this.size = POOL_SIZE
    for (let i = 0; i < POOL_SIZE; i++) this.pool[i] = this._createPayload()
  }

  _createPayload () {
    return {
      guildId: null,
      data: {
        voice: {
          token: null,
          endpoint: null,
          sessionId: null,
          resume: undefined,
          sequence: undefined
        },
        volume: null
      }
    }
  }

  acquire () {
    return this.size > 0 ? this.pool[--this.size] : this._createPayload()
  }

  release (payload) {
    if (!payload || this.size >= POOL_SIZE) return
    payload.guildId = null
    const voice = payload.data.voice
    helpers.resetVoicePayload(voice)
    payload.data.volume = null
    this.pool[this.size++] = payload
  }

  destroy () {
    for (let i = 0; i < this.pool.length; i++) this.pool[i] = null
    this.pool = null
    this.size = 0
  }
}

const sharedPool = new OptimizedPayloadPool()

class Connection {
  constructor (player) {
    if (!player?.aqua?.clientId || !player.nodes?.rest) {
      throw new TypeError('Invalid player configuration')
    }

    this._player = player
    this._aqua = player.aqua
    this._rest = player.nodes.rest
    this._guildId = player.guildId
    this._clientId = player.aqua.clientId

    this.voiceChannel = player.voiceChannel
    this.sessionId = null
    this.endpoint = null
    this.token = null
    this.region = null
    this.sequence = 0

    this._lastEndpoint = null
    this._pendingUpdate = null
    this._stateFlags = 0
    this._reconnectAttempts = 0
    this._destroyed = false
    this._reconnectTimer = null
    this._lastVoiceDataUpdate = 0
    this._consecutiveFailures = 0

    this._executeVoiceUpdate = this._executeVoiceUpdate.bind(this)
    this._handleReconnect = this._handleReconnect.bind(this)
  }

  _hasValidVoiceData () {
    if (!this.sessionId || !this.endpoint || !this.token) return false
    if (Date.now() - this._lastVoiceDataUpdate > VOICE_DATA_TIMEOUT) {
      this._stateFlags |= STATE_FLAGS.VOICE_DATA_STALE
      return false
    }
    return true
  }

  _canAttemptResume () {
    // Allow resume if connection isn't destroyed, attempts remain, and we're
    // not already attempting or disconnecting. If voice data is stale, permit
    // a resume attempt only when the player was restored from persisted state
    // (player._resuming === true).
    if (this._destroyed) return false
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return false
    if (this._stateFlags & (STATE_FLAGS.ATTEMPTING_RESUME | STATE_FLAGS.DISCONNECTING)) return false

    if (this._hasValidVoiceData()) return true

    // If voice data is stale, allow a single resume flow for restored players
    return !!this._player?._resuming
  }

  setServerUpdate (data) {
    if (this._destroyed || !data?.endpoint || !data.token) return
    if (!helpers.isValidString(data.endpoint) || !helpers.isValidString(data.token)) return

    const endpoint = data.endpoint.trim()
    if (this._lastEndpoint === endpoint && this.token === data.token) return

    const newRegion = helpers.extractRegionFromEndpoint(endpoint)
    const regionChanged = this.region !== newRegion
    const endpointChanged = this._lastEndpoint !== endpoint

    if (regionChanged || endpointChanged) {
      if (endpointChanged) {
        this.sequence = 0
        this._lastEndpoint = endpoint
        this._reconnectAttempts = 0
        this._consecutiveFailures = 0
      }
      this.endpoint = endpoint
      this.region = newRegion
    }

    this.token = data.token
    this._lastVoiceDataUpdate = Date.now()
    this._stateFlags &= ~STATE_FLAGS.VOICE_DATA_STALE

    if (this._player.paused) this._player.pause(false)
    this._scheduleVoiceUpdate()
  }

  resendVoiceUpdate () {
    if (this._destroyed || !this._hasValidVoiceData()) return false
    this._scheduleVoiceUpdate()
    return true
  }

  setStateUpdate (data) {
    if (this._destroyed || !data || data.user_id !== this._clientId) return

    const { session_id, channel_id, self_deaf, self_mute } = data

    if (channel_id) {
      let needsUpdate = false

      if (this.voiceChannel !== channel_id) {
        this._aqua.emit(AqualinkEvents.PlayerMove, this.voiceChannel, channel_id)
        this.voiceChannel = channel_id
        this._player.voiceChannel = channel_id
        needsUpdate = true
      }

      if (this.sessionId !== session_id) {
        this.sessionId = session_id
        this._lastVoiceDataUpdate = Date.now()
        this._stateFlags &= ~STATE_FLAGS.VOICE_DATA_STALE
        needsUpdate = true
        this._reconnectAttempts = 0
        this._consecutiveFailures = 0
      }

      this._player.connection.sessionId = session_id || this._player.connection.sessionId
      this._player.self_deaf = !!self_deaf
      this._player.self_mute = !!self_mute
      this._player.selfDeaf = !!self_deaf
      this._player.selfMute = !!self_mute

      this._player.connected = true
      this._stateFlags |= STATE_FLAGS.CONNECTED

      if (needsUpdate) this._scheduleVoiceUpdate()
    } else {
      this._handleDisconnect()
    }
  }

  _handleDisconnect () {
    if (this._destroyed || !(this._stateFlags & STATE_FLAGS.CONNECTED)) return

    this._stateFlags = (this._stateFlags | STATE_FLAGS.DISCONNECTING) & ~STATE_FLAGS.CONNECTED
    this._player.connected = false
    this._clearPendingUpdate()

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }

    this.voiceChannel = null
    this.sessionId = null
    this.sequence = 0
    this._lastVoiceDataUpdate = 0
    this._stateFlags |= STATE_FLAGS.VOICE_DATA_STALE

    try {
      if (typeof this._player.destroy === 'function') this._player.destroy()
    } catch (error) {
      this._aqua.emit(AqualinkEvents.Debug, new Error(`Player destroy failed: ${error?.message || error}`))
    } finally {
      this._stateFlags &= ~STATE_FLAGS.DISCONNECTING
    }
  }

  async attemptResume () {
    if (!this._canAttemptResume()) {
      this._aqua.emit(AqualinkEvents.Debug, `Resume blocked: destroyed=${this._destroyed}, hasValidData=${this._hasValidVoiceData()}, attempts=${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`)

      // If voice data is stale (likely after a restart) and this player is
      // marked as resuming, request a fresh voice state update and schedule
      // a retry instead of destroying the player immediately.
      if ((this._stateFlags & STATE_FLAGS.VOICE_DATA_STALE) && this._player?._resuming) {
        try {
          this._aqua.emit(AqualinkEvents.Debug, `Requesting fresh voice state for guild ${this._guildId}`)
          if (typeof this._player.send === 'function' && this._player.voiceChannel) {
            this._player.send({ guild_id: this._guildId, channel_id: this._player.voiceChannel, self_deaf: this._player.deaf, self_mute: this._player.mute })
            this._reconnectTimer = setTimeout(this._handleReconnect, 1500)
            helpers.safeUnref(this._reconnectTimer)
          }
        } catch (e) {}
      } else if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        this._handleDisconnect()
      }

      return false
    }

    // If the player was restored from disk but core voice data is still missing,
    // request a voice state update and retry shortly rather than attempting a
    // resume payload that will fail.
    if ((!this.sessionId || !this.endpoint || !this.token) && this._player?._resuming) {
      try {
        this._aqua.emit(AqualinkEvents.Debug, `Resuming player but voice data missing, requesting voice state for guild ${this._guildId}`)
        if (typeof this._player.send === 'function' && this._player.voiceChannel) {
          this._player.send({ guild_id: this._guildId, channel_id: this._player.voiceChannel, self_deaf: this._player.deaf, self_mute: this._player.mute })
          this._reconnectTimer = setTimeout(this._handleReconnect, 1500)
          helpers.safeUnref(this._reconnectTimer)
        }
      } catch (e) {}
      return false
    }

    this._stateFlags |= STATE_FLAGS.ATTEMPTING_RESUME
    this._reconnectAttempts++

    this._aqua.emit(AqualinkEvents.Debug, `Attempt resume: guild=${this._guildId} endpoint=${this.endpoint} session=${this.sessionId}`)

    const payload = sharedPool.acquire()

    try {
      payload.guildId = this._guildId
      const voice = payload.data.voice
      voice.token = this.token
      voice.endpoint = this.endpoint
      voice.sessionId = this.sessionId
      voice.resume = true
      voice.sequence = this.sequence
      payload.data.volume = this._player?.volume ?? 100

      await this._sendUpdate(payload)

      this._reconnectAttempts = 0
      this._consecutiveFailures = 0
      if (this._player) this._player._resuming = false
      this._aqua.emit(AqualinkEvents.Debug, `Resume successful for guild ${this._guildId}`)
      return true
    } catch (error) {
      this._consecutiveFailures++
      this._aqua.emit(AqualinkEvents.Debug, `Resume failed for guild ${this._guildId}: ${error?.message || error}`)

      if (this._reconnectAttempts < MAX_RECONNECT_ATTEMPTS && !this._destroyed && this._consecutiveFailures < 5) {
        const delay = Math.min(RECONNECT_DELAY * (1 << (this._reconnectAttempts - 1)), RESUME_BACKOFF_MAX)
        this._reconnectTimer = setTimeout(this._handleReconnect, delay)
        helpers.safeUnref(this._reconnectTimer)
      } else {
        this._aqua.emit(AqualinkEvents.Debug, `Max reconnect attempts or failures reached for guild ${this._guildId}`)
        if (this._player) this._player._resuming = false
        this._handleDisconnect()
      }

      return false
    } finally {
      this._stateFlags &= ~STATE_FLAGS.ATTEMPTING_RESUME
      sharedPool.release(payload)
    }
  }

  _handleReconnect () {
    if (!this._destroyed) this.attemptResume()
  }

  updateSequence (seq) {
    if (helpers.isValidNumber(seq)) this.sequence = Math.max(seq, this.sequence)
  }

  _clearPendingUpdate () {
    this._stateFlags &= ~STATE_FLAGS.UPDATE_SCHEDULED
    if (this._pendingUpdate?.payload) sharedPool.release(this._pendingUpdate.payload)
    this._pendingUpdate = null
  }

  _scheduleVoiceUpdate () {
    if (this._destroyed || !this._hasValidVoiceData() || (this._stateFlags & STATE_FLAGS.UPDATE_SCHEDULED)) return

    this._clearPendingUpdate()
    const payload = sharedPool.acquire()

    payload.guildId = this._guildId
    const voice = payload.data.voice
    voice.token = this.token
    voice.endpoint = this.endpoint
    voice.sessionId = this.sessionId
    voice.resume = undefined
    voice.sequence = undefined
    payload.data.volume = this._player.volume

    this._pendingUpdate = { payload, timestamp: Date.now() }
    this._stateFlags |= STATE_FLAGS.UPDATE_SCHEDULED

    queueMicrotask(this._executeVoiceUpdate)
  }

  _executeVoiceUpdate () {
    if (this._destroyed) return

    this._stateFlags &= ~STATE_FLAGS.UPDATE_SCHEDULED
    const pending = this._pendingUpdate
    if (!pending) return

    if (Date.now() - pending.timestamp > UPDATE_TIMEOUT) {
      sharedPool.release(pending.payload)
      this._pendingUpdate = null
      return
    }

    const payload = pending.payload
    this._pendingUpdate = null
    this._sendUpdate(payload).finally(() => sharedPool.release(payload))
  }

  async _sendUpdate (payload) {
    if (this._destroyed) throw new Error('Connection destroyed')
    if (!this._rest) throw new Error('REST interface unavailable')

    try {
      await this._rest.updatePlayer(payload)
    } catch (error) {
      if (!helpers.isNetworkError(error)) {
        this._aqua.emit(AqualinkEvents.Debug, new Error(`Voice update failed: ${error?.message || error}`))
      }
      throw error
    }
  }

  destroy () {
    if (this._destroyed) return

    this._destroyed = true
    this._clearPendingUpdate()

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }

    this._player = null
    this._aqua = null
    this._rest = null

    this.voiceChannel = null
    this.sessionId = null
    this.endpoint = null
    this.token = null
    this.region = null
    this._lastEndpoint = null

    this._stateFlags = 0
    this.sequence = 0
    this._reconnectAttempts = 0
    this._consecutiveFailures = 0
    this._lastVoiceDataUpdate = 0
  }
}

module.exports = Connection
