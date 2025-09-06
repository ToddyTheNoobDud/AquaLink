'use strict'

const WebSocket = require('ws')
const Rest = require('./Rest')

const WS_STATES = Object.freeze({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
const FATAL_CLOSE_CODES = new Set([4003, 4004, 4010, 4011, 4012, 4015])

const WS_PATH = '/v4/websocket'
const OPEN_BRACE = 123
const LYRICS_PREFIX = 'Lyrics'
const LYRICS_PREFIX_LEN = LYRICS_PREFIX.length

const _functions = Object.freeze({
  buildWsUrl(host, port, ssl) {
    const needsBrackets = host.includes(':') && !host.startsWith('[') && !host.endsWith(']')
    const h = needsBrackets ? `[${host}]` : host
    return `ws${ssl ? 's' : ''}://${h}:${port}${WS_PATH}`
  },
  dataToStringIfJson(data, isBinary) {
    if (isBinary) return null
    if (typeof data === 'string') return data.length > 0 && data.charCodeAt(0) === OPEN_BRACE ? data : null
    if (Buffer.isBuffer(data)) {
      if (data.length === 0 || data[0] !== OPEN_BRACE) return null
      try { return data.toString('utf8') } catch { return null }
    }
    return null
  },
  tryParseJson(str) {
    try { return { ok: true, value: JSON.parse(str) } } catch (err) { return { ok: false, err } }
  },
  isLyricsOp(op) {
    return typeof op === 'string' && op.length >= LYRICS_PREFIX_LEN && op.startsWith(LYRICS_PREFIX)
  },
  reasonToString(reason) {
    if (!reason) return 'No reason provided'
    if (typeof reason === 'string') return reason
    if (Buffer.isBuffer(reason)) {
      try { return reason.toString('utf8') } catch { return String(reason) }
    }
    return String(reason)
  },
  assignIfPresent(target, src, keys) {
    for (const k of keys) if (src[k] !== undefined) target[k] = src[k]
  }
})

class Node {
  static BACKOFF_MULTIPLIER = 1.5
  static MAX_BACKOFF = 60_000
  static DEFAULT_RECONNECT_TIMEOUT = 2_000
  static DEFAULT_RESUME_TIMEOUT = 60
  static JITTER_MAX = 2_000
  static JITTER_FACTOR = 0.2
  static WS_CLOSE_NORMAL = 1000
  static DEFAULT_MAX_PAYLOAD = 1_048_576
  static DEFAULT_HANDSHAKE_TIMEOUT = 15_000

  constructor(aqua, connOptions, options = {}) {
    this.aqua = aqua

    this.host = connOptions.host || 'localhost'
    this.name = connOptions.name || this.host
    this.port = connOptions.port || 2333
    this.auth = connOptions.auth || 'youshallnotpass'
    this.sessionId = connOptions.sessionId || null
    this.regions = connOptions.regions || []
    this.ssl = !!connOptions.ssl

    this.wsUrl = _functions.buildWsUrl(this.host, this.port, this.ssl)

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

    this.stats = {
      players: 0,
      playingPlayers: 0,
      uptime: 0,
      ping: 0,
      memory: { free: 0, used: 0, allocated: 0, reservable: 0 },
      cpu: { cores: 0, systemLoad: 0, lavalinkLoad: 0 },
      frameStats: { sent: 0, nulled: 0, deficit: 0 }
    }

    this._clientName = `Aqua/${this.aqua.version} https://github.com/ToddyTheNoobDud/AquaLink`
    this._headers = this._buildHeaders()

    this._boundHandlers = Object.freeze({
      open: this._handleOpen.bind(this),
      error: this._handleError.bind(this),
      message: this._handleMessage.bind(this),
      close: this._handleClose.bind(this),
      connect: this.connect.bind(this)
    })
  }

  _buildHeaders() {
    const headers = Object.create(null)
    headers.Authorization = this.auth
    headers['User-Id'] = this.aqua.clientId
    headers['Client-Name'] = this._clientName
    if (this.sessionId) headers['Session-Id'] = this.sessionId
    return headers
  }

  async _handleOpen() {
    this.connected = true
    this._isConnecting = false
    this.reconnectAttempted = 0
    this._emitDebug('WebSocket connection established')

    if (!this.aqua?.bypassChecks?.nodeFetchInfo && !this.info) {
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
    const err = error instanceof Error ? error : new Error(String(error))
    this.aqua.emit('nodeError', this, err)
  }

  _handleMessage(data, isBinary) {
    const str = _functions.dataToStringIfJson(data, isBinary)
    if (!str) {
      this._emitDebug('Ignored non-JSON or invalid message frame')
      return
    }

    const parsed = _functions.tryParseJson(str)
    if (!parsed.ok) {
      this._emitDebug(() => `JSON parse failed: ${parsed.err && parsed.err.message ? parsed.err.message : 'Unknown error'}`)
      return
    }

    const payload = parsed.value
    const op = payload && payload.op
    if (!op) return

    switch (op) {
      case 'stats':
        this._updateStats(payload)
        break
      case 'ready':
        this._handleReady(payload)
        break
      case 'playerUpdate':
        this._emitToPlayer('playerUpdate', payload)
        break
      case 'event':
        this._emitToPlayer('event', payload)
        break
      default:
        this._handleCustomStringOp(op, payload)
    }
  }

  _emitToPlayer(eventName, payload) {
    const guildId = payload && payload.guildId
    if (!guildId) return
    const player = this.aqua?.players?.get?.(guildId)
    if (player && typeof player.emit === 'function') player.emit(eventName, payload)
  }

  _handleCustomStringOp(op, payload) {
    if (_functions.isLyricsOp(op)) {
      const player = payload.guildId ? this.aqua?.players?.get?.(payload.guildId) : null
      this.aqua.emit(op, player, payload.track || null, payload)
      return
    }

    this.aqua.emit('nodeCustomOp', this, op, payload)
    this._emitDebug(() => `Unknown string op from Lavalink: ${op}`)
  }

  _handleClose(code, reason) {
    this.connected = false
    this._isConnecting = false

    const reasonStr = _functions.reasonToString(reason)
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
      const backoffTime = 10_000
      this.aqua.emit('nodeReconnect', this, { infinite: true, attempt, backoffTime })
      this.reconnectTimeoutId = setTimeout(this._boundHandlers.connect, backoffTime)
      this.reconnectTimeoutId.unref?.()
      return
    }

    if (this.reconnectAttempted >= this.reconnectTries) {
      this._emitError(new Error(`Max reconnection attempts reached (${this.reconnectTries})`))
      this.destroy(true)
      return
    }

    const attempt = ++this.reconnectAttempted
    const backoffTime = this._calcBackoff(attempt)

    this.aqua.emit('nodeReconnect', this, { infinite: false, attempt, backoffTime })

    this.reconnectTimeoutId = setTimeout(this._boundHandlers.connect, backoffTime)
    this.reconnectTimeoutId.unref?.()
  }

  _calcBackoff(attempt) {
    const exp = Math.min(attempt, 10)
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
      const state = ws.readyState
      if (state === WS_STATES.OPEN) {
        ws.close(Node.WS_CLOSE_NORMAL)
      } else {
        ws.terminate?.()
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

    _functions.assignIfPresent(s, payload, ['players', 'playingPlayers', 'uptime', 'ping'])

    if (payload.memory) {
      const m = s.memory
      _functions.assignIfPresent(m, payload.memory, ['free', 'used', 'allocated', 'reservable'])
    }

    if (payload.cpu) {
      const c = s.cpu
      _functions.assignIfPresent(c, payload.cpu, ['cores', 'systemLoad', 'lavalinkLoad'])
    }

    if (payload.frameStats) {
      const f = s.frameStats
      _functions.assignIfPresent(f, payload.frameStats, ['sent', 'nulled', 'deficit'])
    }
  }

  async _handleReady(payload) {
    const sessionId = payload && payload.sessionId
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
        this._emitError(`_resumePlayers failed: ${err?.message || err}`)
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
      if (this.aqua.loadPlayers) await this.aqua.loadPlayers()
      this._emitDebug('Session resumed successfully')
    } catch (err) {
      this._emitError(`Failed to resume session: ${err?.message || err}`)
      throw err
    }
  }

  _emitError(error) {
    const errorObj = error instanceof Error ? error : new Error(String(error))
    this.aqua.emit('error', this, errorObj)
  }

  _emitDebug(message) {
    if ((this.aqua?.listenerCount?.('debug') || 0) === 0) return
    const out = typeof message === 'function' ? message() : message
    this.aqua.emit('debug', this.name, out)
  }
}


module.exports = Node
