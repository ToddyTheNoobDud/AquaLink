'use strict'

const { AqualinkEvents } = require('./AqualinkEvents')

const POOL_SIZE = 12
const LISTENER_CHECK_INTERVAL = 4000
const UPDATE_TIMEOUT = 4000
const RECONNECT_DELAY = 1000
const MAX_RECONNECT_ATTEMPTS = 3

const STATE_FLAGS = {
  CONNECTED: 1,
  PAUSED: 2,
  SELF_DEAF: 4,
  SELF_MUTE: 8,
  HAS_DEBUG: 16,
  HAS_MOVE: 32,
  UPDATE_SCHEDULED: 64,
  DISCONNECTING: 128
}

const ENDPOINT_REGION_REGEX = /^([a-z-]+)(?:\d+)?/i

const _functions = {
  safeUnref: (timer) => timer?.unref?.(),
  isValidString: (str) => typeof str === 'string' && str.length > 0,
  isValidNumber: (num) => typeof num === 'number' && num >= 0 && Number.isFinite(num),
  resetVoicePayload: (voice) => {
    voice.token = voice.endpoint = voice.sessionId = null
    voice.resume = voice.sequence = undefined
  }
}

class OptimizedPayloadPool {
  constructor() {
    this.pool = new Array(POOL_SIZE);
    this.size = POOL_SIZE;
    for (let i = 0; i < POOL_SIZE; i++) {
      this.pool[i] = this._createPayload();
    }
  }

  _createPayload() {
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
    };
  }

  acquire() {
    return this.size > 0 ? this.pool[--this.size] : this._createPayload();
  }

  release(payload) {
    if (!payload || this.size >= POOL_SIZE) return;

    payload.guildId = null;
    const voice = payload.data.voice;
    voice.token = null;
    voice.endpoint = null;
    voice.sessionId = null;
    voice.resume = undefined;
    voice.sequence = undefined;
    payload.data.volume = null;

    this.pool[this.size++] = payload;
  }

  destroy() {
    for (let i = 0; i < this.size; i++) {
      this.pool[i] = null;
    }
    this.pool = null;
    this.size = 0;
  }
}
const sharedPool = new OptimizedPayloadPool()

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
    this._lastListenerCheck = 0
    this._reconnectAttempts = 0
    this._destroyed = false
    this._reconnectTimer = null

    this._executeVoiceUpdate = this._executeVoiceUpdate.bind(this)
    this._handleReconnect = this._handleReconnect.bind(this)
  }

  setServerUpdate(data) {
    if (this._destroyed || !data?.endpoint || !data.token ||
        !_functions.isValidString(data.endpoint) || !_functions.isValidString(data.token)) return

    const endpoint = data.endpoint.trim()
    if (this._lastEndpoint === endpoint && this.token === data.token) return

    const match = ENDPOINT_REGION_REGEX.exec(endpoint)
    const newRegion = match ? match[1] : 'unknown'
    const regionChanged = this.region !== newRegion
    const endpointChanged = this._lastEndpoint !== endpoint

    if (regionChanged || endpointChanged) {
      if (endpointChanged) {
        this.sequence = 0
        this._lastEndpoint = endpoint
        this._reconnectAttempts = 0
      }
      this.endpoint = endpoint
      this.region = newRegion
    }

    this.token = data.token
    if (this._player.paused) this._player.pause(false)
    this._scheduleVoiceUpdate()
  }

  resendVoiceUpdate() {
    if (this._destroyed || !(this.sessionId && this.endpoint && this.token)) return false
    this._scheduleVoiceUpdate()
    return true
  }

  setStateUpdate(data) {
    if (this._destroyed || !data || data.user_id !== this._clientId) return

    const {session_id, channel_id, self_deaf, self_mute} = data

    if (channel_id) {
      let needsUpdate = false

      if (this.voiceChannel !== channel_id) {
        if (this._stateFlags & STATE_FLAGS.HAS_MOVE) {
          this._aqua.emit(AqualinkEvents.PlayerMove, this.voiceChannel, channel_id)
        }
        this.voiceChannel = channel_id
        this._player.voiceChannel = channel_id
        needsUpdate = true
      }

      if (this.sessionId !== session_id) {
        this.sessionId = session_id
        needsUpdate = true
        this._reconnectAttempts = 0
      }

      this._player.self_deaf = !!self_deaf
      this._player.self_mute = !!self_mute
      this._player.connected = true
      this._stateFlags |= STATE_FLAGS.CONNECTED

      if (needsUpdate) this._scheduleVoiceUpdate()
    } else {
      this._handleDisconnect()
    }
  }

  _handleDisconnect() {
    if (this._destroyed || !(this._stateFlags & STATE_FLAGS.CONNECTED)) return

    this._stateFlags = (this._stateFlags | STATE_FLAGS.DISCONNECTING) & ~STATE_FLAGS.CONNECTED
    this._player.connected = false
    this._clearPendingUpdate()

    this.voiceChannel = null
    this.sessionId = null
    this.sequence = 0

    try {
      if (typeof this._player.destroy === 'function') this._player.destroy()
    } catch (error) {
      this._aqua.emit(AqualinkEvents.Debug, new Error(`Player destroy failed: ${error.message}`))
    } finally {
      this._stateFlags &= ~STATE_FLAGS.DISCONNECTING
    }
  }

  async attemptResume() {
    this._aqua.emit(AqualinkEvents.Debug, `Attempt voice: G: ${this._guildId} E: ${this.endpoint} T: ${this.token} S: ${this.sessionId}`)
    // if we have SessionID and guild id, but does  not have endpoint and token, try rebuilding the connection

    if (this._destroyed || !this.sessionId || this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return false

    this._reconnectAttempts++
    const payload = sharedPool.acquire()

    try {
      payload.guildId = this._guildId
      const voice = payload.data.voice
      voice.token = this.token
      voice.endpoint = this.endpoint
      voice.sessionId = this.sessionId
      voice.resume = !!(this.endpoint && this.token)
      voice.sequence = this.sequence
      payload.data.volume = this._player?.volume ?? 100

      await this._sendUpdate(payload)
      this._reconnectAttempts = 0
      return true
    } catch (error) {
      if (this._reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = RECONNECT_DELAY * Math.pow(2, this._reconnectAttempts - 1)
        this._reconnectTimer = setTimeout(this._handleReconnect, delay)
        _functions.safeUnref(this._reconnectTimer)
      }
      return false
    } finally {
      sharedPool.release(payload)
    }
  }

  _handleReconnect() {
    if (!this._destroyed) this.attemptResume()
  }

  updateSequence(seq) {
    if (_functions.isValidNumber(seq)) {
      this.sequence = Math.max(seq, this.sequence)
    }
  }

  _clearPendingUpdate() {
    this._stateFlags &= ~STATE_FLAGS.UPDATE_SCHEDULED
    if (this._pendingUpdate?.payload) {
      sharedPool.release(this._pendingUpdate.payload)
    }
    this._pendingUpdate = null
  }

  _scheduleVoiceUpdate() {
    if (this._destroyed || !(this.sessionId && this.endpoint && this.token) ||
        (this._stateFlags & STATE_FLAGS.UPDATE_SCHEDULED)) return

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

    this._pendingUpdate = {payload, timestamp: Date.now()}
    this._stateFlags |= STATE_FLAGS.UPDATE_SCHEDULED
    queueMicrotask(this._executeVoiceUpdate)
  }

  _executeVoiceUpdate() {
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

  async _sendUpdate(payload) {
    if (this._destroyed) throw new Error('Connection destroyed')
    if (!this._rest) throw new Error('REST interface unavailable')

    try {
      await this._rest.updatePlayer(payload)
    } catch (error) {
      const isNetworkError = error.code === 'ECONNREFUSED' ||
                            error.code === 'ENOTFOUND' ||
                            error.code === 'ETIMEDOUT'
      if (!isNetworkError) {
        this._aqua.emit(AqualinkEvents.Debug, new Error(`Voice update failed: ${error.message}`))
      }
      throw error
    }
  }

  destroy() {
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
  }
}

module.exports = Connection
