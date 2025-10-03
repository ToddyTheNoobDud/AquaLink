'use strict'

const {EventEmitter} = require('tseep')
const {AqualinkEvents} = require('./AqualinkEvents')
const Connection = require('./Connection')
const Filters = require('./Filters')
const {spAutoPlay, scAutoPlay} = require('../handlers/autoplay')
const Queue = require('./Queue')

const LOOP_MODES = Object.freeze({NONE: 0, TRACK: 1, QUEUE: 2})
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
  clamp: v => {
    const num = +v
    return Number.isNaN(num) ? 100 : num < 0 ? 0 : num > 200 ? 200 : num
  },
  randIdx: len => Math.random() * len | 0,
  toId: v => v?.id || v || null,
  isNum: v => typeof v === 'number' && !Number.isNaN(v),
  safeUnref: t => {
    if (t?.unref) {
      try {
        t.unref()
      } catch {}
    }
  },
  isInvalidLoad: r => !r?.tracks?.length || INVALID_LOADS.has(r.loadType),
  safeDel: msg => msg?.delete?.().catch(() => {})
}

class MicrotaskUpdateBatcher {
  constructor(player) {
    this.player = player
    this.updates = null
    this.scheduled = false
  }

  batch(data, immediate) {
    if (!this.player) return Promise.reject(new Error('Player destroyed'))
    if (!this.updates) this.updates = {}
    Object.assign(this.updates, data)
    if (immediate || 'track' in data || 'paused' in data || 'position' in data) {
      return this._flush()
    }
    if (!this.scheduled) {
      this.scheduled = true
      queueMicrotask(() => this._flush())
    }
    return Promise.resolve()
  }

  _flush() {
    const p = this.player
    const u = this.updates
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
    return this.count ? this.buffer[(this.index - 1 + this.size) % this.size] : null
  }

  clear() {
    if (!this.count) return
    this.buffer.fill(undefined)
    this.count = 0
    this.index = 0
  }

  toArray() {
    if (!this.count) return []
    const result = new Array(this.count)
    const start = this.count === this.size ? this.index : 0
    let idx = 0
    for (let i = 0; i < this.count; i++) {
      const item = this.buffer[(start + i) % this.size]
      if (item !== undefined) result[idx++] = item
    }
    result.length = idx
    return result
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
    this.playing = false
    this.paused = false
    this.connected = false
    this.destroyed = false
    this.isAutoplayEnabled = false
    this.isAutoplay = false
    this.autoplaySeed = null
    this.current = null
    this.position = 0
    this.timestamp = 0
    this.ping = 0
    this.nowPlayingMessage = null
    this.deaf = options.deaf !== false
    this.mute = !!options.mute
    this.autoplayRetries = 0
    this.reconnectionRetries = 0
    this._voiceDownSince = 0
    this._voiceRecovering = false
    this._reconnecting = false
    this._resuming = !!options.resuming
    this._voiceWatchdogTimer = null
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
    _functions.safeUnref(this._voiceWatchdogTimer)
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
        const t = setTimeout(() => {
          if (this.connected || this.destroyed) return
          this.connection.attemptResume()
        }, 1000)
        _functions.safeUnref(t)
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

  async play() {
    if (this.destroyed || !this.connected || !this.queue.size) return this
    const item = this.queue.dequeue()
    if (!item) return this
    try {
      this.current = item.track ? item : await item.resolve(this.aqua)
      if (!this.current?.track) throw new Error('Failed to resolve track')
      this.playing = true
      this.paused = false
      this.position = 0
      await this.batchUpdatePlayer({guildId: this.guildId, encodedTrack: this.current.track}, true)
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
    this.connected = true
    this.destroyed = false
    this.voiceChannel = voiceChannel
    this.send({
      guild_id: this.guildId,
      channel_id: voiceChannel,
      self_deaf: this.deaf,
      self_mute: this.mute
    })
    return this
  }

  _shouldAttemptVoiceRecovery() {
    if (this.destroyed) return false
    if (!this.voiceChannel) return false
    if (this.connected) return false
    if (!this._voiceDownSince) return false
    if (Date.now() - this._voiceDownSince < VOICE_DOWN_THRESHOLD) return false
    if (this._voiceRecovering) return false
    if (this.reconnectionRetries >= RECONNECT_MAX) return false
    return true
  }

  async _voiceWatchdog() {
    if (!this._shouldAttemptVoiceRecovery()) return

    const hasVoiceData = this.connection?.sessionId && this.connection?.endpoint && this.connection?.token
    if (!hasVoiceData) {
      const downDuration = Date.now() - this._voiceDownSince
      if (downDuration > VOICE_DOWN_THRESHOLD * VOICE_ABANDON_MULTIPLIER) {
        this.destroy()
      }
      return
    }

    this._voiceRecovering = true
    try {
      if (await this.connection.attemptResume()) {
        this.reconnectionRetries = 0
        this._voiceDownSince = 0
        return
      }

      const originalMute = this.mute
      this.send({guild_id: this.guildId, channel_id: this.voiceChannel, self_deaf: this.deaf, self_mute: !originalMute})
      await new Promise(r => setTimeout(r, MUTE_TOGGLE_DELAY))
      if (!this.destroyed) this.send({guild_id: this.guildId, channel_id: this.voiceChannel, self_deaf: this.deaf, self_mute: originalMute})
      this.connection.resendVoiceUpdate()
      this.reconnectionRetries++
    } catch {
      this.reconnectionRetries++
      if (this.reconnectionRetries >= RECONNECT_MAX) this.destroy()
    } finally {
      this._voiceRecovering = false
    }
  }

  destroy(options = {}) {
    const {preserveClient = true, skipRemote = false} = options

    if (this.destroyed && !this.queue) return this

    if (!this.destroyed) {
      this.destroyed = true
      this.emit('destroy')
    }

    if (this._voiceWatchdogTimer) {
      clearInterval(this._voiceWatchdogTimer)
      this._voiceWatchdogTimer = null
    }

    this.connected = this.playing = this.paused = this.isAutoplay = false
    this.autoplayRetries = this.reconnectionRetries = 0
    this._reconnecting = false
    this._lastVoiceChannel = this.voiceChannel
    this.voiceChannel = null

    if (this.shouldDeleteMessage && this.nowPlayingMessage) {
      _functions.safeDel(this.nowPlayingMessage)
      this.nowPlayingMessage = null
    }

    this.removeListener('playerUpdate', this._boundPlayerUpdate)
    this.removeListener('event', this._boundEvent)
    if (this.aqua && this._boundPlayerMove) {
      this.aqua.removeListener('playerMove', this._boundPlayerMove)
    }
    this._boundPlayerUpdate = this._boundEvent = this._boundPlayerMove = null
    this.removeAllListeners()

    if (this._updateBatcher) {
      batcherPool.release(this._updateBatcher)
      this._updateBatcher = null
    }

    if (this.previousTracks) {
      this.previousTracks.clear()
      this.previousTracks = null
    }

    if (this.previousIdentifiers) {
      this.previousIdentifiers.clear()
      this.previousIdentifiers = null
    }

    if (this.queue) {
      this.queue.clear()
      this.queue = null
    }

    if (this._dataStore) {
      this._dataStore.clear()
      this._dataStore = null
    }

    if (this.current?.dispose) this.current.dispose()
    this.connection = this.filters = this.current = this.autoplaySeed = null

    if (!skipRemote) {
      try {
        this.send({guild_id: this.guildId, channel_id: null})
        this.aqua?.destroyPlayer?.(this.guildId)
        this.nodes?.connected && this.nodes.rest?.destroyPlayer(this.guildId).catch(() => {})
      } catch {}
    }

    if (!preserveClient) this.aqua = this.nodes = null
    return this
  }

  pause(paused) {
    if (this.destroyed || this.paused === !!paused) return this
    this.paused = !!paused
    this.batchUpdatePlayer({guildId: this.guildId, paused: this.paused}, true)
    return this
  }

  seek(position) {
    if (this.destroyed || !this.playing || !_functions.isNum(position)) return this
    const len = this.current?.info?.length || 0
    const pos = position === 0 ? 0 : this.position + position
    const clamped = len ? Math.min(Math.max(pos, 0), len) : Math.max(pos, 0)
    this.position = clamped
    this.batchUpdatePlayer({guildId: this.guildId, position: clamped}, true)
    return this
  }

  stop() {
    if (this.destroyed || !this.playing) return this
    this.playing = this.paused = false
    this.position = 0
    this.batchUpdatePlayer({guildId: this.guildId, encodedTrack: null}, true)
    return this
  }

  setVolume(volume) {
    const vol = _functions.clamp(volume)
    if (this.destroyed || this.volume === vol) return this
    this.volume = vol
    this.batchUpdatePlayer({guildId: this.guildId, volume: vol})
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
    this.batchUpdatePlayer({guildId: this.guildId, text_channel: id})
    return this
  }

  setVoiceChannel(channel) {
    if (this.destroyed) return this
    const id = _functions.toId(channel)
    if (!id) throw new TypeError('Voice channel required')
    if (this.connected && id === _functions.toId(this.voiceChannel)) return this
    this.voiceChannel = id
    this.connect({deaf: this.deaf, guildId: this.guildId, voiceChannel: id, mute: this.mute})
    return this
  }

  disconnect() {
    if (this.destroyed || !this.connected) return this
    this.connected = false
    this.voiceChannel = null
    this.send({guild_id: this.guildId, channel_id: null})
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
    for (let i = 0; i < len; i++) {
      this.queue.add(items[i])
    }
    return this
  }

  replay() {
    return this.seek(0)
  }

  skip() {
    return this.stop()
  }

  async getLyrics(options = {}) {
    if (this.destroyed || !this.nodes?.rest) return null
    const {query, useCurrentTrack = true, skipTrackSource = false} = options
    if (query) return this.nodes.rest.getLyrics({track: {info: {title: query}}, skipTrackSource})
    if (useCurrentTrack && this.playing && this.current) {
      const info = this.current.info
      return this.nodes.rest.getLyrics({
        track: {info, encoded: this.current.track, identifier: info.identifier, guild_id: this.guildId},
        skipTrackSource
      })
    }
    return null
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
    const {sourceName, identifier, uri, requester, author} = info
    this.isAutoplay = true

    if (sourceName === 'spotify' && prev.identifier) {
      this.previousIdentifiers.add(prev.identifier)
      if (this.previousIdentifiers.size > PREVIOUS_IDS_MAX) {
        this.previousIdentifiers.delete(this.previousIdentifiers.values().next().value)
      }
      if (!this.autoplaySeed) {
        this.autoplaySeed = {
          trackId: identifier,
          artistIds: Array.isArray(author) ? author.join(',') : author
        }
      }
    }

    for (let i = 0; !this.destroyed && i < AUTOPLAY_MAX && !this.queue.size; i++) {
      try {
        const track = await this._getAutoplayTrack(sourceName, identifier, uri, requester, prev)
        if (track?.info?.title) {
          this.autoplayRetries = 0
          track.requester = prev.requester || {id: 'Unknown'}
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
    switch (sourceName) {
      case 'youtube': {
        const res = await this.aqua.resolve({
          query: `https://www.youtube.com/watch?v=${identifier}&list=RD${identifier}`,
          source: 'ytmsearch',
          requester
        })
        return !_functions.isInvalidLoad(res) ? res.tracks[_functions.randIdx(res.tracks.length)] : null
      }
      case 'soundcloud': {
        const scRes = await scAutoPlay(uri)
        if (scRes?.length) {
          const res = await this.aqua.resolve({query: scRes[0], source: 'scsearch', requester})
          return !_functions.isInvalidLoad(res) ? res.tracks[_functions.randIdx(res.tracks.length)] : null
        }
        return null
      }
      case 'spotify': {
        const res = await spAutoPlay(this.autoplaySeed, this, requester, Array.from(this.previousIdentifiers))
        return res?.length ? res[_functions.randIdx(res.length)] : null
      }
      default:
        return null
    }
  }

  async trackStart(player, track) {
    if (this.destroyed) return
    this.playing = true
    this.paused = false
    this.aqua.emit(AqualinkEvents.TrackStart, this, track)
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

    if (track && reason === 'finished') {
      const shouldRepeat = this.loop === LOOP_MODES.TRACK || this.loop === LOOP_MODES.QUEUE
      if (shouldRepeat) this.queue.add(track)
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

  async trackError(player, track, payload) {
    if (this.destroyed) return
    this.aqua.emit(AqualinkEvents.TrackError, this, track, payload)
    this.stop()
  }

  async trackStuck(player, track, payload) {
    if (this.destroyed) return
    this.aqua.emit(AqualinkEvents.TrackStuck, this, track, payload)
    this.stop()
  }

  async trackChange(player, track, payload) {
    if (this.destroyed) return
    this.aqua.emit(AqualinkEvents.TrackChange, this, track, payload)
  }

  async _attemptVoiceResume() {
    if (!this.connection?.sessionId) throw new Error('No session')
    if (!await this.connection.attemptResume()) throw new Error('Resume failed')
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('playerUpdate', onUpdate)
        reject(new Error('No confirmation'))
      }, RESUME_TIMEOUT)
      const onUpdate = payload => {
        if (payload?.state?.connected || _functions.isNum(payload?.state?.time)) {
          clearTimeout(timeout)
          this.off('playerUpdate', onUpdate)
          resolve()
        }
      }
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

    if (code === 4015) {
      try {
        await this._attemptVoiceResume()
        return
      } catch {}
    }

    if (![4015, 4009, 4006].includes(code)) {
      this.aqua.emit(AqualinkEvents.SocketClosed, this, payload)
      return
    }

    if (this._reconnecting) return

    const aqua = this.aqua
    const vcId = _functions.toId(this.voiceChannel)

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
    this.destroy({preserveClient: true, skipRemote: true})

    const tryReconnect = async attempt => {
      try {
        const np = await aqua.createConnection({
          guildId: this.guildId,
          voiceChannel: vcId,
          textChannel: _functions.toId(this.textChannel),
          deaf: this.deaf,
          mute: this.mute,
          defaultVolume: state.volume
        })

        if (!np) throw new Error('Failed to create player')

        np.reconnectionRetries = 0
        np.loop = state.loop
        np.isAutoplayEnabled = state.isAutoplayEnabled
        np.autoplaySeed = state.autoplaySeed
        np.previousIdentifiers = new Set(state.previousIdentifiers)

        const ct = state.currentTrack
        if (ct) np.queue.add(ct)

        const q = state.queue
        for (let i = 0; i < q.length; i++) {
          if (q[i] !== ct) np.queue.add(q[i])
        }

        if (ct) {
          await np.play()
          if (state.position > 5000) {
            setTimeout(() => !np.destroyed && np.seek(state.position), SEEK_DELAY)
          }
          if (state.paused) {
            setTimeout(() => !np.destroyed && np.pause(true), PAUSE_DELAY)
          }
        }

        this._reconnecting = false
        aqua.emit(AqualinkEvents.PlayerReconnected, np, {oldPlayer: this, restoredState: state})
      } catch (error) {
        const retriesLeft = RECONNECT_MAX - attempt
        aqua.emit(AqualinkEvents.ReconnectionFailed, this, {error, code, payload, retriesLeft})

        if (retriesLeft > 0) {
          setTimeout(() => tryReconnect(attempt + 1), Math.min(RETRY_BACKOFF_BASE * attempt, RETRY_BACKOFF_MAX))
        } else {
          this._reconnecting = false
          aqua.emit(AqualinkEvents.SocketClosed, this, payload)
        }
      }
    }

    tryReconnect(1)
  }

  async lyricsLine(player, track, payload) {
    if (this.destroyed) return
    this.aqua.emit(AqualinkEvents.LyricsLine, this, track, payload)
  }

  async lyricsFound(player, track, payload) {
    if (this.destroyed) return
    this.aqua.emit(AqualinkEvents.LyricsFound, this, track, payload)
  }

  async lyricsNotFound(player, track, payload) {
    if (this.destroyed) return
    this.aqua.emit(AqualinkEvents.LyricsNotFound, this, track, payload)
  }

  _handleAquaPlayerMove(oldChannel, newChannel) {
    if (_functions.toId(oldChannel) !== _functions.toId(this.voiceChannel)) return
    this.voiceChannel = _functions.toId(newChannel)
    this.connected = !!newChannel
    this.send({guild_id: this.guildId, channel_id: this.voiceChannel, self_deaf: this.deaf, self_mute: this.mute})
  }

  send(data) {
    try {
      this.aqua.send({op: 4, d: data})
    } catch (err) {
      this.aqua.emit(AqualinkEvents.Error, new Error(`Send fail: ${err.message}`))
    }
  }

  set(key, value) {
    if (this.destroyed) return
    if (!this._dataStore) this._dataStore = new Map()
    this._dataStore.set(key, value)
  }

  get(key) {
    return this.destroyed || !this._dataStore ? undefined : this._dataStore.get(key)
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
    return this.nodes.rest.updatePlayer({guildId: this.guildId, data})
  }

  async cleanup() {
    if (!this.playing && !this.paused && !this.queue?.size) this.destroy()
  }
}

module.exports = Player
