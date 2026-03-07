const { AqualinkEvents } = require('./AqualinkEvents')
const { reportSuppressedError } = require('./Reporting')

class PlayerLifecycle {
  constructor(player, deps) {
    this.player = player
    this._functions = deps._functions
    this.PLAYER_STATE = deps.PLAYER_STATE
    this.VOICE_TRACE_INTERVAL = deps.VOICE_TRACE_INTERVAL
    this.PLAYER_UPDATE_SILENCE_THRESHOLD =
      deps.PLAYER_UPDATE_SILENCE_THRESHOLD
    this.VOICE_DOWN_THRESHOLD = deps.VOICE_DOWN_THRESHOLD
    this.VOICE_ABANDON_MULTIPLIER = deps.VOICE_ABANDON_MULTIPLIER
    this.VOICE_FORCE_DESTROY_MS = deps.VOICE_FORCE_DESTROY_MS
    this.RECONNECT_MAX = deps.RECONNECT_MAX
    this.MUTE_TOGGLE_DELAY = deps.MUTE_TOGGLE_DELAY
    this.SEEK_DELAY = deps.SEEK_DELAY
    this.PAUSE_DELAY = deps.PAUSE_DELAY
    this.RETRY_BACKOFF_BASE = deps.RETRY_BACKOFF_BASE
    this.RETRY_BACKOFF_MAX = deps.RETRY_BACKOFF_MAX
  }

  handlePlayerUpdate(packet) {
    const player = this.player
    if (player.destroyed || !packet?.state) return
    const s = packet.state
    player._lastPlayerUpdateAt = Date.now()
    const wasConnected = player.connected
    player.position = this._functions.isNum(s.position) ? s.position : 0
    player.connected = !!s.connected
    player.ping = this._functions.isNum(s.ping) ? s.ping : 0
    player.timestamp = this._functions.isNum(s.time) ? s.time : Date.now()

    if (!player.connected) {
      if (wasConnected || !player._voiceDownSince) {
        player.aqua?._trace?.('player.voice.down', {
          guildId: player.guildId,
          reconnecting: !!player._reconnecting,
          recovering: !!player._voiceRecovering
        })
      }
      if (
        !player._voiceDownSince &&
        !player._reconnecting &&
        !player._voiceRecovering
      ) {
        player._voiceDownSince = Date.now()
        player._createTimer(() => {
          if (
            player.connected ||
            player.destroyed ||
            player._reconnecting ||
            player._voiceRecovering ||
            player.nodes?.info?.isNodelink ||
            !player.voiceChannel
          )
            return
          player.connection.attemptResume()
        }, 1000)
      }
    } else {
      player._voiceDownSince = 0
      player.state = this.PLAYER_STATE.READY

      if (player._reconnecting && !player._isActivelyReconnecting) {
        player._reconnecting = false
      }
      if (player._resuming) {
        player._resuming = false
      }

      const now = Date.now()
      if (
        !wasConnected ||
        now - player._lastVoiceUpTraceAt >= this.VOICE_TRACE_INTERVAL
      ) {
        player._lastVoiceUpTraceAt = now
        player.aqua?._trace?.('player.voice.up', {
          guildId: player.guildId,
          ping: player.ping
        })
      }
      this.flushDeferredPlay()
    }

    player.aqua.emit(AqualinkEvents.PlayerUpdate, player, packet)
  }

  async voiceWatchdog() {
    const player = this.player
    if (player.destroyed || !player.connection) return

    const now = Date.now()
    const silentPlayer =
      player.playing &&
      !player.paused &&
      !!player.voiceChannel &&
      !player._reconnecting &&
      !player._voiceRecovering &&
      now - (player._lastPlayerUpdateAt || 0) >=
        this.PLAYER_UPDATE_SILENCE_THRESHOLD

    if (silentPlayer) {
      const silenceMs = now - (player._lastPlayerUpdateAt || now)
      if (!player._voiceDownSince)
        player._voiceDownSince = now - this.VOICE_DOWN_THRESHOLD - 1
      player._lastPlayerUpdateAt = now
      player.connected = false
      player.aqua?._trace?.('player.voice.silence', {
        guildId: player.guildId,
        silenceMs,
        playing: !!player.playing,
        paused: !!player.paused
      })
    }

    if (player._voiceDownSince && !player.connected) {
      const downFor = Date.now() - player._voiceDownSince
      if (
        downFor > this.VOICE_FORCE_DESTROY_MS &&
        player.reconnectionRetries >= this.RECONNECT_MAX
      ) {
        player.aqua?._trace?.('player.forceDestroy', { guildId: player.guildId })
        player.destroy()
        return
      }
    }

    if (!player._shouldAttemptVoiceRecovery()) return

    const hasVoiceData =
      player.connection?.sessionId &&
      player.connection?.endpoint &&
      player.connection?.token
    if (!hasVoiceData) {
      const downFor = Date.now() - player._voiceDownSince
      if (downFor > this.VOICE_DOWN_THRESHOLD * this.VOICE_ABANDON_MULTIPLIER) {
        player.connection?._requestVoiceState?.()
        player.connection?.resendVoiceUpdate(true)
        player.reconnectionRetries = Math.min(player.reconnectionRetries + 1, 30)
        if (
          downFor > this.VOICE_FORCE_DESTROY_MS &&
          player.reconnectionRetries >= this.RECONNECT_MAX * 2
        ) {
          player.destroy()
        }
      }
      return
    }

    player._voiceRecovering = true
    try {
      if (await player.connection.attemptResume()) {
        player.reconnectionRetries = player._voiceDownSince = 0
        return
      }
      const originalMute = player.mute
      player.send({
        guild_id: player.guildId,
        channel_id: player.voiceChannel,
        self_deaf: player.deaf,
        self_mute: !originalMute
      })
      await player._delay(this.MUTE_TOGGLE_DELAY)
      if (!player.destroyed) {
        player.send({
          guild_id: player.guildId,
          channel_id: player.voiceChannel,
          self_deaf: player.deaf,
          self_mute: originalMute
        })
      }
      player.connection.resendVoiceUpdate()
      player.reconnectionRetries++
    } catch (error) {
      player.reconnectionRetries++
      reportSuppressedError(player, 'player.voiceWatchdog', error, {
        guildId: player.guildId
      })
      if (player.reconnectionRetries >= this.RECONNECT_MAX) {
        player.connection?._requestVoiceState?.()
        player.connection?.resendVoiceUpdate(true)
        player.reconnectionRetries = this.RECONNECT_MAX - 2
      }
    } finally {
      player._voiceRecovering = false
    }
  }

  async attemptVoiceResume() {
    const player = this.player
    if (!player.connection?.sessionId) throw new Error('No session')
    if (!(await player.connection.attemptResume()))
      throw new Error('Resume failed')
  }

  async socketClosed(_player, _track, payload) {
    const player = this.player
    if (player.destroyed || player._reconnecting) return
    player.aqua?._trace?.('player.socketClosed', {
      guildId: player.guildId,
      code: payload?.code
    })

    const code = payload?.code
    if (code === 4006 && player._resuming) {
      player.aqua?._trace?.('player.socketClosed.ignored', {
        guildId: player.guildId,
        code,
        reason: 'transient_while_resuming'
      })
      return
    }

    let isRecoverable = [4015, 4009, 4006, 4014, 4022].includes(code)
    if (code === 4014 && player.connection?.isWaitingForDisconnect)
      isRecoverable = false

    if (code === 4015 && !player.nodes?.info?.isNodelink) {
      player._reconnecting = true
      player._isActivelyReconnecting = true
      try {
        await this.attemptVoiceResume()
        player._reconnecting = false
        player._isActivelyReconnecting = false
        return
      } catch (error) {
        player._reconnecting = false
        reportSuppressedError(player, 'player.socketClosed.resume', error, {
          guildId: player.guildId,
          code
        })
      }
    }

    if (!isRecoverable) {
      player.aqua.emit(AqualinkEvents.SocketClosed, player, payload)
      player.destroy()
      return
    }

    if (code === 4014 || code === 4022) {
      player.connected = false
      if (!player._voiceDownSince) player._voiceDownSince = Date.now()
      player._suppressResumeUntil =
        Date.now() + (code === 4022 ? 3000 : 2000)
    }

    const aqua = player.aqua
    const vcId = this._functions.toId(player.voiceChannel)
    const tcId = this._functions.toId(player.textChannel)
    const { guildId, deaf, mute } = player

    if (!vcId) {
      aqua?.emit?.(AqualinkEvents.SocketClosed, player, payload)
      return
    }

    if (code === 4014 || code === 4022) {
      const now = Date.now()
      if (now - (player._voiceRequestAt || 0) >= 1200) {
        player._voiceRequestAt = now
        player.connection?._requestVoiceState?.()
        player.connection?.resendVoiceUpdate?.(true)
        this._functions.safeCall(() =>
          player.connect({
            guildId,
            voiceChannel: vcId,
            deaf,
            mute
          })
        )
      }

      player.aqua?._trace?.('player.socketClosed.softRecover', {
        guildId: player.guildId,
        code,
        strategy: code === 4022 ? 'resume_after_voice_refresh' : '4014_retry'
      })
      const waitMs = Math.max(0, player._suppressResumeUntil - Date.now())
      if (waitMs > 0) await player._delay(waitMs)

      let resumed = false
      if (!player.destroyed && !player.connected) {
        resumed = await player.connection
          ?.attemptResume?.()
          .catch((error) => {
            reportSuppressedError(player, 'player.socketClosed.softRecover', error, {
              guildId: player.guildId,
              code
            })
            return false
          })
      }
      if (
        resumed ||
        player.connected ||
        player.destroyed ||
        player._reconnecting
      ) {
        player.aqua?._trace?.('player.socketClosed.softRecover.ok', {
          guildId: player.guildId,
          code,
          resumed: !!resumed
        })
        return
      }
      player.aqua?._trace?.('player.socketClosed.softRecover.failed', {
        guildId: player.guildId,
        code
      })
    }

    const state = {
      volume: player.volume,
      position: player.position,
      paused: player.paused,
      loop: player.loop,
      isAutoplayEnabled: player.isAutoplayEnabled,
      currentTrack: player.current,
      queue: player.queue?.toArray() || [],
      previousIdentifiers: Array.from(player.previousIdentifiers),
      autoplaySeed: player.autoplaySeed,
      nowPlayingMessage: player.nowPlayingMessage
    }

    player._reconnecting = true
    player._isActivelyReconnecting = true
    player.destroy({
      preserveClient: true,
      skipRemote: true,
      preserveMessage: true,
      preserveReconnecting: true,
      preserveTracks: true
    })

    const reconnectNonce = player._reconnectNonce
    player._reconnectTimers = new Set()
    const reconnectTimers = player._reconnectTimers
    const tryReconnect = async (attempt) => {
      if (aqua?.destroyed || player._reconnectNonce !== reconnectNonce) {
        this._functions.clearTimers(reconnectTimers)
        player._reconnectTimers = null
        player._reconnecting = false
        player._isActivelyReconnecting = false
        return
      }
      const activePlayer = aqua?.players?.get?.(String(guildId))
      if (activePlayer && activePlayer !== player && !activePlayer.destroyed) {
        this._functions.clearTimers(reconnectTimers)
        player._reconnectTimers = null
        player._reconnecting = false
        player._isActivelyReconnecting = false
        return
      }
      try {
        const np = await aqua.createConnection({
          guildId,
          voiceChannel: vcId,
          textChannel: tcId,
          deaf,
          mute,
          defaultVolume: state.volume,
          preserveMessage: true,
          resuming: true
        })
        if (!np) throw new Error('Failed to create player')
        if (player._reconnectNonce !== reconnectNonce || aqua?.destroyed) {
          try {
            np.destroy?.()
          } catch {}
          this._functions.clearTimers(reconnectTimers)
          player._reconnectTimers = null
          player._reconnecting = false
          player._isActivelyReconnecting = false
          return
        }

        np.reconnectionRetries = 0
        np.loop = state.loop
        np.isAutoplayEnabled = state.isAutoplayEnabled
        np.autoplaySeed = state.autoplaySeed
        np.previousIdentifiers = new Set(state.previousIdentifiers)
        np.nowPlayingMessage = state.nowPlayingMessage

        const ct = state.currentTrack
        if (ct) np.queue.add(ct)
        for (const q of state.queue) if (q !== ct) np.queue.add(q)

        if (ct) {
          await np.play()
          if (state.position > 5000)
            np._createTimer(
              () => !np.destroyed && np.seek(state.position),
              this.SEEK_DELAY
            )
          if (state.paused)
            np._createTimer(
              () => !np.destroyed && np.pause(true),
              this.PAUSE_DELAY
            )
        }

        this._functions.clearTimers(reconnectTimers)
        player._reconnectTimers = null
        player._reconnecting = false
        player._isActivelyReconnecting = false
        aqua.emit(AqualinkEvents.PlayerReconnected, np, {
          oldPlayer: player,
          restoredState: state
        })
      } catch (error) {
        if (player._reconnectNonce !== reconnectNonce || aqua?.destroyed) {
          this._functions.clearTimers(reconnectTimers)
          player._reconnectTimers = null
          player._reconnecting = false
          player._isActivelyReconnecting = false
          return
        }
        const retriesLeft = this.RECONNECT_MAX - attempt
        aqua.emit(AqualinkEvents.ReconnectionFailed, player, {
          error,
          code,
          payload,
          retriesLeft
        })

        if (retriesLeft > 0) {
          this._functions.createTimer(
            () => tryReconnect(attempt + 1),
            Math.min(
              this.RETRY_BACKOFF_BASE * attempt,
              this.RETRY_BACKOFF_MAX
            ),
            reconnectTimers
          )
        } else {
          this._functions.clearTimers(reconnectTimers)
          player._reconnectTimers = null
          player._reconnecting = false
          player._isActivelyReconnecting = false
          aqua.emit(AqualinkEvents.SocketClosed, player, payload)
        }
      }
    }

    tryReconnect(1)
  }

  flushDeferredPlay() {
    const player = this.player
    if (
      !player._deferredStart ||
      player.destroyed ||
      !player.current?.track ||
      !player._updateBatcher
    )
      return
    player._deferredStart = false
    const updateData = {
      track: { encoded: player.current.track },
      paused: player.paused
    }
    if (player.position > 0) updateData.position = player.position
    player.aqua?._trace?.('player.play.deferred.flush', {
      guildId: player.guildId,
      hasEndpoint: !!player.connection?.endpoint
    })
    player.batchUpdatePlayer(updateData, true).catch((error) =>
      reportSuppressedError(player, 'player.deferredPlay.flush', error, {
        guildId: player.guildId
      })
    )
  }
}

module.exports = PlayerLifecycle
