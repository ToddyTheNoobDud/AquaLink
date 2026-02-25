const IS_BUN = !!(process?.isBun || process?.versions?.bun || globalThis.Bun)
if (process && typeof process.isBun !== 'boolean') process.isBun = IS_BUN

const WebSocketImpl = process.isBun ? globalThis.WebSocket : require('ws')

const Rest = require('./Rest')
const { AqualinkEvents } = require('./AqualinkEvents')

const privateData = new WeakMap()

const NODE_STATE = Object.freeze({
  IDLE: 0,
  CONNECTING: 1,
  READY: 2,
  DISCONNECTING: 3,
  RECONNECTING: 4
})
const WS_STATES = Object.freeze({
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
})
const FATAL_CLOSE_CODES = Object.freeze([4003, 4004, 4010, 4011, 4012, 4015])
const WS_PATH = '/v4/websocket'
const LYRICS_PREFIX = 'Lyrics'
const OPS_STATS = 'stats'
const OPS_READY = 'ready'
const OPS_PLAYER_UPDATE = 'playerUpdate'
const OPS_EVENT = 'event'

const unrefTimer = (t) => {
  try {
    t?.unref?.()
  } catch {}
}

const _functions = {
  buildWsUrl(host, port, ssl) {
    const needsBrackets = host.includes(':') && !host.startsWith('[')
    return `ws${ssl ? 's' : ''}://${needsBrackets ? `[${host}]` : host}:${port}${WS_PATH}`
  },

  isLyricsOp(op) {
    return typeof op === 'string' && op.startsWith(LYRICS_PREFIX)
  },

  reasonToString(reason) {
    if (!reason) return 'No reason provided'
    if (typeof reason === 'string') return reason
    if (Buffer.isBuffer(reason)) {
      try {
        return reason.toString('utf8')
      } catch {
        return String(reason)
      }
    }
    if (reason instanceof ArrayBuffer) {
      try {
        return Buffer.from(reason).toString('utf8')
      } catch {
        return String(reason)
      }
    }
    if (ArrayBuffer.isView(reason)) {
      try {
        return Buffer.from(
          reason.buffer,
          reason.byteOffset,
          reason.byteLength
        ).toString('utf8')
      } catch {
        return String(reason)
      }
    }
    if (typeof reason === 'object')
      return reason.message || reason.code || JSON.stringify(reason)
    return String(reason)
  },

  errMsg(err) {
    return err?.message || String(err)
  }
}

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
  static INFO_FETCH_TIMEOUT = 10000
  static INFINITE_BACKOFF = 10000

  constructor(aqua, connOptions, options = {}) {
    this.aqua = aqua

    this.host = connOptions.host || 'localhost'
    this.name = connOptions.name || this.host
    this.port = connOptions.port || 2333
    this.auth = connOptions.auth || connOptions.password || 'youshallnotpass'
    this.sessionId = connOptions.sessionId || null
    this.regions = connOptions.regions || []
    this.ssl = !!connOptions.ssl || !!connOptions.secure || false
    this.wsUrl = _functions.buildWsUrl(this.host, this.port, this.ssl)

    this.rest = new Rest(aqua, this)

    this.resumeTimeout = options.resumeTimeout ?? Node.DEFAULT_RESUME_TIMEOUT
    this.autoResume = options.autoResume ?? false
    this.reconnectTimeout =
      options.reconnectTimeout ?? Node.DEFAULT_RECONNECT_TIMEOUT
    this.reconnectTries = options.reconnectTries ?? 3
    this.infiniteReconnects = options.infiniteReconnects ?? false
    this.timeout = options.timeout ?? Node.DEFAULT_HANDSHAKE_TIMEOUT
    this.maxPayload = options.maxPayload ?? Node.DEFAULT_MAX_PAYLOAD
    this.skipUTF8Validation = options.skipUTF8Validation ?? true

    this.connected = false
    this.state = NODE_STATE.IDLE
    this.info = null
    this.ws = null
    this.reconnectAttempted = 0
    this.reconnectTimeoutId = null
    this.isDestroyed = false
    this._isConnecting = false
    this.isNodelink = false

    this._wsIsBun = !!process.isBun
    this._bunCleanup = null

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

    privateData.set(this, {
      boundHandlers: {
        open: this._handleOpen.bind(this),
        error: this._handleError.bind(this),
        message: this._handleMessage.bind(this),
        close: this._handleClose.bind(this),
        connect: this.connect.bind(this)
      }
    })
  }

  _buildHeaders() {
    const headers = {
      Authorization: this.auth,
      'User-Id': this.aqua.clientId,
      'Client-Name': this._clientName
    }
    if (this.sessionId) headers['Session-Id'] = this.sessionId
    return headers
  }

  get _boundHandlers() {
    return privateData.get(this)?.boundHandlers
  }

  _clearSession() {
    this.sessionId = null
    delete this._headers['Session-Id']
    this.rest?.setSessionId?.(null)
  }

  _getPlayer(guildId) {
    return guildId ? this.aqua?.players?.get?.(guildId) : null
  }

  async _handleOpen() {
    this.connected = true
    this.state = NODE_STATE.READY
    this._isConnecting = false
    this.reconnectAttempted = 0
    this._emitDebug('WebSocket connection established')
    this.aqua?._trace?.('node.ws.open', {
      node: this.name,
      reconnectAttempted: this.reconnectAttempted
    })

    if (!this.aqua?.bypassChecks?.nodeFetchInfo && !this.info) {
      const timeoutId = setTimeout(() => {
        if (!this.isDestroyed) this._emitError('Node info fetch timeout')
      }, Node.INFO_FETCH_TIMEOUT)
      unrefTimer(timeoutId)

      try {
        this.info = await this.rest.makeRequest('GET', '/v4/info')
        this.isNodelink = !!this.info?.isNodelink
      } catch (err) {
        this.info = null
        this._emitError(`Failed to fetch node info: ${_functions.errMsg(err)}`)
      } finally {
        clearTimeout(timeoutId)
      }
    }

    this.aqua.emit(AqualinkEvents.NodeConnect, this)
  }

  _handleError(error) {
    const err = error instanceof Error ? error : new Error(String(error))
    this.aqua.emit(AqualinkEvents.NodeError, this, err)
  }

  _handleMessage(data, isBinary) {
    if (isBinary) return

    let payload
    try {
      payload = JSON.parse(data)
    } catch (err) {
      this._emitDebug(() => `Invalid JSON from Lavalink: ${err.message}`)
      return
    }

    const op = payload?.op
    if (!op) return

    if (op === OPS_PLAYER_UPDATE)
      this._emitToPlayer(AqualinkEvents.PlayerUpdate, payload)
    else if (op === OPS_EVENT) this._emitToPlayer('event', payload)
    else if (op === OPS_STATS) this._updateStats(payload)
    else if (op === OPS_READY) this._handleReady(payload)
    else this._handleCustomStringOp(op, payload)
  }

  _emitToPlayer(eventName, payload) {
    const player = this._getPlayer(payload?.guildId)
    if (!player?.emit) return
    try {
      player.emit(eventName, payload)
    } catch (err) {
      this._emitError(`Player emit error: ${_functions.errMsg(err)}`)
    }
  }

  _handleCustomStringOp(op, payload) {
    if (_functions.isLyricsOp(op)) {
      this.aqua.emit(
        op,
        this._getPlayer(payload.guildId),
        payload.track || null,
        payload
      )
      return
    }
    this.aqua.emit(AqualinkEvents.NodeCustomOp, this, op, payload)
    this._emitDebug(() => `Unknown op from Lavalink: ${op}`)
  }

  _handleClose(code, reason) {
    this.connected = false
    this.state = this.isDestroyed ? NODE_STATE.IDLE : NODE_STATE.RECONNECTING
    this._isConnecting = false

    this.aqua.emit(AqualinkEvents.NodeDisconnect, this, {
      code,
      reason: _functions.reasonToString(reason)
    })
    this.aqua?._trace?.('node.ws.close', {
      node: this.name,
      code,
      reason: _functions.reasonToString(reason),
      hasSessionId: !!this.sessionId
    })

    if (this.isDestroyed) return

    const isFatal = FATAL_CLOSE_CODES.includes(code)
    if (
      code !== Node.WS_CLOSE_NORMAL &&
      code !== 1001 &&
      !isFatal &&
      this.sessionId
    ) {
      this._clearSession()
    }

    const shouldReconnect =
      (code !== Node.WS_CLOSE_NORMAL || this.infiniteReconnects) && !isFatal

    if (!shouldReconnect) {
      if (code === 4011) this._clearSession()
      this._emitError(
        new Error(`WebSocket closed (code ${code}). Not reconnecting.`)
      )
      this.destroy(true)
      return
    }

    this.aqua.handleNodeFailover?.(this)
    this._scheduleReconnect()
  }

  _scheduleReconnect() {
    this._clearReconnectTimeout()

    const attempt = ++this.reconnectAttempted
    this.aqua?._trace?.('node.ws.reconnect.scheduled', {
      node: this.name,
      attempt,
      infinite: !!this.infiniteReconnects
    })

    if (this.infiniteReconnects) {
      this.aqua.emit(AqualinkEvents.NodeReconnect, this, {
        infinite: true,
        attempt,
        backoffTime: Node.INFINITE_BACKOFF
      })
      this.reconnectTimeoutId = setTimeout(
        this._boundHandlers.connect,
        Node.INFINITE_BACKOFF
      )
      unrefTimer(this.reconnectTimeoutId)
      return
    }

    if (this.reconnectAttempted > this.reconnectTries) {
      this._emitError(
        new Error(`Max reconnection attempts reached (${this.reconnectTries})`)
      )
      this.destroy(true)
      return
    }

    const backoffTime = this._calcBackoff(attempt)
    this.aqua.emit(AqualinkEvents.NodeReconnect, this, {
      infinite: false,
      attempt,
      backoffTime
    })
    this.reconnectTimeoutId = setTimeout(
      this._boundHandlers.connect,
      backoffTime
    )
    unrefTimer(this.reconnectTimeoutId)
  }

  _calcBackoff(attempt) {
    const baseBackoff =
      this.reconnectTimeout * Node.BACKOFF_MULTIPLIER ** Math.min(attempt, 10)
    const maxJitter = Math.min(
      Node.JITTER_MAX,
      baseBackoff * Node.JITTER_FACTOR
    )
    return Math.min(baseBackoff + Math.random() * maxJitter, Node.MAX_BACKOFF)
  }

  _clearReconnectTimeout() {
    if (!this.reconnectTimeoutId) return
    clearTimeout(this.reconnectTimeoutId)
    this.reconnectTimeoutId = null
  }

  connect() {
    if (this.isDestroyed || this._isConnecting) return

    const state = this.ws?.readyState
    if (state === WS_STATES.OPEN) {
      this._emitDebug('WebSocket already connected')
      return
    }
    if (state === WS_STATES.CONNECTING || state === WS_STATES.CLOSING) {
      this._emitDebug('WebSocket is connecting/closing; skipping new connect')
      return
    }

    this._isConnecting = true
    this.state = NODE_STATE.CONNECTING
    this._cleanup()
    this.aqua?._trace?.('node.ws.connect', {
      node: this.name,
      url: this.wsUrl
    })

    try {
      const h = this._boundHandlers

      if (this._wsIsBun) {
        const ws = new WebSocketImpl(this.wsUrl, { headers: this._headers })
        ws.binaryType = 'arraybuffer'

        const offs = []
        const add = (type, fn, once = false) => {
          const wrapped = once
            ? (ev) => {
                try {
                  ws.removeEventListener(type, wrapped)
                } catch {}
                fn(ev)
              }
            : fn
          ws.addEventListener(type, wrapped)
          offs.push(() => {
            try {
              ws.removeEventListener(type, wrapped)
            } catch {}
          })
        }

        add('open', () => h.open(), true)

        add(
          'error',
          (event) => {
            const err = event?.error
            h.error(err instanceof Error ? err : new Error('WebSocket error'))
          },
          true
        )

        add('message', (event) => {
          const data = event?.data
          if (typeof data === 'string') h.message(data, false)
          else h.message(data, true)
        })

        add(
          'close',
          (event) => {
            h.close(
              typeof event?.code === 'number'
                ? event.code
                : Node.WS_CLOSE_NORMAL,
              typeof event?.reason === 'string' ? event.reason : ''
            )
          },
          true
        )

        this._bunCleanup = () => {
          for (let i = 0; i < offs.length; i++) offs[i]()
        }
        this.ws = ws
        return
      }

      const ws = new WebSocketImpl(this.wsUrl, {
        headers: this._headers,
        perMessageDeflate: true,
        handshakeTimeout: this.timeout,
        maxPayload: this.maxPayload,
        skipUTF8Validation: this.skipUTF8Validation
      })

      ws.binaryType = 'nodebuffer'

      ws.once('open', h.open)
      ws.once('error', h.error)
      ws.on('message', h.message)
      ws.once('close', h.close)

      this.ws = ws
    } catch (err) {
      this._isConnecting = false
      this._emitError(`Failed to create WebSocket: ${_functions.errMsg(err)}`)
      this._scheduleReconnect()
    }
  }

  _cleanup() {
    const ws = this.ws
    if (!ws) return

    if (this._wsIsBun) {
      try {
        this._bunCleanup?.()
      } catch {}
      this._bunCleanup = null
    } else {
      ws.removeAllListeners?.()
    }

    try {
      const state = ws.readyState
      if (state === WS_STATES.OPEN || state === WS_STATES.CONNECTING) {
        ws.close(Node.WS_CLOSE_NORMAL)
      } else if (!this._wsIsBun && state !== WS_STATES.CLOSED) {
        ws.terminate?.()
      }
    } catch (err) {
      this._emitError(`WebSocket cleanup error: ${_functions.errMsg(err)}`)
    }

    this.ws = null
  }

  destroy(clean = false) {
    if (this.isDestroyed) return

    this.isDestroyed = true
    this.state = NODE_STATE.IDLE
    this._isConnecting = false
    this._clearReconnectTimeout()
    this._cleanup()

    if (!clean) this.aqua.handleNodeFailover?.(this)

    this.connected = false
    this.aqua.destroyNode?.(this.name)
    this.aqua.emit(AqualinkEvents.NodeDestroy, this)

    this.rest?.destroy?.()

    this.info = null
    this.rest = null
    this.aqua = null
    this._headers = null
    this.stats = null

    privateData.delete(this)
  }

  async getStats() {
    if (this.connected) return this.stats

    try {
      const newStats = await this.rest.getStats()
      if (newStats) this._updateStats(newStats)
    } catch (err) {
      this._emitError(`Failed to fetch node stats: ${_functions.errMsg(err)}`)
    }

    return this.stats
  }

  _updateStats(payload) {
    if (!payload) return
    const s = this.stats

    if (payload.players !== undefined) s.players = payload.players
    if (payload.playingPlayers !== undefined)
      s.playingPlayers = payload.playingPlayers
    if (payload.uptime !== undefined) s.uptime = payload.uptime
    if (payload.ping !== undefined) s.ping = payload.ping

    if (payload.memory) {
      const m = s.memory,
        pm = payload.memory
      if (pm.free !== undefined) m.free = pm.free
      if (pm.used !== undefined) m.used = pm.used
      if (pm.allocated !== undefined) m.allocated = pm.allocated
      if (pm.reservable !== undefined) m.reservable = pm.reservable
    }

    if (payload.cpu) {
      const c = s.cpu,
        pc = payload.cpu
      if (pc.cores !== undefined) c.cores = pc.cores
      if (pc.systemLoad !== undefined) c.systemLoad = pc.systemLoad
      if (pc.lavalinkLoad !== undefined) c.lavalinkLoad = pc.lavalinkLoad
    }

    if (payload.frameStats) {
      const f = s.frameStats,
        pf = payload.frameStats
      if (pf.sent !== undefined) f.sent = pf.sent
      if (pf.nulled !== undefined) f.nulled = pf.nulled
      if (pf.deficit !== undefined) f.deficit = pf.deficit
    }
  }

  async _handleReady(payload) {
    const sessionId = payload?.sessionId
    if (!sessionId) {
      this._emitError('Ready payload missing sessionId')
      return
    }

    const oldSessionId = this.sessionId
    const sessionChanged =
      oldSessionId && oldSessionId !== sessionId && !payload.resumed

    this.sessionId = sessionId
    this.aqua?._trace?.('node.ready.packet', {
      node: this.name,
      resumed: !!payload.resumed,
      oldSessionId,
      newSessionId: sessionId
    })
    this.rest.setSessionId(sessionId)
    this._headers['Session-Id'] = sessionId

    if (sessionChanged && this.aqua?.players) {
      this._emitDebug(
        `Session changed from ${oldSessionId} to ${sessionId}, invalidating stale players`
      )
      const playersToDestroy = []
      for (const [guildId, player] of this.aqua.players) {
        if (player?.nodes === this || player?.nodes?.name === this.name) {
          playersToDestroy.push(guildId)
        }
      }
      for (const guildId of playersToDestroy) {
        try {
          this._emitDebug(`Destroying stale player for guild ${guildId}`)
          await this.aqua.destroyPlayer(guildId)
        } catch (e) {
          this._emitDebug(
            `Failed to destroy stale player ${guildId}: ${e?.message || e}`
          )
        }
      }
    }

    this.aqua.emit(AqualinkEvents.NodeReady, this, {
      resumed: !!payload.resumed,
      sessionChanged
    })

    if (this.autoResume) {
      setImmediate(() => {
        this._resumePlayers().catch((err) => {
          this._emitError(`_resumePlayers failed: ${_functions.errMsg(err)}`)
        })
      })
    }
  }

  async _resumePlayers() {
    if (!this.sessionId) return
    this.aqua?._trace?.('node.resume.begin', {
      node: this.name,
      sessionId: this.sessionId,
      players: this.aqua?.players?.size || 0
    })

    try {
      await this.rest.makeRequest('PATCH', `/v4/sessions/${this.sessionId}`, {
        resuming: true,
        timeout: this.resumeTimeout
      })

      if (this.aqua?.players) {
        for (const [guildId, player] of this.aqua.players) {
          if (
            (player?.nodes === this || player?.nodes?.name === this.name) &&
            player.voiceChannel
          ) {
            try {
              this._emitDebug(`Rejoining voice for guild ${guildId} on resume`)
              this.aqua?._trace?.('node.resume.rejoin', {
                node: this.name,
                guildId,
                voiceChannel: player.voiceChannel
              })
              player.connect({
                voiceChannel: player.voiceChannel,
                deaf: player.deaf,
                mute: player.mute
              })
            } catch (e) {
              this._emitDebug(
                `Failed to rejoin voice for ${guildId}: ${e?.message || e}`
              )
            }
          }
        }
      }

      if (this.aqua.loadPlayers && this.aqua.players.size === 0) {
        await this.aqua.loadPlayers()
      }
    } catch (err) {
      this.aqua?._trace?.('node.resume.error', {
        node: this.name,
        error: _functions.errMsg(err)
      })
      this._emitError(`Failed to resume session: ${_functions.errMsg(err)}`)
      throw err
    }
  }

  _emitError(error) {
    const errorObj = error instanceof Error ? error : new Error(String(error))
    this.aqua.emit(AqualinkEvents.Error, this, errorObj)
  }

  _emitDebug(message) {
    if (!this.aqua?.listenerCount?.(AqualinkEvents.Debug)) return
    this.aqua.emit(
      AqualinkEvents.Debug,
      this.name,
      typeof message === 'function' ? message() : message
    )
  }
}

module.exports = Node
