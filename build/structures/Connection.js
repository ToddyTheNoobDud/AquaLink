const { AqualinkEvents } = require('./AqualinkEvents')

const POOL_SIZE = 12
const UPDATE_TIMEOUT = 4000

const RECONNECT_DELAY = 1000
const MAX_RECONNECT_ATTEMPTS = 3
const RESUME_BACKOFF_MAX = 60000

const VOICE_DATA_TIMEOUT = 90000

const VOICE_FLUSH_DELAY = 50

const NULL_CHANNEL_GRACE_MS = 15000

const STATE = {
  CONNECTED: 1,
  UPDATE_SCHEDULED: 64,
  DISCONNECTING: 128,
  ATTEMPTING_RESUME: 256,
  VOICE_DATA_STALE: 512
}

const _functions = {
  safeUnref: (t) => (typeof t?.unref === 'function' ? t.unref() : undefined),
  isValidNumber: (n) => typeof n === 'number' && n >= 0 && Number.isFinite(n),
  isNetworkError: (e) =>
    !!e &&
    (e.code === 'ECONNREFUSED' ||
      e.code === 'ENOTFOUND' ||
      e.code === 'ETIMEDOUT'),
  noop: () => {},
  extractRegion: (endpoint) => {
    if (typeof endpoint !== 'string') return 'unknown'
    endpoint = endpoint.trim()
    if (!endpoint) return 'unknown'

    const proto = endpoint.indexOf('://')
    if (proto !== -1) endpoint = endpoint.slice(proto + 3)

    const slash = endpoint.indexOf('/')
    if (slash !== -1) endpoint = endpoint.slice(0, slash)

    const colon = endpoint.indexOf(':')
    if (colon !== -1) endpoint = endpoint.slice(0, colon)

    const dot = endpoint.indexOf('.')
    const label = (dot === -1 ? endpoint : endpoint.slice(0, dot)).toLowerCase()
    if (!label) return 'unknown'

    // Discord voice hosts commonly look like: c-gru20-<hash>.discord.media
    const cPrefix = /^c-([a-z]{3})(?:\d+)?(?:-|$)/
    const m1 = cPrefix.exec(label)
    if (m1?.[1]) return m1[1]

    // Fallback for labels that still contain an iata-like token.
    const token = /(?:^|-)([a-z]{3})(?:\d+)?(?:-|$)/
    const m2 = token.exec(label)
    if (m2?.[1]) return m2[1]

    // Last fallback: strip trailing digits from first label.
    let i = label.length - 1
    while (i >= 0) {
      const c = label.charCodeAt(i)
      if (c >= 48 && c <= 57) i--
      else break
    }
    return label.slice(0, i + 1) || 'unknown'
  },
  fillVoicePayload: (payload, guildId, conn, player, resume) => {
    payload.guildId = guildId
    const v = payload.data.voice
    v.token = conn.token
    v.endpoint = conn.endpoint
    v.sessionId = conn.sessionId
    v.channelId = player.voiceChannel
    payload.data.volume = player?.volume ?? 100
    return payload
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
        voice: {
          token: null,
          endpoint: null,
          sessionId: null
        },
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
    if (!player?.aqua?.clientId || !player.nodes?.rest)
      throw new TypeError('Invalid player configuration')

    this._player = player
    this._aqua = player.aqua
    this._rest = player.nodes.rest
    this._guildId = player.guildId
    this._clientId = player.aqua.clientId

    this.voiceChannel = player.voiceChannel
    this.sessionId = null
    this.channelId = null
    this.endpoint = null
    this.token = null
    this.region = null
    this.sequence = 0
    this.txId = 0

    this._lastEndpoint = null
    this._stateFlags = 0
    this._reconnectAttempts = 0
    this._destroyed = false
    this._reconnectTimer = null
    this._lastVoiceDataUpdate = 0
    this._consecutiveFailures = 0

    this._voiceFlushTimer = null
    this._pendingUpdate = null
    this._lastSentVoiceKey = ''

    this._nullChannelTimer = null
    this.isWaitingForDisconnect = false

    this._lastStateReqAt = 0
    this._stateGeneration = 0
    this._regionMigrationAttempted = false
  }

  _hasValidVoiceData() {
    if (!this.sessionId || !this.endpoint || !this.token) return false
    if (Date.now() - this._lastVoiceDataUpdate > VOICE_DATA_TIMEOUT) {
      this._stateFlags |= STATE.VOICE_DATA_STALE
      return false
    }
    return true
  }

  _clearNullChannelTimer() {
    if (!this._nullChannelTimer) return
    clearTimeout(this._nullChannelTimer)
    this._nullChannelTimer = null
  }

  _canAttemptResumeCore() {
    if (this._destroyed) return false
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return false
    if (this._stateFlags & (STATE.ATTEMPTING_RESUME | STATE.DISCONNECTING))
      return false
    return true
  }

  _setReconnectTimer(delay) {
    if (this._destroyed) return
    this._clearReconnectTimer()
    this._reconnectTimer = setTimeout(() => this._handleReconnect(), delay)
    _functions.safeUnref(this._reconnectTimer)
  }

  setServerUpdate(data) {
    if (this._destroyed || !data?.token) return

    const endpoint =
      typeof data.endpoint === 'string' ? data.endpoint.trim() : ''
    if (!endpoint) return

    if (this._lastEndpoint === endpoint && this.token === data.token) return

    if (data.txId && data.txId < this.txId) return

    this._stateGeneration++

    if (this._lastEndpoint !== endpoint) {
      this.sequence = 0
      this._lastEndpoint = endpoint
      this._reconnectAttempts = 0
      this._consecutiveFailures = 0
      this._regionMigrationAttempted = false
    }

    this.endpoint = endpoint
    this.region = _functions.extractRegion(endpoint)
    this.token = data.token
    this.channelId = data.channel_id || this.channelId || this.voiceChannel
    this._lastVoiceDataUpdate = Date.now()
    this._aqua?._trace?.('connection.serverUpdate', {
      guildId: this._guildId,
      endpoint: this.endpoint,
      region: this.region,
      txId: data.txId || null
    })
    this._stateFlags &= ~STATE.VOICE_DATA_STALE

    if (this._player?.paused) this._player.pause(false)
    const migrated = this._checkRegionMigration()
    if (migrated) return
    this._scheduleVoiceUpdate()
    this._player?._flushDeferredPlay?.()
  }

  _checkRegionMigration() {
    if (this._destroyed || this._regionMigrationAttempted) return false
    if (!this._aqua?.autoRegionMigrate || !this.region || this.region === 'unknown') return false
    const player = this._player
    if (!player || player.destroyed || player._resuming || player._reconnecting) return false

    const currentNode = player.nodes
    if (!currentNode) return false

    const currentRegions = Array.isArray(currentNode.regions) ? currentNode.regions : []
    const alreadyMatching = currentRegions.some((r) =>
      this._aqua._regionMatches?.(r, this.region)
    )
    if (alreadyMatching) {
      this._regionMigrationAttempted = true
      return false
    }

    const targetNode = this._aqua._findBestNodeForRegion?.(this.region)
    if (!targetNode || targetNode === currentNode) return false

    this._regionMigrationAttempted = true
    this._aqua?._trace?.('connection.region.migrate', {
      guildId: this._guildId,
      region: this.region,
      from: currentNode?.name || currentNode?.host,
      to: targetNode?.name || targetNode?.host
    })

    queueMicrotask(() => {
      this._aqua
        .movePlayerToNode?.(this._guildId, targetNode, 'region')
        .catch((err) => {
          this._regionMigrationAttempted = false
          this._aqua?._trace?.('connection.region.migrate.error', {
            guildId: this._guildId,
            region: this.region,
            error: err?.message || String(err)
          })
        })
    })
    return true
  }

  resendVoiceUpdate(force = false) {
    if (this._destroyed || !this._hasValidVoiceData()) return false
    if (force) this._lastSentVoiceKey = ''
    this._scheduleVoiceUpdate()
    return true
  }

  setStateUpdate(data) {
    if (this._destroyed || !data || data.user_id !== this._clientId) return

    const {
      session_id: sessionId,
      channel_id: channelId,
      self_deaf: selfDeaf,
      self_mute: selfMute
    } = data
    const p = this._player

    if (channelId) this._clearNullChannelTimer()

    if (data.txId && data.txId < this.txId) return

    if (!channelId) {
      this._aqua?._trace?.('connection.stateUpdate.nullChannel', {
        guildId: this._guildId,
        txId: data.txId || null
      })
      this.isWaitingForDisconnect = true
      if (!this._nullChannelTimer) {
        this._nullChannelTimer = setTimeout(() => {
          this._nullChannelTimer = null
          this._handleDisconnect()
        }, NULL_CHANNEL_GRACE_MS)
        _functions.safeUnref(this._nullChannelTimer)
      }
      return
    }

    this.isWaitingForDisconnect = false
    this._aqua?._trace?.('connection.stateUpdate', {
      guildId: this._guildId,
      channelId,
      sessionId,
      txId: data.txId || null
    })

    if (p && p.txId > this.txId) this.txId = p.txId

    let needsUpdate = false

    if (this.voiceChannel !== channelId) {
      p._reconnecting = true
      p._resuming = true
      this._aqua.emit(
        AqualinkEvents.PlayerMove,
        p,
        this.voiceChannel,
        channelId
      )
      this.voiceChannel = channelId
      p.voiceChannel = channelId
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

    p.self_deaf = p.selfDeaf = !!selfDeaf
    p.self_mute = p.selfMute = !!selfMute
    this._stateFlags |= STATE.CONNECTED

    if (needsUpdate) this._scheduleVoiceUpdate()
  }

  async _handleDisconnect() {
    if (this._destroyed) return

    this._stateFlags =
      (this._stateFlags | STATE.DISCONNECTING) & ~STATE.CONNECTED
    this._aqua?._trace?.('connection.disconnect', {
      guildId: this._guildId
    })
    this._clearNullChannelTimer()
    this._clearPendingUpdate()
    this._clearReconnectTimer()

    this.voiceChannel = null
    this.sessionId = null
    this.sequence = 0
    this._lastVoiceDataUpdate = 0
    this._stateFlags |= STATE.VOICE_DATA_STALE

    try {
      if (this._aqua && this._guildId) {
        await this._aqua.destroyPlayer(this._guildId)
      }
    } catch (e) {
      this._aqua?.emit?.(
        AqualinkEvents.Debug,
        new Error(`Player destroy failed: ${e?.message || e}`)
      )
    } finally {
      this._stateFlags &= ~STATE.DISCONNECTING
    }
  }

  _requestVoiceState() {
    try {
      const now = Date.now()
      if (now - (this._lastStateReqAt || 0) < 1500) return false
      this._lastStateReqAt = now

      if (
        typeof this._player?.send !== 'function' ||
        !this._player.voiceChannel
      )
        return false
      this._player.send({
        guild_id: this._guildId,
        channel_id: this._player.voiceChannel,
        self_deaf: this._player.deaf,
        self_mute: this._player.mute
      })
      return true
    } catch {
      return false
    }
  }

  async attemptResume() {
    if (!this._canAttemptResumeCore()) return false
    this._aqua?._trace?.('connection.resume.attempt', {
      guildId: this._guildId,
      reconnectAttempts: this._reconnectAttempts,
      hasSessionId: !!this.sessionId,
      hasEndpoint: !!this.endpoint,
      hasToken: !!this.token
    })

    const currentGen = this._stateGeneration

    if (
      !this.sessionId ||
      !this.endpoint ||
      !this.token ||
      this._stateFlags & STATE.VOICE_DATA_STALE
    ) {
      this._aqua.emit(
        AqualinkEvents.Debug,
        `Resume blocked: missing voice data for guild ${this._guildId}, requesting voice state`
      )
      this._requestVoiceState()
      return false
    }

    this.txId = this._player.txId || this.txId
    this._stateFlags |= STATE.ATTEMPTING_RESUME
    this._reconnectAttempts++
    this._aqua.emit(
      AqualinkEvents.Debug,
      `Attempt resume: guild=${this._guildId} endpoint=${this.endpoint} session=${this.sessionId}`
    )

    const payload = sharedPool.acquire()
    try {
      _functions.fillVoicePayload(
        payload,
        this._guildId,
        this,
        this._player,
        true
      )

      if (this._stateGeneration !== currentGen) {
        this._aqua.emit(
          AqualinkEvents.Debug,
          `Resume aborted: State changed during attempt for guild ${this._guildId}`
        )
        return false
      }

      await this._sendUpdate(payload)
      this._aqua?._trace?.('connection.resume.success', {
        guildId: this._guildId
      })

      this._reconnectAttempts = 0
      this._consecutiveFailures = 0
      if (this._player) this._player._resuming = false

      this._aqua.emit(
        AqualinkEvents.Debug,
        `Resume PATCH sent for guild ${this._guildId}`
      )
      return true
    } catch (e) {
      if (this._destroyed || !this._aqua) throw e
      this._consecutiveFailures++
      this._aqua.emit(
        AqualinkEvents.Debug,
        `Resume failed for guild ${this._guildId}: ${e?.message || e}`
      )
      this._aqua?._trace?.('connection.resume.error', {
        guildId: this._guildId,
        error: e?.message || String(e)
      })

      if (
        this._reconnectAttempts < MAX_RECONNECT_ATTEMPTS &&
        !this._destroyed &&
        this._consecutiveFailures < 5
      ) {
        const delay = Math.min(
          RECONNECT_DELAY * (1 << (this._reconnectAttempts - 1)),
          RESUME_BACKOFF_MAX
        )
        this._setReconnectTimer(delay)
      } else {
        this._aqua.emit(
          AqualinkEvents.Debug,
          `Max reconnect attempts/failures reached for guild ${this._guildId}`
        )
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
    if (_functions.isValidNumber(seq) && seq > this.sequence)
      this.sequence = seq
  }

  _clearReconnectTimer() {
    if (!this._reconnectTimer) return
    clearTimeout(this._reconnectTimer)
    this._reconnectTimer = null
  }

  _clearPendingUpdate() {
    this._stateFlags &= ~STATE.UPDATE_SCHEDULED
    if (this._pendingUpdate?.payload)
      sharedPool.release(this._pendingUpdate.payload)
    this._pendingUpdate = null
    if (this._voiceFlushTimer) {
      clearTimeout(this._voiceFlushTimer)
      this._voiceFlushTimer = null
    }
  }

  _makeVoiceKey() {
    const p = this._player
    const vol = p?.volume ?? 100
    return `${this.sessionId || ''}|${this.token || ''}|${this.endpoint || ''}|${p?.voiceChannel || ''}|${vol}`
  }

  _scheduleVoiceUpdate() {
    if (this._destroyed) {
      this._aqua?._trace?.('connection.update.skip', {
        guildId: this._guildId,
        reason: 'destroyed'
      })
      return
    }
    if (!this._hasValidVoiceData()) {
      this._aqua?._trace?.('connection.update.skip', {
        guildId: this._guildId,
        reason: 'invalid_voice_data',
        hasSessionId: !!this.sessionId,
        hasEndpoint: !!this.endpoint,
        hasToken: !!this.token
      })
      return
    }

    if (!this._pendingUpdate) {
      const payload = sharedPool.acquire()
      _functions.fillVoicePayload(
        payload,
        this._guildId,
        this,
        this._player,
        false
      )
      this._pendingUpdate = { payload, timestamp: Date.now() }
    } else {
      this._pendingUpdate.timestamp = Date.now()
      _functions.fillVoicePayload(
        this._pendingUpdate.payload,
        this._guildId,
        this,
        this._player,
        false
      )
    }

    if (this._stateFlags & STATE.UPDATE_SCHEDULED) return
    this._stateFlags |= STATE.UPDATE_SCHEDULED
    this._aqua?._trace?.('connection.update.scheduled', {
      guildId: this._guildId
    })

    this._voiceFlushTimer = setTimeout(
      () => this._executeVoiceUpdate(),
      VOICE_FLUSH_DELAY
    )
    _functions.safeUnref(this._voiceFlushTimer)
  }

  _executeVoiceUpdate() {
    if (this._destroyed) return
    this._stateFlags &= ~STATE.UPDATE_SCHEDULED
    this._voiceFlushTimer = null

    const pending = this._pendingUpdate
    this._pendingUpdate = null

    if (!pending) return
    if (Date.now() - pending.timestamp > UPDATE_TIMEOUT) {
      sharedPool.release(pending.payload)
      return
    }

    const key = this._makeVoiceKey()
    if (key === this._lastSentVoiceKey) {
      sharedPool.release(pending.payload)
      return
    }
    this._lastSentVoiceKey = key

    this._sendUpdate(pending.payload)
      .catch(_functions.noop)
      .finally(() => sharedPool.release(pending.payload))
  }

  async _sendUpdate(payload) {
    if (this._destroyed) throw new Error('Connection destroyed')
    if (!this._rest) throw new Error('REST interface unavailable')

    try {
      this._aqua?._trace?.('connection.update.send', {
        guildId: this._guildId,
        hasSessionId: !!this._rest?.sessionId,
        hasVoice: !!payload?.data?.voice?.sessionId && !!payload?.data?.voice?.endpoint
      })
      await this._rest.updatePlayer(payload)
      this._aqua?._trace?.('connection.update.ok', {
        guildId: this._guildId
      })
    } catch (e) {
      this._aqua?._trace?.('connection.update.error', {
        guildId: this._guildId,
        statusCode: e?.statusCode || e?.response?.statusCode || null,
        error: e?.message || String(e)
      })
      if (e.statusCode === 404 || e.response?.statusCode === 404) {
        const isSessionError = e.body?.message?.includes('sessionId') || false
        if (this._aqua) {
          this._aqua.emit(
            AqualinkEvents.Debug,
            `[Aqua/Connection] Player ${this._guildId} not found (404)${isSessionError ? ' - Session invalid' : ''}. Destroying.`
          )
          if (isSessionError && this._player?.nodes?._clearSession) {
            this._player.nodes._clearSession()
          }
          await this._aqua.destroyPlayer(this._guildId)
        }
        throw e
      }
      if (!_functions.isNetworkError(e)) {
        this._aqua.emit(
          AqualinkEvents.Debug,
          new Error(`Voice update failed: ${e?.message || e}`)
        )
      }
      throw e
    }
  }

  destroy() {
    if (this._destroyed) return
    this._destroyed = true

    this._clearNullChannelTimer()
    this._clearPendingUpdate()
    this._clearReconnectTimer()

    this._player = this._aqua = this._rest = null
    this.voiceChannel =
      this.sessionId =
      this.endpoint =
      this.token =
      this.region =
      this._lastEndpoint =
        null
    this._stateFlags = 0
    this.sequence = 0
    this._reconnectAttempts = 0
    this._consecutiveFailures = 0
    this._lastVoiceDataUpdate = 0
  }
}

module.exports = Connection
