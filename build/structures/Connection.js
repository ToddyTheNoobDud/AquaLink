'use strict'

const { AqualinkEvents } = require('./AqualinkEvents')

const POOL_SIZE = 12
const UPDATE_TIMEOUT = 4000
const RECONNECT_DELAY = 1000
const MAX_RECONNECT_ATTEMPTS = 3
const RESUME_BACKOFF_MAX = 8000
const VOICE_DATA_TIMEOUT = 30000

const STATE = {
  CONNECTED: 1,
  UPDATE_SCHEDULED: 64,
  DISCONNECTING: 128,
  ATTEMPTING_RESUME: 256,
  VOICE_DATA_STALE: 512
}

const ENDPOINT_REGION_REGEX = /^([a-z-]+)\d*/i

const _functions = {
  safeUnref(timer) {
    if (timer && typeof timer.unref === 'function') timer.unref()
  },
  isValidNumber(num) {
    return typeof num === 'number' && num >= 0 && Number.isFinite(num)
  },
  isNetworkError(err) {
    return err && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT')
  },
  extractRegion(endpoint) {
    const m = ENDPOINT_REGION_REGEX.exec(endpoint)
    return m ? m[1] : 'unknown'
  }
}

class PayloadPool {
  constructor() {
    this._pool = []
    this._size = 0
  }

  _create() {
    return {
      guildId: null,
      data: {
        voice: { token: null, endpoint: null, sessionId: null, resume: undefined, sequence: undefined },
        volume: null
      }
    }
  }

  acquire() {
    return this._size > 0 ? this._pool[--this._size] : this._create()
  }

  release(payload) {
    if (!payload || this._size >= POOL_SIZE) return
    payload.guildId = null
    const v = payload.data.voice
    v.token = v.endpoint = v.sessionId = null
    v.resume = v.sequence = undefined
    payload.data.volume = null
    this._pool[this._size++] = payload
  }

  destroy() {
    this._pool.length = 0
    this._size = 0
  }
}

const sharedPool = new PayloadPool()

class Connection {
  constructor(player) {
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
  }

  _hasValidVoiceData() {
    if (!this.sessionId || !this.endpoint || !this.token) return false
    if (Date.now() - this._lastVoiceDataUpdate > VOICE_DATA_TIMEOUT) {
      this._stateFlags |= STATE.VOICE_DATA_STALE
      return false
    }
    return true
  }

  _canAttemptResume() {
    if (this._destroyed || this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return false
    if (this._stateFlags & (STATE.ATTEMPTING_RESUME | STATE.DISCONNECTING)) return false
    return this._hasValidVoiceData() || !!this._player?._resuming
  }

  setServerUpdate(data) {
    if (this._destroyed || !data?.endpoint || !data.token) return
    const endpoint = typeof data.endpoint === 'string' && data.endpoint.trim()
    if (!endpoint || typeof data.token !== 'string' || !data.token) return
    if (this._lastEndpoint === endpoint && this.token === data.token) return

    const newRegion = _functions.extractRegion(endpoint)
    if (this._lastEndpoint !== endpoint) {
      this.sequence = 0
      this._lastEndpoint = endpoint
      this._reconnectAttempts = 0
      this._consecutiveFailures = 0
    }
    this.endpoint = endpoint
    this.region = newRegion
    this.token = data.token
    this._lastVoiceDataUpdate = Date.now()
    this._stateFlags &= ~STATE.VOICE_DATA_STALE

    if (this._player.paused) this._player.pause(false)
    this._scheduleVoiceUpdate()
  }

  resendVoiceUpdate() {
    if (this._destroyed || !this._hasValidVoiceData()) return false
    this._scheduleVoiceUpdate()
    return true
  }

  setStateUpdate(data) {
    if (this._destroyed || !data || data.user_id !== this._clientId) return

    const { session_id: sessionId, channel_id: channelId, self_deaf: selfDeaf, self_mute: selfMute } = data

    if (channelId) {
      let needsUpdate = false

      if (this.voiceChannel !== channelId) {
        this._aqua.emit(AqualinkEvents.PlayerMove, this.voiceChannel, channelId)
        this.voiceChannel = channelId
        this._player.voiceChannel = channelId
        needsUpdate = true
      }

      if (this.sessionId !== sessionId) {
        this.sessionId = sessionId
        this._lastVoiceDataUpdate = Date.now()
        this._stateFlags &= ~STATE.VOICE_DATA_STALE
        this._reconnectAttempts = 0
        this._consecutiveFailures = 0
        needsUpdate = true
      }

      this._player.connection.sessionId = sessionId || this._player.connection.sessionId
      this._player.self_deaf = this._player.selfDeaf = !!selfDeaf
      this._player.self_mute = this._player.selfMute = !!selfMute
      this._player.connected = true
      this._stateFlags |= STATE.CONNECTED

      if (needsUpdate) this._scheduleVoiceUpdate()
    } else {
      this._handleDisconnect()
    }
  }

  _handleDisconnect() {
    if (this._destroyed || !(this._stateFlags & STATE.CONNECTED)) return

    this._stateFlags = (this._stateFlags | STATE.DISCONNECTING) & ~STATE.CONNECTED
    this._player.connected = false
    this._clearPendingUpdate()
    this._clearReconnectTimer()

    this.voiceChannel = this.sessionId = null
    this.sequence = this._lastVoiceDataUpdate = 0
    this._stateFlags |= STATE.VOICE_DATA_STALE

    try {
      if (typeof this._player.destroy === 'function') this._player.destroy()
    } catch (e) {
      this._aqua.emit(AqualinkEvents.Debug, new Error(`Player destroy failed: ${e?.message || e}`))
    } finally {
      this._stateFlags &= ~STATE.DISCONNECTING
    }
  }

  _requestVoiceState() {
    try {
      if (typeof this._player?.send === 'function' && this._player.voiceChannel) {
        this._player.send({
          guild_id: this._guildId,
          channel_id: this._player.voiceChannel,
          self_deaf: this._player.deaf,
          self_mute: this._player.mute
        })
        this._reconnectTimer = setTimeout(() => this._handleReconnect(), 1500)
        _functions.safeUnref(this._reconnectTimer)
        return true
      }
    } catch (_) {}
    return false
  }

  async attemptResume() {
    if (!this._canAttemptResume()) {
      this._aqua.emit(
        AqualinkEvents.Debug,
        `Resume blocked: destroyed=${this._destroyed}, hasValidData=${this._hasValidVoiceData()}, attempts=${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`
      )

      const isResuming = this._player?._resuming
      const isStale = this._stateFlags & STATE.VOICE_DATA_STALE
      const needsVoiceData = !this.sessionId || !this.endpoint || !this.token

      if ((isStale || needsVoiceData) && isResuming) {
        this._aqua.emit(AqualinkEvents.Debug, `Requesting fresh voice state for guild ${this._guildId}`)
        this._requestVoiceState()
      } else if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        this._handleDisconnect()
      }
      return false
    }

    if ((!this.sessionId || !this.endpoint || !this.token) && this._player?._resuming) {
      this._aqua.emit(AqualinkEvents.Debug, `Resuming player but voice data missing for guild ${this._guildId}`)
      this._requestVoiceState()
      return false
    }

    this._stateFlags |= STATE.ATTEMPTING_RESUME
    this._reconnectAttempts++
    this._aqua.emit(AqualinkEvents.Debug, `Attempt resume: guild=${this._guildId} endpoint=${this.endpoint} session=${this.sessionId}`)

    const payload = sharedPool.acquire()
    try {
      payload.guildId = this._guildId
      const v = payload.data.voice
      v.token = this.token
      v.endpoint = this.endpoint
      v.sessionId = this.sessionId
      v.resume = true
      v.sequence = this.sequence
      payload.data.volume = this._player?.volume ?? 100

      await this._sendUpdate(payload)
      this._reconnectAttempts = this._consecutiveFailures = 0
      if (this._player) this._player._resuming = false
      this._aqua.emit(AqualinkEvents.Debug, `Resume successful for guild ${this._guildId}`)
      return true
    } catch (e) {
      this._consecutiveFailures++
      this._aqua.emit(AqualinkEvents.Debug, `Resume failed for guild ${this._guildId}: ${e?.message || e}`)

      if (this._reconnectAttempts < MAX_RECONNECT_ATTEMPTS && !this._destroyed && this._consecutiveFailures < 5) {
        const delay = Math.min(RECONNECT_DELAY * (1 << (this._reconnectAttempts - 1)), RESUME_BACKOFF_MAX)
        this._reconnectTimer = setTimeout(() => this._handleReconnect(), delay)
        _functions.safeUnref(this._reconnectTimer)
      } else {
        this._aqua.emit(AqualinkEvents.Debug, `Max reconnect attempts or failures reached for guild ${this._guildId}`)
        if (this._player) this._player._resuming = false
        this._handleDisconnect()
      }
      return false
    } finally {
      this._stateFlags &= ~STATE.ATTEMPTING_RESUME
      sharedPool.release(payload)
    }
  }

  _handleReconnect() {
    this._reconnectTimer = null
    if (!this._destroyed) this.attemptResume()
  }

  updateSequence(seq) {
    if (_functions.isValidNumber(seq) && seq > this.sequence) this.sequence = seq
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
  }

  _clearPendingUpdate() {
    this._stateFlags &= ~STATE.UPDATE_SCHEDULED
    if (this._pendingUpdate?.payload) sharedPool.release(this._pendingUpdate.payload)
    this._pendingUpdate = null
  }

  _scheduleVoiceUpdate() {
    if (this._destroyed || !this._hasValidVoiceData() || (this._stateFlags & STATE.UPDATE_SCHEDULED)) return

    this._clearPendingUpdate()
    const payload = sharedPool.acquire()
    payload.guildId = this._guildId
    const v = payload.data.voice
    v.token = this.token
    v.endpoint = this.endpoint
    v.sessionId = this.sessionId
    v.resume = v.sequence = undefined
    payload.data.volume = this._player.volume

    this._pendingUpdate = { payload, timestamp: Date.now() }
    this._stateFlags |= STATE.UPDATE_SCHEDULED
    queueMicrotask(() => this._executeVoiceUpdate())
  }

  _executeVoiceUpdate() {
    if (this._destroyed) return
    this._stateFlags &= ~STATE.UPDATE_SCHEDULED

    const pending = this._pendingUpdate
    if (!pending) return
    this._pendingUpdate = null

    if (Date.now() - pending.timestamp > UPDATE_TIMEOUT) {
      sharedPool.release(pending.payload)
      return
    }

    const payload = pending.payload
    this._sendUpdate(payload).finally(() => sharedPool.release(payload))
  }

  async _sendUpdate(payload) {
    if (this._destroyed) throw new Error('Connection destroyed')
    if (!this._rest) throw new Error('REST interface unavailable')

    try {
      await this._rest.updatePlayer(payload)
    } catch (e) {
      if (!_functions.isNetworkError(e)) {
        this._aqua.emit(AqualinkEvents.Debug, new Error(`Voice update failed: ${e?.message || e}`))
      }
      throw e
    }
  }

  destroy() {
    if (this._destroyed) return
    this._destroyed = true

    this._clearPendingUpdate()
    this._clearReconnectTimer()

    this._player = this._aqua = this._rest = null
    this.voiceChannel = this.sessionId = this.endpoint = this.token = this.region = this._lastEndpoint = null
    this._stateFlags = this.sequence = this._reconnectAttempts = this._consecutiveFailures = this._lastVoiceDataUpdate = 0
  }
}

module.exports = Connection
