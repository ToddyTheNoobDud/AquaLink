'use strict'

const { EventEmitter } = require('tseep')
const { AqualinkEvents } = require('./AqualinkEvents')
const Connection = require('./Connection')
const Filters = require('./Filters')
const { spAutoPlay, scAutoPlay } = require('../handlers/autoplay')
const Queue = require('./Queue')

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
  pauseEvent: 'PauseEvent',
  PlayerConnectedEvent: 'playerConnected',
  PlayerDestroyedEvent: 'playerDestroyed',
  LyricsNotFoundEvent: 'lyricsNotFound'
})

const WATCHDOG_INTERVAL = 15000
const VOICE_DOWN_THRESHOLD = 10000
const VOICE_ABANDON_MULTIPLIER = 3
const RECONNECT_MAX = 3
const RESUME_TIMEOUT = 5000
const MUTE_TOGGLE_DELAY = 300
const SEEK_DELAY = 800
const PAUSE_DELAY = 1200
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
    return Number.isNaN(n) ? 100 : n < 0 ? 0 : n > 200 ? 200 : n
  },
  randIdx: len => Math.random() * len | 0,
  toId: v => v?.id || v || null,
  isNum: v => typeof v === 'number' && !Number.isNaN(v),
  isInvalidLoad: r => !r?.tracks?.length || INVALID_LOADS.has(r.loadType),
  safeDel: msg => msg?.delete?.().catch(() => { }),
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
    if (immediate || 'track' in data || 'paused' in data || 'position' in data) return this._flush()
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
    return p.updatePlayer(u).catch(err => {
      p.aqua?.emit?.(AqualinkEvents.Error, new Error(`Update error: ${err.message}`))
      throw err
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
    if (b) { b.player = player; return b }
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
    return this.count ? this.buffer[(this.index - 1 + this.size) % this.size] : null
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
    if (!aqua || !nodes || !options.guildId) throw new TypeError('Missing required parameters')

    this.aqua = aqua
    this.nodes = nodes
    this.guildId = options.guildId
    this.textChannel = options.textChannel
    this.voiceChannel = options.voiceChannel
    this.playing = this.paused = this.connected = this.destroyed = false
    this.isAutoplayEnabled = this.isAutoplay = false
    this.autoplaySeed = this.current = this.nowPlayingMessage = null
    this.position = this.timestamp = this.ping = 0
    this.deaf = options.deaf !== false
    this.mute = !!options.mute
    this.autoplayRetries = this.reconnectionRetries = 0
    this._voiceDownSince = 0
    this._voiceRecovering = this._reconnecting = false
    this._resuming = !!options.resuming
    this._voiceWatchdogTimer = null
    this._pendingTimers = new Set()
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
    this._boundPlayerMove = this._handleAquaPlayerMove.bind(this)

    this.on('playerUpdate', this._boundPlayerUpdate)
    this.on('event', this._boundEvent)
    this.aqua.on('playerMove', this._boundPlayerMove)
  }

  _startWatchdog() {
    this._voiceWatchdogTimer = setInterval(() => this._voiceWatchdog(), WATCHDOG_INTERVAL)
    this._voiceWatchdogTimer.unref?.()
  }

  _createTimer(fn, delay, unref = true) {
    return _functions.createTimer(fn, delay, this._pendingTimers, unref)
  }

  _delay(ms) {
    return new Promise(r => this._createTimer(r, ms))
  }

  _handlePlayerUpdate(packet) {
    if (this.destroyed || !packet?.state) return
    const s = packet.state
    this.position = _functions.isNum(s.position) ? s.position : 0
    this.connected = !!s.connected
    this.ping = _functions.isNum(s.ping) ? s.ping : 0
    this.timestamp = _functions.isNum(s.time) ? s.time : Date.now()

    if (!this.connected) {
      if (!this._voiceDownSince) {
        this._voiceDownSince = Date.now()
        this._createTimer(() => {
          if (this.connected || this.destroyed || this.nodes?.info?.isNodelink) return
          this.connection.attemptResume()
        }, 1000)
      }
    } else {
      this._voiceDownSince = 0
    }

    this.aqua.emit(AqualinkEvents.PlayerUpdate, this, packet)
  }

  async _handleEvent(payload) {
    if (this.destroyed || !payload?.type) return
    const handler = EVENT_HANDLERS[payload.type]
    if (typeof this[handler] !== 'function') {
      this.aqua.emit(AqualinkEvents.NodeError, this, new Error(`Unknown event: ${payload.type}`))
      return
    }
    try {
      await this[handler](this, this.current, payload)
    } catch (error) {
      this.aqua.emit(AqualinkEvents.Error, error)
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

  async _waitForConnection(timeout = RESUME_TIMEOUT) {
    if (this.destroyed) return
    if (this.connected) return
    return new Promise((resolve, reject) => {
      let timer
      const cleanup = () => {
        if (timer) { this._pendingTimers?.delete(timer); clearTimeout(timer) }
        this.off('playerUpdate', onUpdate)
      }
      const onUpdate = payload => {
        if (this.destroyed) { cleanup(); return reject(new Error('Player destroyed')) }
        if (payload?.state?.connected || _functions.isNum(payload?.state?.time)) {
          cleanup()
          return resolve()
        }
      }
      this.on('playerUpdate', onUpdate)
      timer = this._createTimer(() => { cleanup(); reject(new Error('No connection confirmation')) }, timeout)
    })
  }

  async play() {
    if (this.destroyed || !this.queue.size) return this
    if (!this.connected) {
      try {
        await this._waitForConnection(RESUME_TIMEOUT)
        if (!this.connected || this.destroyed) return this
      } catch {
        return this
      }
    }

    const item = this.queue.dequeue()
    if (!item) return this
    try {
      this.current = item.track ? item : await item.resolve(this.aqua)
      if (!this.current?.track) throw new Error('Failed to resolve track')
      this.playing = true
      this.paused = false
      this.position = 0
      await this.batchUpdatePlayer({ guildId: this.guildId, track: { encoded: this.current.track } }, true)
      return this
    } catch (error) {
      this.aqua.emit(AqualinkEvents.Error, error)
      return this.queue.size ? this.play() : this
    }
  }

  connect(options = {}) {
    if (this.destroyed) throw new Error('Cannot connect destroyed player')
    const voiceChannel = _functions.toId(options.voiceChannel || this.voiceChannel)
    if (!voiceChannel) throw new TypeError('Voice channel required')
    this.deaf = options.deaf !== undefined ? !!options.deaf : true
    this.mute = !!options.mute
    this.destroyed = false
    this.voiceChannel = voiceChannel
    this.send({ guild_id: this.guildId, channel_id: voiceChannel, self_deaf: this.deaf, self_mute: this.mute })
    return this
  }

  _shouldAttemptVoiceRecovery() {
    if (this.nodes?.info?.isNodelink || this.destroyed || !this.voiceChannel || this.connected) return false
    if (!this._voiceDownSince || Date.now() - this._voiceDownSince < VOICE_DOWN_THRESHOLD) return false
    return !this._voiceRecovering && this.reconnectionRetries < RECONNECT_MAX
  }

  async _voiceWatchdog() {
    if (!this._shouldAttemptVoiceRecovery()) return

    const hasVoiceData = this.connection?.sessionId && this.connection?.endpoint && this.connection?.token
    if (!hasVoiceData) {
      if ((Date.now() - this._voiceDownSince) > (VOICE_DOWN_THRESHOLD * VOICE_ABANDON_MULTIPLIER)) this.destroy()
      return
    }

    this._voiceRecovering = true
    try {
      if (await this.connection.attemptResume()) {
        this.reconnectionRetries = this._voiceDownSince = 0
        return
      }
      const originalMute = this.mute
      this.send({ guild_id: this.guildId, channel_id: this.voiceChannel, self_deaf: this.deaf, self_mute: !originalMute })
      await this._delay(MUTE_TOGGLE_DELAY)
      if (!this.destroyed) {
        this.send({ guild_id: this.guildId, channel_id: this.voiceChannel, self_deaf: this.deaf, self_mute: originalMute })
      }
      this.connection.resendVoiceUpdate()
      this.reconnectionRetries++
    } catch {
      if (++this.reconnectionRetries >= RECONNECT_MAX) this.destroy()
    } finally {
      this._voiceRecovering = false
    }
  }

  destroy(options = {}) {
    const { preserveClient = true, skipRemote = false } = options
    if (this.destroyed && !this.queue) return this

    if (!this.destroyed) {
      this.destroyed = true
      this.emit('destroy')
    }

    if (this._voiceWatchdogTimer) {
      clearInterval(this._voiceWatchdogTimer)
      this._voiceWatchdogTimer = null
    }

    _functions.clearTimers(this._pendingTimers)
    this._pendingTimers = null

    this.connected = this.playing = this.paused = this.isAutoplay = false
    this.autoplayRetries = this.reconnectionRetries = 0
    this._reconnecting = false
    this._lastVoiceChannel = this.voiceChannel
    this.voiceChannel = null

    if (this.shouldDeleteMessage && this.nowPlayingMessage) {
      _functions.safeDel(this.nowPlayingMessage)
      this.nowPlayingMessage = null
    }

    if (this._boundPlayerUpdate) this.removeListener('playerUpdate', this._boundPlayerUpdate)
    if (this._boundEvent) this.removeListener('event', this._boundEvent)
    if (this.aqua && this._boundPlayerMove) this.aqua.removeListener('playerMove', this._boundPlayerMove)
    this._boundPlayerUpdate = this._boundEvent = this._boundPlayerMove = null
    this.removeAllListeners()

    if (this._updateBatcher) {
      batcherPool.release(this._updateBatcher)
      this._updateBatcher = null
    }

    this.previousTracks?.clear()
    this.previousTracks = null
    this.previousIdentifiers?.clear()
    this.previousIdentifiers = null
    this.queue?.clear()
    this.queue = null
    this._dataStore?.clear()
    this._dataStore = null

    if (this.current?.dispose && !this.aqua?.options?.autoResume) this.current.dispose()
    this.connection = this.filters = this.current = this.autoplaySeed = null

    if (!skipRemote) {
      try {
        this.send({ guild_id: this.guildId, channel_id: null })
        this.aqua?.destroyPlayer?.(this.guildId)
        if (this.nodes?.connected) this.nodes.rest?.destroyPlayer(this.guildId).catch(() => { })
      } catch { }
    }

    if (!preserveClient) this.aqua = this.nodes = null
    return this
  }

  pause(paused) {
    if (this.destroyed || this.paused === !!paused) return this
    this.paused = !!paused
    this.batchUpdatePlayer({ guildId: this.guildId, paused: this.paused }, true).catch(() => { })
    return this
  }

  seek(position) {
    if (this.destroyed || !this.playing || !_functions.isNum(position)) return this
    const len = this.current?.info?.length || 0
    const clamped = len ? Math.min(Math.max(position, 0), len) : Math.max(position, 0)
    this.position = clamped
    this.batchUpdatePlayer({ guildId: this.guildId, position: clamped }, true).catch(() => { })
    return this
  }

  stop() {
    if (this.destroyed || !this.playing) return this
    this.playing = this.paused = false
    this.position = 0
    this.batchUpdatePlayer({ guildId: this.guildId, track: { encoded: null } }, true).catch(() => { })
    return this
  }

  setVolume(volume) {
    const vol = _functions.clamp(volume)
    if (this.destroyed || this.volume === vol) return this
    this.volume = vol
    this.batchUpdatePlayer({ guildId: this.guildId, volume: vol }).catch(() => { })
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
    this.batchUpdatePlayer({ guildId: this.guildId, text_channel: id }).catch(() => { })
    return this
  }

  setVoiceChannel(channel) {
    if (this.destroyed) return this
    const id = _functions.toId(channel)
    if (!id) throw new TypeError('Voice channel required')
    if (this.connected && id === _functions.toId(this.voiceChannel)) return this
    this.voiceChannel = id
    this.connect({ deaf: this.deaf, guildId: this.guildId, voiceChannel: id, mute: this.mute })
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
    if (this.destroyed || !this.queue.size) return this
    const items = this.queue.toArray()
    const len = items.length
    if (len <= 1) return this
    for (let i = len - 1; i > 0; i--) {
      const j = _functions.randIdx(i + 1)
      if (i !== j) [items[i], items[j]] = [items[j], items[i]]
    }
    this.queue.clear()
    for (let i = 0; i < len; i++) this.queue.add(items[i])
    return this
  }

  replay() { return this.seek(0) }
  skip() { return this.stop() }

  async getLyrics(options = {}) {
    if (this.destroyed || !this.nodes?.rest) return null
    const { query, useCurrentTrack = true, skipTrackSource = false } = options
    if (query) return this.nodes.rest.getLyrics({ track: { info: { title: query } }, skipTrackSource })
    if (useCurrentTrack && this.playing && this.current) {
      const info = this.current.info
      return this.nodes.rest.getLyrics({
        track: { info, encoded: this.current.track, identifier: info.identifier, guild_id: this.guildId },
        skipTrackSource
      })
    }
    return null
  }

  getLoadLyrics(encodedTrack) {
    return (this.destroyed || !this.nodes?.rest) ? null : this.nodes.rest.getLoadLyrics(encodedTrack)
  }

  subscribeLiveLyrics() {
    return this.destroyed ? Promise.reject(new Error('Player destroyed')) : this.nodes?.rest?.subscribeLiveLyrics(this.guildId, false)
  }

  unsubscribeLiveLyrics() {
    return this.destroyed ? Promise.reject(new Error('Player destroyed')) : this.nodes?.rest?.unsubscribeLiveLyrics(this.guildId)
  }

  async autoplay() {
    if (this.destroyed || !this.isAutoplayEnabled || !this.previous || this.queue.size) return this
    const prev = this.previous
    const info = prev?.info
    if (!info?.sourceName || !info.identifier) return this
    const { sourceName, identifier, uri, author } = info
    this.isAutoplay = true

    if (sourceName === 'spotify' && info.identifier) {
      this.previousIdentifiers.add(info.identifier)
      if (this.previousIdentifiers.size > PREVIOUS_IDS_MAX) {
        this.previousIdentifiers.delete(this.previousIdentifiers.values().next().value)
      }
      if (!this.autoplaySeed) {
        this.autoplaySeed = { trackId: identifier, artistIds: Array.isArray(author) ? author.join(',') : author }
      }
    }

    for (let i = 0; !this.destroyed && i < AUTOPLAY_MAX && !this.queue.size; i++) {
      try {
        const track = await this._getAutoplayTrack(sourceName, identifier, uri, prev.requester)
        if (track?.info?.title) {
          this.autoplayRetries = 0
          track.requester = prev.requester || { id: 'Unknown' }
          this.queue.add(track)
          await this.play()
          return this
        }
      } catch (err) {
        this.aqua.emit(AqualinkEvents.Error, new Error(`Autoplay ${i + 1} fail: ${err.message}`))
      }
    }

    this.aqua.emit(AqualinkEvents.AutoplayFailed, this, new Error('Max retries'))
    this.stop()
    return this
  }

  async _getAutoplayTrack(sourceName, identifier, uri, requester) {
    if (sourceName === 'youtube') {
      const res = await this.aqua.resolve({
        query: `https://www.youtube.com/watch?v=${identifier}&list=RD${identifier}`,
        source: 'ytmsearch',
        requester
      })
      return _functions.isInvalidLoad(res) ? null : res.tracks[_functions.randIdx(res.tracks.length)]
    }
    if (sourceName === 'soundcloud') {
      const scRes = await scAutoPlay(uri)
      if (!scRes?.length) return null
      const res = await this.aqua.resolve({ query: scRes[0], source: 'scsearch', requester })
      return _functions.isInvalidLoad(res) ? null : res.tracks[_functions.randIdx(res.tracks.length)]
    }
    if (sourceName === 'spotify') {
      const res = await spAutoPlay(this.autoplaySeed, this, requester, Array.from(this.previousIdentifiers))
      return res?.length ? res[_functions.randIdx(res.length)] : null
    }
    return null
  }

  trackStart() {
    if (this.destroyed) return
    this.playing = true
    this.paused = false
    this.aqua.emit(AqualinkEvents.TrackStart, this, this.current)
  }

  async trackEnd(player, track, payload) {
    if (this.destroyed) return

    const reason = payload?.reason
    const isFailure = reason === 'loadFailed' || reason === 'cleanup'
    const isReplaced = reason === 'replaced'

    if (track) this.previousTracks.push(track)
    if (this.shouldDeleteMessage) _functions.safeDel(this.nowPlayingMessage)
    this.current = null

    if (isFailure) {
      if (!this.queue.size) {
        this.clearData()
        this.aqua.emit(AqualinkEvents.QueueEnd, this)
      } else {
        this.aqua.emit(AqualinkEvents.TrackEnd, this, track, reason)
        await this.play()
      }
      return
    }

    if (track && reason === 'finished' && (this.loop === LOOP_MODES.TRACK || this.loop === LOOP_MODES.QUEUE)) {
      this.queue.add(track)
    }

    if (this.queue.size) {
      this.aqua.emit(AqualinkEvents.TrackEnd, this, track, reason)
      await this.play()
    } else if (this.isAutoplayEnabled && !isReplaced) {
      await this.autoplay()
    } else {
      this.playing = false
      if (this.leaveOnEnd && !this.destroyed) {
        this.clearData()
        this.destroy()
      }
      this.aqua.emit(AqualinkEvents.QueueEnd, this)
    }
  }

  trackError(player, track, payload) {
    if (this.destroyed) return
    this.aqua.emit(AqualinkEvents.TrackError, this, track, payload)
    this.stop()
  }

  trackStuck(player, track, payload) {
    if (this.destroyed) return
    this.aqua.emit(AqualinkEvents.TrackStuck, this, track, payload)
    this.stop()
  }

  trackChange(p, t, payload) { _functions.emitIfActive(this, AqualinkEvents.TrackChange, t, payload) }
  lyricsLine(p, t, payload) { _functions.emitIfActive(this, AqualinkEvents.LyricsLine, t, payload) }
  volumeChanged(p, t, payload) { _functions.emitIfActive(this, AqualinkEvents.VolumeChanged, t, payload) }
  filtersChanged(p, t, payload) { _functions.emitIfActive(this, AqualinkEvents.FiltersChanged, t, payload) }
  seekEvent(p, t, payload) { _functions.emitIfActive(this, AqualinkEvents.Seek, t, payload) }
  lyricsFound(p, t, payload) { _functions.emitIfActive(this, AqualinkEvents.LyricsFound, t, payload) }
  lyricsNotFound(p, t, payload) { _functions.emitIfActive(this, AqualinkEvents.LyricsNotFound, t, payload) }
  playerCreated(p, t, payload) { _functions.emitIfActive(this, AqualinkEvents.PlayerCreated, payload) }
  playerConnected(p, t, payload) { _functions.emitIfActive(this, AqualinkEvents.PlayerConnected, payload) }
  playerDestroyed(p, t, payload) { _functions.emitIfActive(this, AqualinkEvents.PlayerDestroyed, payload) }
  PauseEvent(p, t, payload) { _functions.emitIfActive(this, AqualinkEvents.PauseEvent, payload) }

  async _attemptVoiceResume() {
    if (!this.connection?.sessionId) throw new Error('No session')
    if (!await this.connection.attemptResume()) throw new Error('Resume failed')
    return new Promise((resolve, reject) => {
      let timeout
      const cleanup = () => {
        if (timeout) { this._pendingTimers?.delete(timeout); clearTimeout(timeout) }
        this.off('playerUpdate', onUpdate)
      }
      const onUpdate = payload => {
        if (payload?.state?.connected || _functions.isNum(payload?.state?.time)) {
          cleanup()
          resolve()
        }
      }
      timeout = this._createTimer(() => { cleanup(); reject(new Error('No confirmation')) }, RESUME_TIMEOUT)
      this.on('playerUpdate', onUpdate)
    })
  }

  async socketClosed(player, track, payload) {
    if (this.destroyed) return
    const code = payload?.code

    if (code === 4022) {
      this.aqua.emit(AqualinkEvents.SocketClosed, this, payload)
      this.destroy()
      return
    }

    if (code === 4015 && !this.nodes?.info?.isNodelink) {
      try { await this._attemptVoiceResume(); return } catch { }
    }

    if (![4015, 4009, 4006].includes(code)) {
      this.aqua.emit(AqualinkEvents.SocketClosed, this, payload)
      return
    }

    if (this._reconnecting) return

    const aqua = this.aqua
    const vcId = _functions.toId(this.voiceChannel)
    const tcId = _functions.toId(this.textChannel)
    const { guildId, deaf, mute } = this

    if (!vcId) {
      aqua?.emit?.(AqualinkEvents.SocketClosed, this, payload)
      return
    }

    const state = {
      volume: this.volume,
      position: this.position,
      paused: this.paused,
      loop: this.loop,
      isAutoplayEnabled: this.isAutoplayEnabled,
      currentTrack: this.current,
      queue: this.queue?.toArray() || [],
      previousIdentifiers: Array.from(this.previousIdentifiers),
      autoplaySeed: this.autoplaySeed
    }

    this._reconnecting = true
    this.destroy({ preserveClient: true, skipRemote: true })

    const reconnectTimers = new Set()
    const tryReconnect = async attempt => {
      if (aqua?.destroyed) { _functions.clearTimers(reconnectTimers); return }
      try {
        const np = await aqua.createConnection({
          guildId, voiceChannel: vcId, textChannel: tcId, deaf, mute, defaultVolume: state.volume
        })
        if (!np) throw new Error('Failed to create player')

        np.reconnectionRetries = 0
        np.loop = state.loop
        np.isAutoplayEnabled = state.isAutoplayEnabled
        np.autoplaySeed = state.autoplaySeed
        np.previousIdentifiers = new Set(state.previousIdentifiers)

        const ct = state.currentTrack
        if (ct) np.queue.add(ct)
        for (const q of state.queue) if (q !== ct) np.queue.add(q)

        if (ct) {
          await np.play()
          if (state.position > 5000) np._createTimer(() => !np.destroyed && np.seek(state.position), SEEK_DELAY)
          if (state.paused) np._createTimer(() => !np.destroyed && np.pause(true), PAUSE_DELAY)
        }

        _functions.clearTimers(reconnectTimers)
        this._reconnecting = false
        aqua.emit(AqualinkEvents.PlayerReconnected, np, { oldPlayer: this, restoredState: state })
      } catch (error) {
        const retriesLeft = RECONNECT_MAX - attempt
        aqua.emit(AqualinkEvents.ReconnectionFailed, this, { error, code, payload, retriesLeft })

        if (retriesLeft > 0) {
          _functions.createTimer(
            () => tryReconnect(attempt + 1),
            Math.min(RETRY_BACKOFF_BASE * attempt, RETRY_BACKOFF_MAX),
            reconnectTimers
          )
        } else {
          _functions.clearTimers(reconnectTimers)
          this._reconnecting = false
          aqua.emit(AqualinkEvents.SocketClosed, this, payload)
        }
      }
    }

    tryReconnect(1)
  }

  _handleAquaPlayerMove(oldChannel, newChannel) {
    if (_functions.toId(oldChannel) !== _functions.toId(this.voiceChannel)) return
    this.voiceChannel = _functions.toId(newChannel)
    this.connected = !!newChannel
    this.send({ guild_id: this.guildId, channel_id: this.voiceChannel, self_deaf: this.deaf, self_mute: this.mute })
  }

  send(data) {
    try {
      this.aqua.send({ op: 4, d: data })
    } catch (err) {
      this.aqua.emit(AqualinkEvents.Error, new Error(`Send fail: ${err.message}`))
    }
  }

  set(key, value) {
    if (this.destroyed) return
    (this._dataStore || (this._dataStore = new Map())).set(key, value)
  }

  get(key) {
    return this._dataStore?.get(key)
  }

  clearData() {
    this.previousTracks?.clear()
    this._dataStore?.clear()
    this.previousIdentifiers?.clear()
    if (this.current?.dispose) this.current.dispose()
    this.current = null
    this.position = this.timestamp = 0
    this.queue?.clear()
    return this
  }

  updatePlayer(data) {
    return this.nodes.rest.updatePlayer({ guildId: this.guildId, data })
  }

  cleanup() {
    if (!this.playing && !this.paused && !this.queue?.size) this.destroy()
  }
}

module.exports = Player
