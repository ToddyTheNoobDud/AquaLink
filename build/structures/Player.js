const { EventEmitter } = require('node:events')
const { AqualinkEvents } = require('./AqualinkEvents')
const Connection = require('./Connection')
const Filters = require('./Filters')
const PlayerLifecycle = require('./PlayerLifecycle')
const { attachPlayerLifecycleState } = require('./PlayerLifecycleState')
const { reportSuppressedError } = require('./Reporting')
const { spAutoPlay, scAutoPlay } = require('../handlers/autoplay')
const Queue = require('./Queue')

const PLAYER_STATE = Object.freeze({
  IDLE: 0,
  CONNECTING: 1,
  READY: 2,
  DISCONNECTING: 3,
  DESTROYED: 4
})
const LOOP_MODES = Object.freeze({ NONE: 0, TRACK: 1, QUEUE: 2 })
const LOOP_MODE_NAMES = Object.freeze(['none', 'track', 'queue'])
const EVENT_HANDLERS = Object.freeze({
  TrackStartEvent: 'trackStart',
  TrackEndEvent: 'trackEnd',
  TrackExceptionEvent: 'trackError',
  TrackStuckEvent: 'trackStuck',
  TrackChangeEvent: 'trackChange',
  WebSocketClosedEvent: 'socketClosed',
  LyricsLineEvent: 'lyricsLine',
  LyricsFoundEvent: 'lyricsFound',
  VolumeChangedEvent: 'volumeChanged',
  FiltersChangedEvent: 'filtersChanged',
  SeekEvent: 'seekEvent',
  PlayerCreatedEvent: 'playerCreated',
  PauseEvent: 'pauseEvent',
  PlayerConnectedEvent: 'playerConnected',
  PlayerDestroyedEvent: 'playerDestroyed',
  LyricsNotFoundEvent: 'lyricsNotFound',
  MixStartedEvent: 'mixStarted',
  MixEndedEvent: 'mixEnded'
})

const WATCHDOG_INTERVAL = 15000
const VOICE_DOWN_THRESHOLD = 10000
const VOICE_ABANDON_MULTIPLIER = 12
const RECONNECT_MAX = 15
const MUTE_TOGGLE_DELAY = 300
const SEEK_DELAY = 800
const PAUSE_DELAY = 1200
const VOICE_TRACE_INTERVAL = 15000
const PLAYER_UPDATE_SILENCE_THRESHOLD = 45000
const VOICE_FORCE_DESTROY_MS = 15 * 60 * 1000
const RETRY_BACKOFF_BASE = 1500
const RETRY_BACKOFF_MAX = 5000
const PREVIOUS_TRACKS_SIZE = 50
const PREVIOUS_IDS_MAX = 20
const AUTOPLAY_MAX = 3
const BATCHER_POOL_SIZE = 2
const INVALID_LOADS = new Set(['error', 'empty', 'LOAD_FAILED', 'NO_MATCHES'])

const _functions = {
  clamp(v) {
    const n = +v
    return Number.isNaN(n) ? 100 : n < 0 ? 0 : n > 1000 ? 1000 : n
  },
  randIdx: (len) => (Math.random() * len) | 0,
  toId: (v) => v?.id || v || null,
  isNum: (v) => typeof v === 'number' && !Number.isNaN(v),
  isInvalidLoad: (r) => !r?.tracks?.length || INVALID_LOADS.has(r.loadType),
  safeDel: (msg) => msg?.delete?.().catch(() => {}),
  createTimer(fn, delay, timerSet, unref = true) {
    const t = setTimeout(() => {
      timerSet?.delete(t)
      fn()
    }, delay)
    if (unref) t.unref?.()
    timerSet?.add(t)
    return t
  },
  clearTimers(set) {
    if (!set) return
    for (const t of set) clearTimeout(t)
    set.clear()
  },
  safeCall(fn) {
    try {
      return fn?.()
    } catch {}
    return null
  },
  emitAquaError(aqua, error) {
    if (!aqua?.listenerCount) return
    try {
      if (aqua.listenerCount(AqualinkEvents.Error) > 0) {
        aqua.emit(AqualinkEvents.Error, error)
      }
    } catch {}
  },
  emitIfActive(player, event, ...args) {
    if (!player.destroyed) player.aqua.emit(event, player, ...args)
  }
}

class MicrotaskUpdateBatcher {
  constructor(player) {
    this.player = player
    this.updates = null
    this.scheduled = false
  }

  batch(data, immediate) {
    if (!this.player) return Promise.reject(new Error('Player destroyed'))
    this.updates = Object.assign(this.updates || {}, data)
    if (immediate || 'track' in data || 'paused' in data || 'position' in data)
      return this._flush()
    if (!this.scheduled) {
      this.scheduled = true
      queueMicrotask(() => this._flush())
    }
    return Promise.resolve()
  }

  _flush() {
    const { player: p, updates: u } = this
    this.updates = null
    this.scheduled = false
    if (!u || !p) return Promise.resolve()
    return p.updatePlayer(u).catch((err) => {
      _functions.emitAquaError(
        p.aqua,
        new Error(`Update error: ${err.message}`)
      )
    })
  }

  reset() {
    this.updates = null
    this.scheduled = false
    this.player = null
  }
}

const batcherPool = {
  pool: [],
  acquire(player) {
    const b = this.pool.pop()
    if (b) {
      b.player = player
      return b
    }
    return new MicrotaskUpdateBatcher(player)
  },
  release(batcher) {
    if (this.pool.length < BATCHER_POOL_SIZE && batcher) {
      batcher.reset()
      this.pool.push(batcher)
    }
  }
}

class CircularBuffer {
  constructor(size) {
    this.buffer = new Array(size)
    this.size = size
    this.index = 0
    this.count = 0
  }

  push(item) {
    if (!item) return
    this.buffer[this.index] = item
    this.index = (this.index + 1) % this.size
    if (this.count < this.size) this.count++
  }

  getLast() {
    return this.count
      ? this.buffer[(this.index - 1 + this.size) % this.size]
      : null
  }

  clear() {
    if (!this.count) return
    this.buffer.fill(undefined)
    this.count = this.index = 0
  }
}

class Player extends EventEmitter {
  static LOOP_MODES = LOOP_MODES
  static EVENT_HANDLERS = EVENT_HANDLERS

  constructor(aqua, nodes, options) {
    super()
    if (!aqua || !nodes || !options.guildId)
      throw new TypeError('Missing required parameters')

    this.aqua = aqua
    this.nodes = nodes
    this.guildId = String(options.guildId)
    this.textChannel = options.textChannel
    this.voiceChannel = options.voiceChannel
    this.playing = this.paused = this.connected = this.destroyed = false
    this.state = PLAYER_STATE.IDLE
    this.txId = 0
    this.isAutoplayEnabled = this.isAutoplay = false
    this.autoplaySeed = this.current = this.nowPlayingMessage = null
    this.position = this.timestamp = this.ping = 0
    this.deaf = options.deaf !== false
    this.mute = !!options.mute
    this.autoplayRetries = this.reconnectionRetries = 0
    this._voiceDownSince = 0
    attachPlayerLifecycleState(this, { resuming: !!options.resuming })
    this._voiceWatchdogTimer = null
    this._pendingTimers = new Set()
    this._reconnectTimers = null
    this._reconnectNonce = 0
    this._dataStore = null

    this.volume = _functions.clamp(options.defaultVolume || 100)
    this.loop = this._parseLoop(options.loop)

    const aquaOpts = aqua.options || {}
    this.shouldDeleteMessage = !!aquaOpts.shouldDeleteMessage
    this.leaveOnEnd = !!aquaOpts.leaveOnEnd

    this.connection = new Connection(this)
    this.filters = new Filters(this)
    this.queue = new Queue()
    this.previousIdentifiers = new Set()
    this.previousTracks = new CircularBuffer(PREVIOUS_TRACKS_SIZE)
    this._updateBatcher = batcherPool.acquire(this)
    this._lifecycleController = new PlayerLifecycle(this, {
      _functions,
      PLAYER_STATE,
      VOICE_TRACE_INTERVAL,
      PLAYER_UPDATE_SILENCE_THRESHOLD,
      VOICE_DOWN_THRESHOLD,
      VOICE_ABANDON_MULTIPLIER,
      VOICE_FORCE_DESTROY_MS,
      RECONNECT_MAX,
      MUTE_TOGGLE_DELAY,
      SEEK_DELAY,
      PAUSE_DELAY,
      RETRY_BACKOFF_BASE,
      RETRY_BACKOFF_MAX
    })

    this._voiceRequestAt = 0
    this._voiceRequestChannel = null
    this._suppressResumeUntil = 0
    this._lastVoiceUpTraceAt = 0
    this._lastPlayerUpdateAt = Date.now()
    this._voiceRecoverySeq = 0
    this._activeVoiceRecoveryToken = 0
    this._voiceRecoveryReason = null
    this._bindEvents()
    this._startWatchdog()
  }

  _parseLoop(loop) {
    if (typeof loop === 'string') {
      const idx = LOOP_MODE_NAMES.indexOf(loop)
      return idx >= 0 && idx <= 2 ? idx : 0
    }
    return loop >= 0 && loop <= 2 ? loop : 0
  }

  _bindEvents() {
    this._boundPlayerUpdate = this._handlePlayerUpdate.bind(this)
    this._boundEvent = this._handleEvent.bind(this)

    this.on('playerUpdate', this._boundPlayerUpdate)
    this.on('event', this._boundEvent)
  }

  _startWatchdog() {
    this._voiceWatchdogTimer = setInterval(
      () => this._voiceWatchdog(),
      WATCHDOG_INTERVAL
    )
    this._voiceWatchdogTimer.unref?.()
  }

  _createTimer(fn, delay, unref = true) {
    return _functions.createTimer(fn, delay, this._pendingTimers, unref)
  }

  _delay(ms) {
    return new Promise((r) => this._createTimer(r, ms))
  }

  _claimVoiceRecovery(reason = 'unknown') {
    const token = ++this._voiceRecoverySeq
    this._activeVoiceRecoveryToken = token
    this._voiceRecoveryReason = reason
    return token
  }

  _isVoiceRecoveryActive(token) {
    return !!token && !this.destroyed && this._activeVoiceRecoveryToken === token
  }

  _clearVoiceRecovery(token = this._activeVoiceRecoveryToken, reason = null) {
    if (!token || this._activeVoiceRecoveryToken !== token) return false
    this._activeVoiceRecoveryToken = 0
    this._voiceRecoveryReason = reason
    return true
  }

  _handlePlayerUpdate(packet) {
    return this._lifecycleController.handlePlayerUpdate(packet)
  }

  async _handleEvent(payload) {
    if (this.destroyed || !payload?.type) return
    const handler = EVENT_HANDLERS[payload.type]
    if (typeof this[handler] !== 'function') {
      this.aqua.emit(
        AqualinkEvents.NodeError,
        this,
        new Error(`Unknown event: ${payload.type}`)
      )
      return
    }
    try {
      await this[handler](this, this.current, payload)
    } catch (error) {
      _functions.emitAquaError(this.aqua, error)
    }
  }

  get previous() {
    return this.previousTracks?.getLast() || null
  }

  get currenttrack() {
    return this.current
  }

  getQueue() {
    return this.queue
  }

  batchUpdatePlayer(data, immediate) {
    return this._updateBatcher.batch(data, immediate)
  }

  setAutoplay(enabled) {
    this.isAutoplayEnabled = !!enabled
    this.autoplayRetries = 0
    return this
  }

  async play(track, options = {}) {
    if (this.destroyed || !this.queue) return this

    let item = track
    if (!item) {
      if (!this.queue.size) return this
      item = this.queue.dequeue()
    }

    if (!item) return this

    try {
      let resolvedItem = null
      if (item?.track) {
        resolvedItem = item
      } else if (typeof item?.resolve === 'function') {
        resolvedItem = await item.resolve(this.aqua)
      }
      this.current = resolvedItem
      if (this.destroyed) return this
      if (!this.current?.track) {
        this.current = null
        this.playing = false
        if (this.aqua?.debugTrace) {
          this.aqua._trace('player.play.unresolved', {
            guildId: this.guildId,
            reconnecting: !!this._reconnecting,
            resuming: !!this._resuming,
            voiceRecovering: !!this._voiceRecovering
          })
        }
        if (this._reconnecting || this._resuming || this._voiceRecovering)
          return this
        throw new Error('Failed to resolve track')
      }

      this.playing = true
      this.paused = !!options.paused
      this.position = options.startTime || 0
      if (this.aqua?.debugTrace) {
        this.aqua._trace('player.play', {
          guildId: this.guildId,
          paused: this.paused,
          startTime: this.position,
          hasTrack: !!this.current?.track
        })
      }

      if (this.destroyed || !this._updateBatcher) return this

      if (
        this.voiceChannel &&
        !this.connected &&
        !this._reconnecting &&
        !this._voiceRecovering
      ) {
        this._deferredStart = true
        const recoveryToken = this._claimVoiceRecovery('play_deferred')
        if (this.aqua?.debugTrace) {
          this.aqua._trace('player.play.deferred', {
            guildId: this.guildId,
            reason: 'voice_not_connected'
          })
        }
        const now = Date.now()
        if (
          now - (this._voiceRequestAt || 0) >= 1200 &&
          this._isVoiceRecoveryActive(recoveryToken)
        ) {
          this._voiceRequestAt = now
          if (this._isVoiceRecoveryActive(recoveryToken))
            this.connection?._requestVoiceState?.()
          if (this._isVoiceRecoveryActive(recoveryToken))
            this.connection?.resendVoiceUpdate?.(true)
          if (this._isVoiceRecoveryActive(recoveryToken))
            _functions.safeCall(() =>
              this.connect({
                guildId: this.guildId,
                voiceChannel: this.voiceChannel,
                deaf: this.deaf,
                mute: this.mute
              })
            )
        }
        return this
      }

      if (
        this.aqua?.autoRegionMigrate &&
        !this._resuming &&
        !this.connection?.endpoint
      ) {
        this._deferredStart = true
        if (this.aqua?.debugTrace) {
          this.aqua._trace('player.play.deferred', {
            guildId: this.guildId,
            reason: 'awaiting_voice_server_update'
          })
        }
        return this
      }

      const updateData = {
        track: { encoded: this.current.track },
        paused: this.paused
      }
      if (this.position > 0) updateData.position = this.position

      this._deferredStart = false
      await this.batchUpdatePlayer(updateData, true).catch((err) => {
        if (!this.destroyed) _functions.emitAquaError(this.aqua, err)
      })
    } catch (error) {
      if (
        !this.destroyed &&
        !this._reconnecting &&
        !this._resuming &&
        !this._voiceRecovering
      ) {
        _functions.emitAquaError(this.aqua, error)
      }
      if (
        this.queue?.size &&
        !track &&
        !this._reconnecting &&
        !this._resuming &&
        !this._voiceRecovering
      )
        return this.play()
    }
    return this
  }

  connect(options = {}) {
    if (this.destroyed) throw new Error('Cannot connect destroyed player')

    const voiceChannel = _functions.toId(
      options.voiceChannel || this.voiceChannel
    )
    if (!voiceChannel) throw new TypeError('Voice channel required')

    this.deaf = options.deaf !== undefined ? !!options.deaf : true
    this.mute = !!options.mute
    this.destroyed = false
    this.state = PLAYER_STATE.CONNECTING

    this.txId++
    this._voiceRequestChannel = voiceChannel

    this.voiceChannel = voiceChannel
    this._voiceDownSince = 0
    this.send({
      guild_id: this.guildId,
      channel_id: voiceChannel,
      self_deaf: this.deaf,
      self_mute: this.mute
    })
    if (this.aqua?.debugTrace) {
      this.aqua._trace('player.connect.request', {
        guildId: this.guildId,
        txId: this.txId,
        voiceChannel,
        deaf: this.deaf,
        mute: this.mute
      })
    }
    return this
  }

  _shouldAttemptVoiceRecovery() {
    if (
      this.nodes?.info?.isNodelink ||
      this.destroyed ||
      !this.voiceChannel ||
      this.connected ||
      this._reconnecting ||
      this._voiceRecovering
    )
      return false
    if (
      !this._voiceDownSince ||
      Date.now() - this._voiceDownSince < VOICE_DOWN_THRESHOLD
    )
      return false
    return this.reconnectionRetries < RECONNECT_MAX
  }

  async _voiceWatchdog() {
    return this._lifecycleController.voiceWatchdog()
  }

  destroy(options = {}) {
    const {
      preserveClient = true,
      skipRemote = false,
      preserveMessage = false,
      preserveReconnecting = false,
      preserveTracks = false
    } = options
    if (this.destroyed && !this.queue) {
      this._reconnectNonce++
      if (this._reconnectTimers) {
        _functions.clearTimers(this._reconnectTimers)
        this._reconnectTimers = null
      }
      this._reconnecting = false
      this._isActivelyReconnecting = false
      return this
    }

    if (!this.destroyed) {
      this._reconnectNonce++
      this.destroyed = true
      this._clearVoiceRecovery(undefined, 'destroyed')
      if (this.aqua?.debugTrace) {
        this.aqua._trace('player.destroy', {
          guildId: this.guildId,
          skipRemote: !!skipRemote,
          preserveTracks: !!preserveTracks,
          preserveReconnecting: !!preserveReconnecting
        })
      }
      this.emit('destroy')
    }

    if (this._voiceWatchdogTimer) {
      clearInterval(this._voiceWatchdogTimer)
      this._voiceWatchdogTimer = null
    }

    _functions.clearTimers(this._pendingTimers)
    this._pendingTimers = null

    // Clear reconnection timers to prevent memory leaks when destroyed externally
    if (this._reconnectTimers) {
      _functions.clearTimers(this._reconnectTimers)
      this._reconnectTimers = null
    }

    this.connected = this.playing = this.paused = this.isAutoplay = false
    this._deferredStart = false
    this.state = PLAYER_STATE.DESTROYED
    this.autoplayRetries = this.reconnectionRetries = 0
    if (!preserveReconnecting) this._reconnecting = false
    this._lastVoiceChannel = this.voiceChannel
    this._lastTextChannel = this.textChannel
    this.voiceChannel = null
    this._isActivelyReconnecting = false

    if (
      this.shouldDeleteMessage &&
      this.nowPlayingMessage &&
      !preserveMessage
    ) {
      _functions.safeDel(this.nowPlayingMessage)
      this.nowPlayingMessage = null
    }

    if (this._boundPlayerUpdate)
      this.removeListener('playerUpdate', this._boundPlayerUpdate)
    if (this._boundEvent) this.removeListener('event', this._boundEvent)
    this._boundPlayerUpdate = this._boundEvent = null
    this.removeAllListeners()

    if (this._updateBatcher) {
      batcherPool.release(this._updateBatcher)
      this._updateBatcher = null
    }

    if (this.filters) {
      try {
        this.filters.destroy()
      } catch (error) {
        reportSuppressedError(this, 'player.destroy.filters', error, {
          guildId: this.guildId
        })
      }
    }

    this.previousTracks?.clear()
    this.previousTracks = null
    this.previousIdentifiers?.clear()
    this.previousIdentifiers = null
    this.queue?.clear()
    this.queue = null
    this._dataStore?.clear()
    this._dataStore = null

    if (
      this.current?.dispose &&
      !this.aqua?.options?.autoResume &&
      !preserveTracks
    )
      this.current.dispose()
    if (this.connection) {
      try {
        this.connection.destroy()
      } catch (error) {
        reportSuppressedError(this, 'player.destroy.connection', error, {
          guildId: this.guildId
        })
      }
    }
    this.connection =
      this.filters =
      this.current =
      this.autoplaySeed =
      this._lifecycleController =
        null

    if (!skipRemote) {
      try {
        this.send({ guild_id: this.guildId, channel_id: null })
        this.aqua?.destroyPlayer?.(this.guildId)
        if (this.nodes?.connected)
          this.nodes.rest?.destroyPlayer(this.guildId).catch((error) =>
            reportSuppressedError(this, 'player.destroy.remote', error, {
              guildId: this.guildId
            })
          )
      } catch (error) {
        reportSuppressedError(this, 'player.destroy.gateway', error, {
          guildId: this.guildId
        })
      }
    }

    if (!preserveClient) this.aqua = this.nodes = null
    return this
  }

  pause(paused) {
    if (this.destroyed || this.paused === !!paused) return this
    this.paused = !!paused
    this.batchUpdatePlayer({ paused: this.paused }, true).catch((error) =>
      reportSuppressedError(this, 'player.pause', error, {
        guildId: this.guildId,
        paused: this.paused
      })
    )
    return this
  }

  seek(position) {
    if (this.destroyed || !this.playing || !_functions.isNum(position))
      return this
    const len = this.current?.info?.length || 0
    const clamped = len
      ? Math.min(Math.max(position, 0), len)
      : Math.max(position, 0)
    this.position = clamped
    this.batchUpdatePlayer({ position: clamped }, true).catch((error) =>
      reportSuppressedError(this, 'player.seek', error, {
        guildId: this.guildId,
        position: clamped
      })
    )
    return this
  }

  async getActiveMixer(guildId) {
    if (this.destroyed) return null
    return await this.nodes.rest.getActiveMixer(guildId)
  }

  async updateMixerVolume(guildId, mix, volume) {
    if (this.destroyed) return null
    return await this.nodes.rest.updateMixerVolume(guildId, mix, volume)
  }

  async removeMixer(guildId, mix) {
    if (this.destroyed) return null
    return await this.nodes.rest.removeMixer(guildId, mix)
  }

  async addMixer(guildId, options) {
    if (this.destroyed) return null

    if (options.identifier && !options.encoded) {
      try {
        const resolved = await this.aqua.resolve({
          query: options.identifier,
          requester: options.requester || this.current?.requester
        })

        if (resolved?.tracks?.[0]) {
          const track = resolved.tracks[0]
          options = {
            ...options,
            encoded: track.track || track.encoded,
            userData: options.userData
          }
        } else {
          throw new Error('Failed to resolve track identifier')
        }
      } catch (error) {
        throw new Error(`Failed to resolve track: ${error.message}`)
      }
    }

    return await this.nodes.rest.addMixer(guildId, options)
  }

  stop() {
    if (this.destroyed || !this.playing) return this
    this.playing = this.paused = false
    this.position = 0
    this.batchUpdatePlayer(
      { track: { encoded: null }, paused: this.paused },
      true
    ).catch((error) =>
      reportSuppressedError(this, 'player.stop', error, {
        guildId: this.guildId
      })
    )
    return this
  }

  setVolume(volume) {
    const vol = _functions.clamp(volume)
    if (this.destroyed || this.volume === vol) return this
    this.volume = vol
    this.batchUpdatePlayer({ volume: vol }).catch((error) =>
      reportSuppressedError(this, 'player.setVolume', error, {
        guildId: this.guildId,
        volume: vol
      })
    )
    return this
  }

  setLoop(mode) {
    if (this.destroyed) return this
    const idx = typeof mode === 'string' ? LOOP_MODE_NAMES.indexOf(mode) : mode
    if (idx < 0 || idx > 2) throw new Error('Invalid loop mode')
    this.loop = idx
    return this
  }

  setTextChannel(channel) {
    if (this.destroyed) return this
    const id = _functions.toId(channel)
    if (!id) throw new TypeError('Invalid text channel')
    this.textChannel = id
    return this
  }

  setVoiceChannel(channel) {
    if (this.destroyed) return this
    const id = _functions.toId(channel)
    if (!id) throw new TypeError('Voice channel required')
    if (this.connected && id === _functions.toId(this.voiceChannel)) return this
    this.voiceChannel = id
    this.connect({
      deaf: this.deaf,
      guildId: this.guildId,
      voiceChannel: id,
      mute: this.mute
    })
    return this
  }

  disconnect() {
    if (this.destroyed || !this.connected) return this
    this.connected = false
    this.voiceChannel = null
    this.send({ guild_id: this.guildId, channel_id: null })
    return this
  }

  shuffle() {
    if (this.destroyed || !this.queue?.size) return this
    this.queue.shuffle()
    return this
  }

  replay() {
    return this.seek(0)
  }
  skip(target) {
    if (this.destroyed || !this.playing) return this

    if (target === undefined || target === null) return this.stop()

    if (typeof target === 'number') {
      const idx = target | 0
      if (idx <= 0) return this.stop()
      if (!this.queue?.size || idx >= this.queue.size) return this.stop()
      for (let i = 0; i < idx; i++) this.queue.dequeue()
      return this.stop()
    }

    const targetId = _functions.toId(target)
    if (targetId && this.queue?.size) {
      const arr = this.queue.toArray()
      const idx = arr.findIndex(
        (t) =>
          _functions.toId(t) === targetId ||
          _functions.toId(t?.info?.identifier) === targetId
      )
      if (idx > 0) {
        for (let i = 0; i < idx; i++) this.queue.dequeue()
      }
    }
    return this.stop()
  }

  async getLyrics(options = {}) {
    if (this.destroyed || !this.nodes?.rest) return null
    const { query, useCurrentTrack = true, skipTrackSource = false } = options
    if (query)
      return this.nodes.rest.getLyrics({
        track: { info: { title: query } },
        skipTrackSource
      })
    if (useCurrentTrack && this.playing && this.current) {
      const info = this.current.info
      return this.nodes.rest.getLyrics({
        track: {
          info,
          encoded: this.current.track,
          identifier: info.identifier,
          guild_id: this.guildId
        },
        skipTrackSource
      })
    }
    return null
  }

  getLoadLyrics(encodedTrack) {
    return this.destroyed || !this.nodes?.rest
      ? null
      : this.nodes.rest.getLoadLyrics(encodedTrack)
  }

  subscribeLiveLyrics() {
    return this.destroyed
      ? Promise.reject(new Error('Player destroyed'))
      : this.nodes?.rest?.subscribeLiveLyrics(this.guildId, false)
  }

  unsubscribeLiveLyrics() {
    return this.destroyed
      ? Promise.reject(new Error('Player destroyed'))
      : this.nodes?.rest?.unsubscribeLiveLyrics(this.guildId)
  }

  async autoplay() {
    if (
      this.destroyed ||
      !this.isAutoplayEnabled ||
      !this.previous ||
      this.queue?.size
    )
      return this
    const prev = this.previous
    const info = prev?.info
    if (!info?.sourceName || !info.identifier) return this
    const { sourceName, identifier, uri, author } = info
    this.isAutoplay = true

    if (sourceName === 'spotify' && info.identifier) {
      this.previousIdentifiers.add(info.identifier)
      if (this.previousIdentifiers.size > PREVIOUS_IDS_MAX) {
        this.previousIdentifiers.delete(
          this.previousIdentifiers.values().next().value
        )
      }
      if (!this.autoplaySeed) {
        this.autoplaySeed = {
          trackId: identifier,
          artistIds: Array.isArray(author) ? author.join(',') : author
        }
      }
    }

    for (
      let i = 0;
      !this.destroyed && i < AUTOPLAY_MAX && this.queue && !this.queue.size;
      i++
    ) {
      try {
        const track = await this._getAutoplayTrack(
          sourceName,
          identifier,
          uri,
          prev.requester
        )
        if (this.destroyed || !this.queue) return this
        if (track?.info?.title) {
          this.autoplayRetries = 0
          track.requester = prev.requester || { id: 'Unknown' }
          this.queue.add(track)
          await this.play()
          return this
        }
      } catch (err) {
        if (this.destroyed) return this
        _functions.emitAquaError(
          this.aqua,
          new Error(`Autoplay ${i + 1} fail: ${err.message}`)
        )
      }
    }

    if (this.destroyed) return this
    this.aqua?.emit(
      AqualinkEvents.AutoplayFailed,
      this,
      new Error('Max retries')
    )
    this.stop()
    return this
  }

  async liveLyrics(guildId, state) {
    if (state) return await this.nodes.rest.subscribeLiveLyrics(guildId)
    else return await this.nodes.rest.unsubscribeLiveLyrics(guildId)
  }

  async _getAutoplayTrack(sourceName, identifier, uri, requester) {
    if (sourceName === 'youtube' || sourceName === 'ytmusic') {
      const res = await this.aqua.resolve({
        query: `https://www.youtube.com/watch?v=${identifier}&list=RD${identifier}`,
        source: 'ytmsearch',
        requester
      })
      return _functions.isInvalidLoad(res)
        ? null
        : res.tracks[_functions.randIdx(res.tracks.length)]
    }
    if (sourceName === 'soundcloud') {
      const scRes = await scAutoPlay(uri)
      if (!scRes?.length) return null
      const res = await this.aqua.resolve({
        query: scRes[0],
        source: 'scsearch',
        requester
      })
      return _functions.isInvalidLoad(res)
        ? null
        : res.tracks[_functions.randIdx(res.tracks.length)]
    }
    if (sourceName === 'spotify') {
      const res = await spAutoPlay(
        this.autoplaySeed,
        this,
        requester,
        Array.from(this.previousIdentifiers)
      )
      return res?.length ? res[_functions.randIdx(res.length)] : null
    }
    return null
  }

  trackStart(_player, _track, payload = {}) {
    if (this.destroyed) return
    const startedTrack = this.current || _track
    if (!startedTrack) return
    if (!this.current) this.current = startedTrack
    this.playing = true
    this.paused = false
    this.aqua.emit(AqualinkEvents.TrackStart, this, startedTrack, {
      ...payload,
      resumed: this._resuming
    })
    this._resuming = false
  }

  async trackEnd(_player, track, payload) {
    if (this.destroyed) return

    const reason = payload?.reason
    const isFailure = reason === 'loadFailed'
    const isCleanup = reason === 'cleanup'
    const isReplaced = reason === 'replaced'

    if (track) this.previousTracks.push(track)
    if (isReplaced) return
    if (this.shouldDeleteMessage && !this._reconnecting && !this._resuming)
      _functions.safeDel(this.nowPlayingMessage)
    if (!isReplaced) this.current = null

    if (isFailure || isCleanup) {
      if (!this.queue.size || isCleanup) {
        this.clearData({ preserveTracks: this._reconnecting || this._resuming })
        this.aqua.emit(AqualinkEvents.QueueEnd, this)
      } else {
        this.aqua.emit(AqualinkEvents.TrackEnd, this, track, reason)
        await this.play()
      }
      return
    }

    if (track && reason === 'finished') {
      if (this.loop === LOOP_MODES.TRACK) {
        this.aqua.emit(AqualinkEvents.TrackEnd, this, track, reason)
        await this.play(track)
        return
      }
      if (this.loop === LOOP_MODES.QUEUE) {
        this.queue.add(track)
      }
    }

    if (this.queue.size) {
      if (!isReplaced)
        this.aqua.emit(AqualinkEvents.TrackEnd, this, track, reason)
      await this.play()
    } else if (this.isAutoplayEnabled && !isReplaced) {
      await this.autoplay()
    } else {
      this.playing = false
      if (this.leaveOnEnd && !this.destroyed) {
        this.clearData({ preserveTracks: this._reconnecting || this._resuming })
        this.destroy()
      }
      this.aqua.emit(AqualinkEvents.QueueEnd, this)
    }
  }

  trackError(_player, track, payload) {
    if (this.destroyed) return
    this.aqua.emit(AqualinkEvents.TrackError, this, track, payload)
    this.stop()
  }

  trackStuck(_player, track, payload) {
    if (this.destroyed) return
    this.aqua.emit(AqualinkEvents.TrackStuck, this, track, payload)
    this.stop()
  }

  trackChange(_p, t, payload) {
    _functions.emitIfActive(this, AqualinkEvents.TrackChange, t, payload)
  }
  lyricsLine(_p, t, payload) {
    _functions.emitIfActive(this, AqualinkEvents.LyricsLine, t, payload)
  }
  volumeChanged(_p, t, payload) {
    _functions.emitIfActive(this, AqualinkEvents.VolumeChanged, t, payload)
  }
  filtersChanged(_p, t, payload) {
    _functions.emitIfActive(this, AqualinkEvents.FiltersChanged, t, payload)
  }
  seekEvent(_p, t, payload) {
    _functions.emitIfActive(this, AqualinkEvents.Seek, t, payload)
  }
  lyricsFound(_p, t, payload) {
    _functions.emitIfActive(this, AqualinkEvents.LyricsFound, t, payload)
  }
  lyricsNotFound(_p, t, payload) {
    _functions.emitIfActive(this, AqualinkEvents.LyricsNotFound, t, payload)
  }
  playerCreated(_p, _t, payload) {
    _functions.emitIfActive(this, AqualinkEvents.PlayerCreated, payload)
  }
  playerConnected(_p, _t, payload) {
    _functions.emitIfActive(this, AqualinkEvents.PlayerConnected, payload)
  }
  playerDestroyed(_p, _t, payload) {
    _functions.emitIfActive(this, AqualinkEvents.PlayerDestroyed, payload)
  }
  pauseEvent(_p, _t, payload) {
    _functions.emitIfActive(this, AqualinkEvents.PauseEvent, payload)
  }
  mixStarted(_p, t, payload) {
    _functions.emitIfActive(this, AqualinkEvents.MixStarted, t, payload)
  }
  mixEnded(_p, t, payload) {
    _functions.emitIfActive(this, AqualinkEvents.MixEnded, t, payload)
  }

  async _attemptVoiceResume() {
    return this._lifecycleController.attemptVoiceResume()
  }

  async socketClosed(_player, _track, payload) {
    return this._lifecycleController.socketClosed(_player, _track, payload)
  }

  send(data) {
    try {
      if (this.aqua?.queueVoiceStateUpdate) {
        return this.aqua.queueVoiceStateUpdate(data)
      } else {
        this.aqua.send({ op: 4, d: data })
        return true
      }
    } catch (err) {
      _functions.emitAquaError(
        this.aqua,
        new Error(`Send fail: ${err.message}`)
      )
      return false
    }
  }

  set(key, value) {
    if (this.destroyed) return
    if (!this._dataStore) {
      this._dataStore = new Map()
    }
    this._dataStore.set(key, value)
  }

  get(key) {
    return this._dataStore?.get(key)
  }

  clearData(options = {}) {
    const { preserveTracks = false } = options
    this.previousTracks?.clear()
    this._dataStore?.clear()
    this.previousIdentifiers?.clear()
    if (this.current?.dispose && !preserveTracks) this.current.dispose()
    this.current = null
    this.position = this.timestamp = 0
    this.queue?.clear()
    return this
  }

  updatePlayer(data) {
    return this.nodes.rest.updatePlayer({ guildId: this.guildId, data })
  }

  _flushDeferredPlay() {
    return this._lifecycleController.flushDeferredPlay()
  }

  cleanup() {
    if (!this.playing && !this.paused && !this.queue?.size) this.destroy()
  }
}

module.exports = Player
