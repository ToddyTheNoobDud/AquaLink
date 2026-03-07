const { AqualinkEvents } = require('./AqualinkEvents')
const { reportSuppressedError } = require('./Reporting')

class ConnectionRecovery {
  constructor(connection, deps) {
    this.connection = connection
    this._functions = deps._functions
    this.STATE = deps.STATE
    this.RECONNECT_DELAY = deps.RECONNECT_DELAY
    this.MAX_RECONNECT_ATTEMPTS = deps.MAX_RECONNECT_ATTEMPTS
    this.RESUME_BACKOFF_MAX = deps.RESUME_BACKOFF_MAX
  }

  setServerUpdate(data) {
    const conn = this.connection
    if (conn._destroyed || !data?.token) return

    const endpoint =
      typeof data.endpoint === 'string' ? data.endpoint.trim() : ''
    if (!endpoint) return

    if (conn._lastEndpoint === endpoint && conn.token === data.token) return
    if (data.txId && data.txId < conn.txId) return

    conn._stateGeneration++

    if (conn._lastEndpoint !== endpoint) {
      conn.sequence = 0
      conn._lastEndpoint = endpoint
      conn._reconnectAttempts = 0
      conn._consecutiveFailures = 0
      conn._regionMigrationAttempted = false
    }

    conn.endpoint = endpoint
    conn.region = this._functions.extractRegion(endpoint)
    conn.token = data.token
    conn.channelId = data.channel_id || conn.channelId || conn.voiceChannel
    conn._lastVoiceDataUpdate = Date.now()
    if (conn._aqua?.debugTrace) {
      conn._aqua._trace('connection.serverUpdate', {
        guildId: conn._guildId,
        endpoint: conn.endpoint,
        region: conn.region,
        txId: data.txId || null
      })
    }
    conn._stateFlags &= ~this.STATE.VOICE_DATA_STALE

    const migrated = this.checkRegionMigration()
    if (migrated) return
    conn._scheduleVoiceUpdate()
    conn._player?._flushDeferredPlay?.()
  }

  checkRegionMigration() {
    const conn = this.connection
    if (conn._destroyed || conn._regionMigrationAttempted) return false
    if (
      !conn._aqua?.autoRegionMigrate ||
      !conn.region ||
      conn.region === 'unknown'
    )
      return false

    const player = conn._player
    if (!player || player.destroyed || player._resuming || player._reconnecting)
      return false

    const currentNode = player.nodes
    if (!currentNode) return false

    const currentRegions = Array.isArray(currentNode.regions)
      ? currentNode.regions
      : []
    const alreadyMatching = currentRegions.some((r) =>
      conn._aqua._regionMatches?.(r, conn.region)
    )
    if (alreadyMatching) {
      conn._regionMigrationAttempted = true
      return false
    }

    const targetNode = conn._aqua._findBestNodeForRegion?.(conn.region)
    if (!targetNode || targetNode === currentNode) return false

    conn._regionMigrationAttempted = true
    if (conn._aqua?.debugTrace) {
      conn._aqua._trace('connection.region.migrate', {
        guildId: conn._guildId,
        region: conn.region,
        from: currentNode?.name || currentNode?.host,
        to: targetNode?.name || targetNode?.host
      })
    }

    queueMicrotask(() => {
      conn._aqua
        .movePlayerToNode?.(conn._guildId, targetNode, 'region')
        .catch((error) => {
          conn._regionMigrationAttempted = false
          reportSuppressedError(
            conn._aqua,
            'connection.region.migrate',
            error,
            {
              guildId: conn._guildId,
              region: conn.region
            }
          )
        })
    })
    return true
  }

  async attemptResume() {
    const conn = this.connection
    if (!conn._canAttemptResumeCore()) return false
    if (conn._aqua?.debugTrace) {
      conn._aqua._trace('connection.resume.attempt', {
        guildId: conn._guildId,
        reconnectAttempts: conn._reconnectAttempts,
        hasSessionId: !!conn.sessionId,
        hasEndpoint: !!conn.endpoint,
        hasToken: !!conn.token
      })
    }

    const currentGen = conn._stateGeneration
    if (
      !conn.sessionId ||
      !conn.endpoint ||
      !conn.token ||
      conn._stateFlags & this.STATE.VOICE_DATA_STALE
    ) {
      const now = Date.now()
      if (now - (conn._lastResumeBlockedLogAt || 0) >= 5000) {
        conn._lastResumeBlockedLogAt = now
        conn._aqua.emit(
          AqualinkEvents.Debug,
          `Resume blocked: missing voice data for guild ${conn._guildId}, requesting voice state`
        )
      }
      conn._requestVoiceState()
      return false
    }

    conn.txId = conn._player.txId || conn.txId
    conn._stateFlags |= this.STATE.ATTEMPTING_RESUME
    conn._reconnectAttempts++
    conn._aqua.emit(
      AqualinkEvents.Debug,
      `Attempt resume: guild=${conn._guildId} endpoint=${conn.endpoint} session=${conn.sessionId}`
    )

    const payload = sharedPool.acquire()
    try {
      this._functions.fillVoicePayload(
        payload,
        conn._guildId,
        conn,
        conn._player,
        true
      )

      if (conn._stateGeneration !== currentGen) {
        conn._aqua.emit(
          AqualinkEvents.Debug,
          `Resume aborted: State changed during attempt for guild ${conn._guildId}`
        )
        return false
      }

      await this.sendUpdate(payload)
      if (conn._aqua?.debugTrace) {
        conn._aqua._trace('connection.resume.success', {
          guildId: conn._guildId
        })
      }

      conn._reconnectAttempts = 0
      conn._consecutiveFailures = 0
      if (conn._player) conn._player._resuming = false

      conn._aqua.emit(
        AqualinkEvents.Debug,
        `Resume PATCH sent for guild ${conn._guildId}`
      )
      return true
    } catch (error) {
      if (conn._destroyed || !conn._aqua) throw error
      conn._consecutiveFailures++
      conn._aqua.emit(
        AqualinkEvents.Debug,
        `Resume failed for guild ${conn._guildId}: ${error?.message || error}`
      )
      if (conn._aqua?.debugTrace) {
        conn._aqua._trace('connection.resume.error', {
          guildId: conn._guildId,
          error: error?.message || String(error)
        })
      }

      if (
        conn._reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS &&
        !conn._destroyed &&
        conn._consecutiveFailures < 5
      ) {
        const delay = Math.min(
          this.RECONNECT_DELAY * (1 << (conn._reconnectAttempts - 1)),
          this.RESUME_BACKOFF_MAX
        )
        conn._setReconnectTimer(delay)
      } else {
        conn._aqua.emit(
          AqualinkEvents.Debug,
          `Max reconnect attempts/failures reached for guild ${conn._guildId}`
        )
        if (conn._player) conn._player._resuming = false
        conn._handleDisconnect()
      }
      return false
    } finally {
      conn._stateFlags &= ~this.STATE.ATTEMPTING_RESUME
      sharedPool.release(payload)
    }
  }

  async recoverMissingPlayer(isSessionError) {
    const conn = this.connection
    if (conn._destroyed || !conn._player || conn._missingPlayerRecovering)
      return false

    const now = Date.now()
    if (now - conn._lastMissingPlayerRecoverAt < 5000) return false

    conn._missingPlayerRecovering = true
    conn._lastMissingPlayerRecoverAt = now
    if (conn._aqua?.debugTrace) {
      conn._aqua._trace('connection.playerMissing.recover.start', {
        guildId: conn._guildId,
        isSessionError: !!isSessionError
      })
    }

    try {
      if (isSessionError && conn._player?.nodes?._clearSession) {
        conn._player.nodes._clearSession()
      }

      conn._requestVoiceState()
      const resumed = await this.attemptResume().catch((error) => {
        reportSuppressedError(
          conn._aqua,
          'connection.playerMissing.resume',
          error,
          {
            guildId: conn._guildId
          }
        )
        return false
      })
      if (!resumed) conn.resendVoiceUpdate(true)

      if (conn._player.playing && conn._player.current?.track) {
        const data = {
          track: { encoded: conn._player.current.track },
          paused: !!conn._player.paused
        }
        if (conn._player.position > 0) data.position = conn._player.position
        await conn._rest.updatePlayer({
          guildId: conn._guildId,
          data,
          noReplace: false
        })
      }

      if (conn._aqua?.debugTrace) {
        conn._aqua._trace('connection.playerMissing.recover.ok', {
          guildId: conn._guildId,
          resumed: !!resumed,
          playing: !!conn._player.playing
        })
      }
      return true
    } catch (error) {
      if (conn._aqua?.debugTrace) {
        conn._aqua._trace('connection.playerMissing.recover.error', {
          guildId: conn._guildId,
          error: error?.message || String(error)
        })
      }
      return false
    } finally {
      conn._missingPlayerRecovering = false
    }
  }

  async sendUpdate(payload) {
    const conn = this.connection
    if (conn._destroyed) throw new Error('Connection destroyed')
    if (!conn._rest) throw new Error('REST interface unavailable')

    try {
      if (conn._aqua?.debugTrace) {
        conn._aqua._trace('connection.update.send', {
          guildId: conn._guildId,
          hasSessionId: !!conn._rest?.sessionId,
          hasVoice:
            !!payload?.data?.voice?.sessionId &&
            !!payload?.data?.voice?.endpoint
        })
      }
      await conn._rest.updatePlayer(payload)
      if (conn._aqua?.debugTrace) {
        conn._aqua._trace('connection.update.ok', {
          guildId: conn._guildId
        })
      }
    } catch (error) {
      if (conn._aqua?.debugTrace) {
        conn._aqua._trace('connection.update.error', {
          guildId: conn._guildId,
          statusCode: error?.statusCode || error?.response?.statusCode || null,
          error: error?.message || String(error)
        })
      }
      if (error.statusCode === 404 || error.response?.statusCode === 404) {
        const isSessionError =
          error.body?.message?.includes('sessionId') || false
        const recovered = await this.recoverMissingPlayer(isSessionError)
        if (recovered) return

        if (conn._aqua) {
          conn._aqua.emit(
            AqualinkEvents.Debug,
            `[Aqua/Connection] Player ${conn._guildId} not found (404)${isSessionError ? ' - Session invalid' : ''}. Recovery failed, destroying.`
          )
          await conn._aqua.destroyPlayer(conn._guildId)
        }
        throw error
      }
      if (!this._functions.isNetworkError(error)) {
        conn._aqua.emit(
          AqualinkEvents.Debug,
          new Error(`Voice update failed: ${error?.message || error}`)
        )
      }
      throw error
    }
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
    if (!payload || this._size >= 12) return
    payload.guildId = null
    const v = payload.data.voice
    v.token = v.endpoint = v.sessionId = null
    payload.data.volume = null
    this._pool[this._size++] = payload
  }
}

const sharedPool = new PayloadPool()

module.exports = ConnectionRecovery
