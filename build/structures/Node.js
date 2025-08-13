'use strict'

const WebSocket = require('ws')
const Rest = require('./Rest')

const WS_STATES = Object.freeze({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
const FATAL_CLOSE_CODES = new Set([4003, 4004, 4010, 4011, 4012, 4015])
const OPEN_BRACE = 123

class Node {
  static BACKOFF_MULTIPLIER = 1.5
  static MAX_BACKOFF = 60000
  static DEFAULT_RECONNECT_TIMEOUT = 2000
  static DEFAULT_RESUME_TIMEOUT = 60
  static JITTER_MAX = 2000
  static JITTER_FACTOR = 0.2
  static WS_CLOSE_NORMAL = 1000
  static DEFAULT_MAX_PAYLOAD = 1048576
  static DEFAULT_HANDSHAKE_TIMEOUT = 15000

  constructor(aqua, connOptions, options = {}) {
    this.aqua = aqua
    this.host = connOptions.host || 'localhost'
    this.name = connOptions.name || this.host
    this.port = connOptions.port || 2333
    this.password = connOptions.password || 'youshallnotpass'
    this.sessionId = connOptions.sessionId || null
    this.regions = connOptions.regions || []
    this.secure = !!connOptions.secure

    this.wsUrl = `ws${this.secure ? 's' : ''}://${this.host}:${this.port}/v4/websocket`

    this.rest = new Rest(aqua, this)
    this.resumeTimeout = options.resumeTimeout ?? Node.DEFAULT_RESUME_TIMEOUT
    this.autoResume = options.autoResume ?? false
    this.reconnectTimeout = options.reconnectTimeout ?? Node.DEFAULT_RECONNECT_TIMEOUT
    this.reconnectTries = options.reconnectTries ?? 3
    this.infiniteReconnects = options.infiniteReconnects ?? false
    this.timeout = options.timeout ?? Node.DEFAULT_HANDSHAKE_TIMEOUT
    this.maxPayload = options.maxPayload ?? Node.DEFAULT_MAX_PAYLOAD
    this.skipUTF8Validation = options.skipUTF8Validation ?? true

    this.connected = false
    this.info = null
    this.ws = null
    this.reconnectAttempted = 0
    this.reconnectTimeoutId = null
    this.isDestroyed = false
    this._isConnecting = false

    this.stats = Object.create(null)
    this._resetStats()

    this._headers = this._buildHeaders()

    this._boundHandlers = Object.freeze({
      open: this._handleOpen.bind(this),
      error: this._handleError.bind(this),
      message: this._handleMessage.bind(this),
      close: this._handleClose.bind(this),
      connect: this.connect.bind(this)
    })

    this._debugEnabled = false
    this._checkDebugStatus()
  }

  _resetStats() {
    const s = this.stats
    s.players = 0
    s.playingPlayers = 0
    s.uptime = 0
    s.ping = 0
    s.memory = { free: 0, used: 0, allocated: 0, reservable: 0 }
    s.cpu = { cores: 0, systemLoad: 0, lavalinkLoad: 0 }
    s.frameStats = { sent: 0, nulled: 0, deficit: 0 }
  }

  _buildHeaders() {
    const headers = Object.create(null)
    headers.Authorization = this.password
    headers['User-Id'] = this.aqua.clientId
    headers['Client-Name'] = `Aqua/${this.aqua.version} https://github.com/ToddyTheNoobDud/AquaLink`
    if (this.sessionId) headers['Session-Id'] = this.sessionId
    return headers
  }

  async _handleOpen() {
    this.connected = true
    this._isConnecting = false
    this.reconnectAttempted = 0
    this._emitDebug('WebSocket connection established')

    if (!this.aqua?.bypassChecks?.nodeFetchInfo) {
      this.rest.makeRequest('GET', '/v4/info')
        .then(info => { this.info = info })
        .catch(err => {
          this.info = null
          this._emitError(`Failed to fetch node info: ${err?.message || err}`)
        })
    }

    this.aqua.emit('nodeConnected', this)
  }

  _handleError(error) {
    this._isConnecting = false
    const err = error instanceof Error ? error : new Error(String(error))
    this.aqua.emit('nodeError', this, err)
  }

  _handleMessage(data, isBinary) {
    if (isBinary) return

    let str
    if (typeof data === 'string') {
      str = data
    } else if (Buffer.isBuffer(data)) {
      if (data.length === 0 || data[0] !== OPEN_BRACE) return
      try {
        str = data.toString('utf8')
      } catch {
        this._emitDebug('Failed to decode message buffer')
        return
      }
    } else {
      return
    }

    if (!str || str.charCodeAt(0) !== OPEN_BRACE) return

    let payload
    try {
      payload = JSON.parse(str)
    } catch {
      this._emitDebug(() => `JSON parse failed: ${str.slice(0, 100)}...`)
      return
    }

    const op = payload?.op
    if (!op) return

    switch (op) {
      case 'stats':
        this._updateStats(payload)
        break
      case 'ready':
        this._handleReady(payload)
        break
      case 2:
      case 5:
      case 9:
        this._handleNumericOp(op, payload.guildId, payload)
        break
      default:
        if (typeof op === 'string') {
          this._handleStringOp(op, payload)
        }
    }
  }

  _handleStringOp(op, payload) {
    if (op.charCodeAt(0) === 76 && op.startsWith('Lyrics')) {
      const player = payload.guildId ? this.aqua.players.get(payload.guildId) : null
      this.aqua.emit(op, player, payload.track || null, payload)
      return
    }

    if (payload.guildId) {
      const player = this.aqua.players.get(payload.guildId)
      if (player) player.emit(op, payload)
    }
  }

  _handleNumericOp(op, guildId, payload) {
    if (!guildId) return

    const player = this.aqua.players.get(guildId)
    if (!player?.connection) return

    switch (op) {
      case 2:
        player.connection.setServerUpdate(payload.d)
        break
      case 5:
        if (payload.d?.sequence !== undefined) {
          player.connection.updateSequence(payload.d.sequence)
        }
        break
      case 9:
        this._emitDebug(`[Player ${guildId}] Voice resumed successfully`)
        break
    }
  }

  _handleClose(code, reason) {
    this.connected = false
    this._isConnecting = false

    let reasonStr = 'No reason provided'
    if (reason) {
      reasonStr = typeof reason === 'string' ? reason :
                  reason.toString ? reason.toString() : String(reason)
    }

    this.aqua.emit('nodeDisconnect', this, { code, reason: reasonStr })

    if (this.isDestroyed) return

    if (!this._shouldReconnect(code)) {
      if (code === 4011) {
        this.sessionId = null
        delete this._headers['Session-Id']
      }
      this._emitError(new Error(`WebSocket closed (code ${code}). Not reconnecting.`))
      this.destroy(true)
      return
    }
    this.aqua.handleNodeFailover?.(this)
    this._scheduleReconnect()
  }

  _shouldReconnect(code) {
    return code !== Node.WS_CLOSE_NORMAL && !FATAL_CLOSE_CODES.has(code)
  }

  _scheduleReconnect() {
    this._clearReconnectTimeout()

    if (this.infiniteReconnects) {
      const attempt = ++this.reconnectAttempted
      this.aqua.emit('nodeReconnect', this, { infinite: true, attempt, backoffTime: 10000 })
      this.reconnectTimeoutId = setTimeout(this._boundHandlers.connect, 10000)
      return
    }

    if (this.reconnectAttempted >= this.reconnectTries) {
      this._emitError(new Error(`Max reconnection attempts reached (${this.reconnectTries})`))
      this.destroy(true)
      return
    }

    const backoffTime = this._calcBackoff()
    const attempt = ++this.reconnectAttempted

    this.aqua.emit('nodeReconnect', this, {
      infinite: false,
      attempt,
      backoffTime
    })

    this.reconnectTimeoutId = setTimeout(this._boundHandlers.connect, backoffTime)
  }

  _calcBackoff() {
    const exp = Math.min(this.reconnectAttempted, 10)
    const baseBackoff = this.reconnectTimeout * Math.pow(Node.BACKOFF_MULTIPLIER, exp)
    const maxJitter = Math.min(Node.JITTER_MAX, baseBackoff * Node.JITTER_FACTOR)
    const jitter = Math.random() * maxJitter
    return Math.min(baseBackoff + jitter, Node.MAX_BACKOFF)
  }

  _clearReconnectTimeout() {
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId)
      this.reconnectTimeoutId = null
    }
  }

  connect() {
    if (this.isDestroyed || this._isConnecting) return

    const currentState = this.ws?.readyState

    if (currentState === WS_STATES.OPEN) {
      this._emitDebug('WebSocket already connected')
      return
    }

    if (currentState === WS_STATES.CONNECTING || currentState === WS_STATES.CLOSING) {
      this._emitDebug('WebSocket is connecting/closing; skipping new connect')
      return
    }

    this._isConnecting = true
    this._cleanup()

    try {
      const ws = new WebSocket(this.wsUrl, {
        headers: this._headers,
        perMessageDeflate: false,
        handshakeTimeout: this.timeout,
        maxPayload: this.maxPayload,
        skipUTF8Validation: this.skipUTF8Validation
      })

      ws.binaryType = 'nodebuffer'

      const h = this._boundHandlers
      ws.once('open', h.open)
      ws.on('error', h.error)
      ws.on('message', h.message)
      ws.once('close', h.close)

      this.ws = ws
    } catch (err) {
      this._isConnecting = false
      this._emitError(`Failed to create WebSocket: ${err?.message || err}`)
      this._scheduleReconnect()
    }
  }

  _cleanup() {
    const ws = this.ws
    if (!ws) return
    ws.removeAllListeners()

    try {
      switch (ws.readyState) {
        case WS_STATES.OPEN:
          ws.close(Node.WS_CLOSE_NORMAL)
          break
        case WS_STATES.CONNECTING:
        case WS_STATES.CLOSING:
          ws.terminate?.()
          break
      }
    } catch (err) {
      this._emitError(`Failed to cleanup WebSocket: ${err?.message || err}`)
    }

    this.ws = null
  }

  destroy(clean = false) {
    if (this.isDestroyed) return

    this.isDestroyed = true
    this._isConnecting = false
    this._clearReconnectTimeout()
    this._cleanup()

    if (!clean) {
      this.aqua.handleNodeFailover?.(this)
    }

    this.connected = false
    this.aqua.destroyNode?.(this.name)
    this.aqua.emit('nodeDestroy', this)

    this.info = null
  }

  async getStats() {
    if (this.connected) return this.stats

    try {
      const newStats = await this.rest.getStats()
      if (newStats) this._updateStats(newStats)
    } catch (err) {
      this._emitError(`Failed to fetch node stats: ${err?.message || err}`)
    }
    return this.stats
  }

  _updateStats(payload) {
    if (!payload) return

    const s = this.stats
    if (payload.players !== undefined) s.players = payload.players
    if (payload.playingPlayers !== undefined) s.playingPlayers = payload.playingPlayers
    if (payload.uptime !== undefined) s.uptime = payload.uptime
    if (payload.ping !== undefined) s.ping = payload.ping

    if (payload.memory) {
      const m = s.memory
      if (payload.memory.free !== undefined) m.free = payload.memory.free
      if (payload.memory.used !== undefined) m.used = payload.memory.used
      if (payload.memory.allocated !== undefined) m.allocated = payload.memory.allocated
      if (payload.memory.reservable !== undefined) m.reservable = payload.memory.reservable
    }

    if (payload.cpu) {
      const c = s.cpu
      if (payload.cpu.cores !== undefined) c.cores = payload.cpu.cores
      if (payload.cpu.systemLoad !== undefined) c.systemLoad = payload.cpu.systemLoad
      if (payload.cpu.lavalinkLoad !== undefined) c.lavalinkLoad = payload.cpu.lavalinkLoad
    }

    if (payload.frameStats) {
      const f = s.frameStats
      if (payload.frameStats.sent !== undefined) f.sent = payload.frameStats.sent
      if (payload.frameStats.nulled !== undefined) f.nulled = payload.frameStats.nulled
      if (payload.frameStats.deficit !== undefined) f.deficit = payload.frameStats.deficit
    }
  }

  async _handleReady(payload) {
    const sessionId = payload?.sessionId
    if (!sessionId) {
      this._emitError('Ready payload missing sessionId')
      return
    }

    this.sessionId = sessionId
    this.rest.setSessionId(sessionId)
    this._headers['Session-Id'] = sessionId

    this.aqua.emit('nodeReady', this, { resumed: !!payload.resumed })
    this.aqua.emit('nodeConnect', this)

    if (this.autoResume) {
      this._resumePlayers().catch(err => {
      })
    }
  }

  async _resumePlayers() {
    if (!this.sessionId) return

    try {
      await this.rest.makeRequest('PATCH', `/v4/sessions/${this.sessionId}`, {
        resuming: true,
        timeout: this.resumeTimeout
      })

      if (this.aqua.loadPlayers) {
        await this.aqua.loadPlayers()
      }

      this._emitDebug('Session resumed successfully')
    } catch (err) {
      this._emitError(`Failed to resume session: ${err?.message || err}`)
      throw err
    }
  }

  _checkDebugStatus() {
    this._debugEnabled = this.aqua?.listenerCount?.('debug') > 0
  }

  _emitError(error) {
    const errorObj = error instanceof Error ? error : new Error(String(error))
    console.error(`[Aqua] [${this.name}] Error:`, errorObj.message)
    this.aqua.emit('error', this, errorObj)
  }

  _emitDebug(message) {
    if (!this._debugEnabled) {
      this._checkDebugStatus()
      if (!this._debugEnabled) return
    }

    const out = typeof message === 'function' ? message() : message
    this.aqua.emit('debug', this.name, out)
  }
}

module.exports = Node
