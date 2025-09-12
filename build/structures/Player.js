'use strict'

const { EventEmitter } = require('tseep')
const { AqualinkEvents } = require('./AqualinkEvents')
const Connection = require('./Connection')
const Queue = require('./Queue')
const Filters = require('./Filters')
const { spAutoPlay, scAutoPlay } = require('../handlers/autoplay')

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
  LyricsNotFoundEvent: 'lyricsNotFound',
  SegmentsLoaded: 'segmentsLoaded',
  SegmentSkipped: 'segmentSkipped',
  ChapterStarted: 'chapterStarted',
  ChaptersLoaded: 'chaptersLoaded'
})

const WATCHDOG_INTERVAL = 15000
const VOICE_DOWN_THRESHOLD = 10000
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
const INVALID_LOADS = new Set(['error', 'empty', 'LOAD_FAILED', 'NO_MATCHES'])

const SPONSOR_BLOCK_CATEGORIES = Object.freeze({
  SPONSOR: 'sponsor',
  SELFPROMO: 'selfpromo', 
  INTERACTION: 'interaction',
  INTRO: 'intro',
  OUTRO: 'outro',
  PREVIEW: 'preview',
  MUSIC_OFFTOPIC: 'music_offtopic',
  FILLER: 'filler'
})

const _functions = {
  clamp: v => (v = +v, v !== v ? 100 : v < 0 ? 0 : v > 200 ? 200 : v),
  randIdx: len => (Math.random() * len) | 0,
  toId: v => v?.id || v || null,
  isNum: v => typeof v === 'number' && v === v,
  noop: () => {},
  safeUnref: t => { if (t?.unref) try { t.unref() } catch {} },
  isInvalidLoad: r => !r?.tracks?.length || INVALID_LOADS.has(r.loadType),
  safeDel: msg => { if (msg?.delete) msg.delete().catch(_functions.noop) }
}

class MicrotaskUpdateBatcher {
  constructor(player) {
    this.player = player
    this.updates = null
    this.scheduled = 0
    this.flush = this._flush.bind(this)
  }

  batch(data, immediate) {
    const p = this.player
    if (!p) return Promise.reject(new Error('Player destroyed'))
    this.updates || (this.updates = Object.create(null))
    Object.assign(this.updates, data)
    if (immediate || data.track || data.paused !== undefined || data.position !== undefined) {
      this.scheduled = 0
      return this._flush()
    }
    if (!this.scheduled) {
      this.scheduled = 1
      queueMicrotask(this.flush)
    }
    return Promise.resolve()
  }

  _flush() {
    const p = this.player
    const u = this.updates
    if (!u || !p) {
      this.updates = null
      this.scheduled = 0
      return Promise.resolve()
    }
    this.updates = null
    this.scheduled = 0
    return p.updatePlayer(u).catch(err => {
      try { p.aqua?.emit?.(AqualinkEvents.Error, new Error(`Update error: ${err.message}`)) } catch {}
      throw err
    })
  }

  destroy() {
    this.updates = this.scheduled = this.player = this.flush = null
  }
}

class CircularBuffer {
  constructor(size = PREVIOUS_TRACKS_SIZE) {
    this.buffer = new Array(size)
    this.size = size
    this.index = this.count = 0
  }

  push(item) {
    if (!item) return
    this.buffer[this.index] = item
    this.index = (this.index + 1) % this.size
    this.count < this.size && this.count++
  }

  getLast() {
    return this.count ? this.buffer[(this.index - 1 + this.size) % this.size] : null
  }

  clear() {
    if (!this.count) return
    this.buffer.fill(null, 0, this.count)
    this.count = this.index = 0
  }

  toArray() {
    if (!this.count) return []
    const result = new Array(this.count)
    const start = this.count === this.size ? this.index : 0
    let idx = 0
    for (let i = 0; i < this.count; ++i) {
      const item = this.buffer[(start + i) % this.size]
      if (item) result[idx++] = item
    }
    result.length = idx
    return result
  }
}

class Player extends EventEmitter {
  static LOOP_MODES = LOOP_MODES
  static EVENT_HANDLERS = EVENT_HANDLERS
  static SPONSOR_BLOCK_CATEGORIES = SPONSOR_BLOCK_CATEGORIES

  constructor(aqua, nodes, options = {}) {
    super()
    if (!aqua || !nodes || !options.guildId) throw new TypeError('Missing required parameters')

    Object.assign(this, {
      aqua, nodes, guildId: options.guildId, textChannel: options.textChannel,
      voiceChannel: options.voiceChannel, playing: false, paused: false, connected: false,
      destroyed: false, isAutoplayEnabled: false, isAutoplay: false, autoplaySeed: null,
      current: null, position: 0, timestamp: 0, ping: 0, nowPlayingMessage: null,
      deaf: options.deaf !== false, mute: !!options.mute, autoplayRetries: 0,
      reconnectionRetries: 0, _voiceDownSince: 0, _voiceRecovering: false
    })

    this.sponsorBlockEnabled = options.sponsorBlockEnabled || aqua.sponsorBlock || false
    this.sponsorBlockCategories = options.sponsorBlockCategories || aqua.sponsorBlockCategories || []
    this.segments = []
    this.chapters = []
    this.currentSegment = null
    this.currentChapter = null

    this.volume = _functions.clamp(+options.defaultVolume || 100)
    this.loop = this._parseLoop(options.loop)

    const aquaOpts = aqua.options || {}
    this.shouldDeleteMessage = !!aquaOpts.shouldDeleteMessage
    this.leaveOnEnd = !!aquaOpts.leaveOnEnd

    this.connection = new Connection(this)
    this.filters = new Filters(this)
    this.queue = new Queue()
    this.previousIdentifiers = new Set()
    this.previousTracks = new CircularBuffer(50)
    this._updateBatcher = new MicrotaskUpdateBatcher(this)
    this._dataStore = null
    this._bindEvents()
    this._startWatchdog()
  }

  _parseLoop(loop) {
    const idx = typeof loop === 'string' ? LOOP_MODE_NAMES.indexOf(loop) : loop
    return idx >= 0 && idx <= 2 ? idx : 0
  }

  _bindEvents() {
    this._boundPlayerUpdate = this._handlePlayerUpdate.bind(this)
    this._boundEvent = this._handleEvent.bind(this)
    this._boundAquaPlayerMove = this._handleAquaPlayerMove.bind(this)
    this.on('playerUpdate', this._boundPlayerUpdate)
    this.on('event', this._boundEvent)
    this.aqua.on('playerMove', this._boundAquaPlayerMove)
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
        setTimeout(() => !this.connected && !this.destroyed && this.connection.attemptResume(), 1000)
      }
    } else {
      this._voiceDownSince = 0
    }
    this.aqua.emit(AqualinkEvents.PlayerUpdate, this, packet)
  }

  async _handleEvent(payload) {
    if (this.destroyed || !payload?.type) return
    const handler = this[EVENT_HANDLERS[payload.type]]
    if (typeof handler !== 'function') {
      this.aqua.emit(AqualinkEvents.NodeError, this, new Error(`Unknown event: ${payload.type}`))
      return
    }
    try {
      await handler.call(this, this, this.current, payload)
    } catch (error) {
      this.aqua.emit(AqualinkEvents.Error, error)
    }
  }

  get previous() { return this.previousTracks?.getLast() || null }
  get currenttrack() { return this.current }
  getQueue() { return this.queue }

  batchUpdatePlayer(data, immediate) {
    return this._updateBatcher.batch(data, immediate)
  }

  setAutoplay(enabled) {
    this.isAutoplayEnabled = !!enabled
    this.autoplayRetries = 0
    return this
  }

  setSponsorBlock(enabled, categories) {
    if (this.destroyed) return this
    this.sponsorBlockEnabled = !!enabled
    if (Array.isArray(categories)) {
      this.sponsorBlockCategories = categories
    }

    this.batchUpdatePlayer({ 
      guildId: this.guildId,
      sponsorBlockEnabled: this.sponsorBlockEnabled,
      sponsorBlockCategories: this.sponsorBlockCategories
    })
    return this
  }

  getSponsorBlockSegments() {
    return this.segments || []
  }

  getChapters() {
    return this.chapters || []
  }

  getCurrentSegment() {
    if (!this.segments?.length || !this.position) return null
    return this.segments.find(segment => 
      this.position >= segment.start && this.position <= segment.end
    ) || null
  }

  getCurrentChapter() {
    if (!this.chapters?.length || !this.position) return null
    return this.chapters.find(chapter => 
      this.position >= chapter.start && 
      (!chapter.end || this.position <= chapter.end)
    ) || null
  }

  skipCurrentSegment() {
    if (this.destroyed) return this
    const segment = this.getCurrentSegment()
    if (segment && segment.end) {
      this.seek(segment.end + 100) 
    }
    return this
  }

  async play() {
    if (this.destroyed || !this.connected || !this.queue?.size) return this
    const item = this.queue.shift()
    if (!item) return this
    try {
      this.current = item.track ? item : await item.resolve(this.aqua)
      if (!this.current?.track) throw new Error('Failed to resolve track')
      this.playing = true
      this.paused = false
      this.position = 0
      
      this.segments = []
      this.chapters = []
      this.currentSegment = null
      this.currentChapter = null
      
      await this.batchUpdatePlayer({ guildId: this.guildId, encodedTrack: this.current.track }, true)
      return this
    } catch (error) {
      this.aqua.emit(AqualinkEvents.Error, error)
      return this.queue?.size ? this.play() : this
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
      guild_id: options.guildId || this.guildId,
      channel_id: voiceChannel,
      self_deaf: this.deaf,
      self_mute: this.mute
    })
    return this
  }

  async _voiceWatchdog() {
    if (this.destroyed ||
        !this.voiceChannel ||
        this.connected ||
        !this._voiceDownSince ||
        (Date.now() - this._voiceDownSince) < VOICE_DOWN_THRESHOLD ||
        this._voiceRecovering ||
        this.reconnectionRetries >= 4) {
      return
    }

    const hasVoiceData = this.connection?.sessionId && this.connection?.endpoint && this.connection?.token
    if (!hasVoiceData) {
      if ((Date.now() - this._voiceDownSince) > VOICE_DOWN_THRESHOLD * 3) {
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
      this.send({
        guild_id: this.guildId,
        channel_id: this.voiceChannel,
        self_deaf: this.deaf,
        self_mute: !originalMute
      })

      await new Promise(resolve => setTimeout(resolve, MUTE_TOGGLE_DELAY))

      if (!this.destroyed) {
        this.send({
          guild_id: this.guildId,
          channel_id: this.voiceChannel,
          self_deaf: this.deaf,
          self_mute: originalMute
        })
      }

      this.connection.resendVoiceUpdate()
      this.reconnectionRetries++
    } catch (err) {
      this.reconnectionRetries++
      if (this.reconnectionRetries >= 4) {
        this.destroy()
      }
    } finally {
      this._voiceRecovering = false
    }
  }

  destroy({ preserveClient = true, skipRemote = false } = {}) {
    if (this.destroyed) return this

    this.destroyed = true

    if (this._voiceWatchdogTimer) {
      clearInterval(this._voiceWatchdogTimer)
      this._voiceWatchdogTimer = null
    }

    this.connected = this.playing = this.paused = this.isAutoplay = false
    this.autoplayRetries = this.reconnectionRetries = 0
    this.voiceChannel = null

    this.segments = []
    this.chapters = []
    this.currentSegment = null
    this.currentChapter = null

    if (this.shouldDeleteMessage && this.nowPlayingMessage) {
      this.nowPlayingMessage.delete()
      this.nowPlayingMessage = null
    }

    this.emit('destroy')
    this.removeAllListeners()

    if (this.aqua && this._boundAquaPlayerMove) {
      this.aqua.removeListener('playerMove', this._boundAquaPlayerMove)
    }

    this._updateBatcher?.destroy()
    this.connection?.destroy()
    this.queue?.clear()
    this.previousTracks?.clear()
    this.previousIdentifiers?.clear()

    this._updateBatcher = this.connection = this.queue = this.previousTracks = null
    this.previousIdentifiers = this.filters = this._dataStore = this.current = null
    this.autoplaySeed = this._boundPlayerUpdate = this._boundEvent = null
    this._boundAquaPlayerMove = null

    if (!skipRemote) {
      try {
        this.send({ guild_id: this.guildId, channel_id: null })
        this.aqua?.destroyPlayer?.(this.guildId)
        this.nodes?.connected && this.nodes?.rest?.destroyPlayer?.(this.guildId).catch(() => {})
      } catch (e) {}
    }

    if (!preserveClient) {
      this.aqua = null
      this.nodes = null
    }
    return this
  }

  pause(paused) {
    if (this.destroyed) return this
    const state = !!paused
    if (this.paused === state) return this
    this.paused = state
    this.batchUpdatePlayer({ guildId: this.guildId, paused: state }, true)
    return this
  }

  seek(position) {
    if (this.destroyed || !this.playing || !_functions.isNum(position)) return this

    const len = this.current?.info?.length || 0
    const pos = position === 0 ? 0 : this.position + position
    const clamped = len ? Math.min(Math.max(pos, 0), len) : Math.max(pos, 0)

    this.position = clamped
    this.batchUpdatePlayer({ guildId: this.guildId, position: clamped }, true)
    return this
  }

  stop() {
    if (this.destroyed || !this.playing) return this
    this.playing = this.paused = false
    this.position = 0
    
    this.segments = []
    this.chapters = []
    this.currentSegment = null
    this.currentChapter = null
    
    this.batchUpdatePlayer({ guildId: this.guildId, encodedTrack: null }, true)
    return this
  }

  setVolume(volume) {
    if (this.destroyed) return this
    const vol = _functions.clamp(volume)
    if (this.volume === vol) return this
    this.volume = vol
    this.batchUpdatePlayer({ guildId: this.guildId, volume: vol })
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
    this.batchUpdatePlayer({ guildId: this.guildId, text_channel: id })
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
    if (this.destroyed || !this.queue?.size) return this
    const items = this.queue.toArray()
    const len = items.length
    if (len <= 1) return this
    for (let i = len - 1; i > 0; --i) {
      const j = _functions.randIdx(i + 1)
      if (i !== j) [items[i], items[j]] = [items[j], items[i]]
    }
    this.queue.clear()
    for (let i = 0; i < len; ++i) this.queue.push(items[i])
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

  subscribeLiveLyrics() {
    return this.destroyed ? Promise.reject(new Error('Player destroyed')) : this.nodes?.rest?.subscribeLiveLyrics(this.guildId, false)
  }

  unsubscribeLiveLyrics() {
    return this.destroyed ? Promise.reject(new Error('Player destroyed')) : this.nodes?.rest?.unsubscribeLiveLyrics(this.guildId)
  }

  async autoplay() {
    if (this.destroyed || !this.isAutoplayEnabled || !this.previous || this.queue?.size) return this
    const prev = this.previous
    const info = prev?.info
    if (!info?.sourceName || !info.identifier) return this
    const { sourceName, identifier, uri, requester, author } = info
    this.isAutoplay = true
    if (sourceName === 'spotify' && prev?.identifier) {
      this.previousIdentifiers.add(prev.identifier)
      if (this.previousIdentifiers.size > PREVIOUS_IDS_MAX) {
        this.previousIdentifiers.delete(this.previousIdentifiers.values().next().value)
      }
      this.autoplaySeed || (this.autoplaySeed = {
        trackId: identifier,
        artistIds: Array.isArray(author) ? author.join(',') : author
      })
    }
    for (let i = 0; !this.destroyed && i < AUTOPLAY_MAX && !this.queue?.size; ++i) {
      try {
        const track = await this._getAutoplayTrack(sourceName, identifier, uri, requester, prev)
        if (track?.info?.title) {
          this.autoplayRetries = 0
          track.requester = prev.requester || { id: 'Unknown' }
          this.queue.push(track)
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

  async _getAutoplayTrack(sourceName, identifier, uri, requester, prev) {
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
          const res = await this.aqua.resolve({ query: scRes[0], source: 'scsearch', requester })
          return !_functions.isInvalidLoad(res) ? res.tracks[_functions.randIdx(res.tracks.length)] : null
        }
        return null
      }
      case 'spotify': {
        const res = await spAutoPlay(this.autoplaySeed, this, requester, Array.from(this.previousIdentifiers))
        return res?.length ? res[_functions.randIdx(res.length)] : null
      }
      default: return null
    }
  }

  async segmentsLoaded(player, track, payload) {
    if (this.destroyed) return
    this.segments = payload?.segments || []
    this.aqua.emit(AqualinkEvents.SponsorBlockSegmentsLoaded, this, track, payload)
  }

  async segmentSkipped(player, track, payload) {
    if (this.destroyed) return
    const segment = payload?.segment
    if (segment) {
      this.currentSegment = segment
      if (this.sponsorBlockEnabled && segment.end) {
        this.seek(segment.end + 100)
      }
    }
    this.aqua.emit(AqualinkEvents.SponsorBlockSegmentSkipped, this, track, payload)
  }

  async chapterStarted(player, track, payload) {
    if (this.destroyed) return
    this.currentChapter = payload?.chapter || null
    this.aqua.emit(AqualinkEvents.SponsorBlockChapterStarted, this, track, payload)
  }

  async chaptersLoaded(player, track, payload) {
    if (this.destroyed) return
    this.chapters = payload?.chapters || []
    this.aqua.emit(AqualinkEvents.SponsorBlockChaptersLoaded, this, track, payload)
  }

  async trackStart(player, track) {
    if (this.destroyed) return
    this.playing = true
    this.paused = false
    
    this.segments = []
    this.chapters = []
    this.currentSegment = null
    this.currentChapter = null
    
    this.aqua.emit(AqualinkEvents.TrackStart, this, track)
  }

  async trackEnd(player, track, payload) {
    if (this.destroyed) return
    track && this.previousTracks?.push(track)
    this.shouldDeleteMessage && _functions.safeDel(this.nowPlayingMessage)
    this.current = null
    
    this.segments = []
    this.chapters = []
    this.currentSegment = null
    this.currentChapter = null
    
    const reason = payload?.reason
    const isFailure = reason === 'loadFailed' || reason === 'cleanup'
    const isReplaced = reason === 'replaced'
    if (isFailure) {
      if (!this.queue?.size) {
        this.clearData()
        this.aqua.emit(AqualinkEvents.QueueEnd, this)
      } else {
        this.aqua.emit(AqualinkEvents.TrackEnd, this, track, reason)
        await this.play()
      }
      return
    }
    if (track && !isReplaced) {
      const l = this.loop
      if (l === 1) this.queue.unshift(track)
      else if (l === 2) this.queue.push(track)
    }
    if (this.queue?.size) {
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
    if (!this.destroyed) {
      this.aqua.emit(AqualinkEvents.TrackError, this, track, payload)
      this.stop()
    }
  }

  async trackStuck(player, track, payload) {
    if (!this.destroyed) {
      this.aqua.emit(AqualinkEvents.TrackStuck, this, track, payload)
      this.stop()
    }
  }

  async trackChange(player, track, payload) {
    !this.destroyed && this.aqua.emit(AqualinkEvents.TrackChange, this, track, payload)
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
      } catch (err) {}
    }
    if (![4015, 4009, 4006].includes(code)) {
      this.aqua.emit(AqualinkEvents.SocketClosed, this, payload)
      return
    }
    const aqua = this.aqua
    const vcId = _functions.toId(this.voiceChannel)
    if (!vcId) {
      aqua?.emit?.(AqualinkEvents.SocketClosed, this, payload)
      return
    }
    const state = {
      volume: this.volume, position: this.position, paused: this.paused, loop: this.loop,
      isAutoplayEnabled: this.isAutoplayEnabled, currentTrack: this.current,
      queue: this.queue?.toArray() || [], previousIdentifiers: [...this.previousIdentifiers],
      autoplaySeed: this.autoplaySeed, sponsorBlockEnabled: this.sponsorBlockEnabled,
      sponsorBlockCategories: [...this.sponsorBlockCategories]
    }
    this.destroy({ preserveClient: true, skipRemote: true })
    const tryReconnect = async attempt => {
      try {
        const np = await aqua.createConnection({
          guildId: this.guildId, voiceChannel: vcId, textChannel: _functions.toId(this.textChannel),
          deaf: this.deaf, mute: this.mute, defaultVolume: state.volume,
          sponsorBlockEnabled: state.sponsorBlockEnabled
        })
        if (!np) throw new Error('Failed to create player')
        np.reconnectionRetries = 0
        np.loop = state.loop
        np.isAutoplayEnabled = state.isAutoplayEnabled
        np.autoplaySeed = state.autoplaySeed
        np.previousIdentifiers = new Set(state.previousIdentifiers)
        np.sponsorBlockCategories = state.sponsorBlockCategories
        const ct = state.currentTrack
        ct && np.queue.unshift(ct)
        const q = state.queue
        for (let i = 0, len = q.length; i < len; ++i) {
          q[i] !== ct && np.queue.push(q[i])
        }
        if (ct) {
          await np.play()
          state.position > 5000 && setTimeout(() => !np.destroyed && np.seek(state.position), SEEK_DELAY)
          state.paused && setTimeout(() => !np.destroyed && np.pause(true), PAUSE_DELAY)
        }
        aqua.emit(AqualinkEvents.PlayerReconnected, np, { oldPlayer: this, restoredState: state })
      } catch (error) {
        const retriesLeft = RECONNECT_MAX - attempt
        aqua.emit(AqualinkEvents.ReconnectionFailed, this, { error, code, payload, retriesLeft })
        retriesLeft > 0
          ? setTimeout(() => tryReconnect(attempt + 1), Math.min(RETRY_BACKOFF_BASE * attempt, RETRY_BACKOFF_MAX))
          : aqua.emit(AqualinkEvents.SocketClosed, this, payload)
      }
    }
    tryReconnect(1)
  }

  async lyricsLine(player, track, payload) {
    !this.destroyed && this.aqua.emit(AqualinkEvents.LyricsLine, this, track, payload)
  }

  async lyricsFound(player, track, payload) {
    !this.destroyed && this.aqua.emit(AqualinkEvents.LyricsFound, this, track, payload)
  }

  async lyricsNotFound(player, track, payload) {
    !this.destroyed && this.aqua.emit(AqualinkEvents.LyricsNotFound, this, track, payload)
  }

  _handleAquaPlayerMove(oldChannel, newChannel) {
    try {
      if (_functions.toId(oldChannel) === _functions.toId(this.voiceChannel)) {
        this.voiceChannel = _functions.toId(newChannel)
        this.connected = !!newChannel
        this.send({
          guild_id: this.guildId, channel_id: this.voiceChannel,
          self_deaf: this.deaf, self_mute: this.mute
        })
      }
    } catch {}
  }

  send(data) {
    try { this.aqua.send({ op: 4, d: data }) }
    catch (err) { this.aqua.emit(AqualinkEvents.Error, new Error(`Send fail: ${err.message}`)) }
  }

  set(key, value) {
    if (this.destroyed) return
    this._dataStore || (this._dataStore = new Map())
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
    this.queue?.forEach(track => track?.dispose?.())
    this.queue?.clear()
    
    this.segments = []
    this.chapters = []
    this.currentSegment = null
    this.currentChapter = null
    
    return this
  }

  updatePlayer(data) {
    return this.nodes.rest.updatePlayer({ guildId: this.guildId, data })
  }

  async cleanup() {
    !this.playing && !this.paused && this.queue?.isEmpty?.() && this.destroy()
  }
}

module.exports = Player
