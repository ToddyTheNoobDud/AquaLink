const fs = require('node:fs')
const path = require('node:path')
const _readline = require('node:readline')
const { EventEmitter } = require('node:events')
const { AqualinkEvents } = require('./AqualinkEvents')
const AquaRecovery = require('./AquaRecovery')
const Node = require('./Node')
const Player = require('./Player')
const Track = require('./Track')
const { reportSuppressedError } = require('./Reporting')
const { version: pkgVersion } = require('../../package.json')

const SEARCH_PREFIX = ':'
const EMPTY_ARRAY = Object.freeze([])
const EMPTY_TRACKS_RESPONSE = Object.freeze({
  loadType: 'empty',
  exception: null,
  playlistInfo: null,
  pluginInfo: {},
  tracks: EMPTY_ARRAY
})

const MAX_CONCURRENT_OPS = 10
const BROKEN_PLAYER_TTL = 300000
const FAILOVER_CLEANUP_TTL = 600000
const PLAYER_BATCH_SIZE = 20
const RECONNECT_DELAY = 400
const CACHE_VALID_TIME = 12000
const NODE_TIMEOUT = 30000
const MAX_CACHE_SIZE = 20
const MAX_FAILOVER_QUEUE = 50
const MAX_REBUILD_LOCKS = 100
const WRITE_BUFFER_SIZE = 100
const TRACE_BUFFER_SIZE = 3000
const VOICE_STATE_QUEUE_INTERVAL = 900

const DEFAULT_OPTIONS = Object.freeze({
  shouldDeleteMessage: false,
  defaultSearchPlatform: 'ytsearch',
  leaveOnEnd: false,
  restVersion: 'v4',
  plugins: [],
  autoResume: true,
  infiniteReconnects: true,
  loadBalancer: 'leastLoad',
  useHttp2: false,
  debugTrace: false,
  traceMaxEntries: TRACE_BUFFER_SIZE,
  traceSink: null,
  autoRegionMigrate: false,
  failoverOptions: Object.freeze({
    enabled: true,
    maxRetries: 3,
    retryDelay: 1000,
    preservePosition: true,
    resumePlayback: true,
    cooldownTime: 5000,
    maxFailoverAttempts: 5
  }),
  maxQueueSave: 10,
  maxTracksRestore: 20,
  trackResolveConcurrency: 4,
  brokenPlayerStorePath: null
})

const _functions = {
  delay: (ms) =>
    new Promise((r) => {
      const t = setTimeout(r, ms)
      t.unref?.()
    }),
  noop: () => {},
  isUrl: (query) => {
    if (typeof query !== 'string' || query.length <= 8) return false
    const q = query.trimStart()
    return q.startsWith('http://') || q.startsWith('https://')
  },
  formatQuery(query, source) {
    return this.isUrl(query) ? query : `${source}${SEARCH_PREFIX}${query}`
  },
  makeTrack: (t, requester, node) => new Track(t, requester, node),
  safeCall(fn) {
    try {
      const result = fn()
      return result?.then ? result.catch(this.noop) : result
    } catch {}
  },
  parseRequester(str) {
    if (!str || typeof str !== 'string') return null
    const i = str.indexOf(':')
    return i > 0
      ? { id: str.substring(0, i), username: str.substring(i + 1) }
      : null
  },
  unrefTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  }
}

class Aqua extends EventEmitter {
  constructor(client, nodes, options = {}) {
    super()
    if (!client) throw new Error('Client is required')
    if (!Array.isArray(nodes) || !nodes.length)
      throw new TypeError('Nodes must be non-empty Array')

    this.client = client
    this.nodes = nodes
    this.nodeMap = new Map()
    this.players = new Map()
    this.clientId = null
    this.initiated = false
    this.version = pkgVersion

    const merged = { ...DEFAULT_OPTIONS, ...options }
    this.options = merged
    this.failoverOptions = {
      ...DEFAULT_OPTIONS.failoverOptions,
      ...options.failoverOptions
    }

    this.shouldDeleteMessage = merged.shouldDeleteMessage
    this.defaultSearchPlatform = merged.defaultSearchPlatform
    this.leaveOnEnd = merged.leaveOnEnd
    this.restVersion = merged.restVersion || 'v4'
    this.plugins = merged.plugins
    this.autoResume = merged.autoResume
    this.infiniteReconnects = merged.infiniteReconnects
    this.urlFilteringEnabled = merged.urlFilteringEnabled
    this.restrictedDomains = merged.restrictedDomains || []
    this.allowedDomains = merged.allowedDomains || []
    this.loadBalancer = merged.loadBalancer
    this.autoRegionMigrate = merged.autoRegionMigrate
    this.useHttp2 = merged.useHttp2
    this.maxQueueSave = merged.maxQueueSave
    this.maxTracksRestore = merged.maxTracksRestore
    this.trackResolveConcurrency = Math.max(
      1,
      Number(merged.trackResolveConcurrency) || 4
    )
    this.brokenPlayerStorePath =
      typeof merged.brokenPlayerStorePath === 'string' &&
      merged.brokenPlayerStorePath.trim()
        ? merged.brokenPlayerStorePath
        : path.join(process.cwd(), `AquaBrokenPlayers.${process.pid}.jsonl`)
    this.send = merged.send || this._createDefaultSend()
    this.debugTrace = !!merged.debugTrace
    this.traceMaxEntries = Math.max(
      100,
      Number(merged.traceMaxEntries) || TRACE_BUFFER_SIZE
    )
    this.traceSink =
      typeof merged.traceSink === 'function' ? merged.traceSink : null
    this._traceBuffer = this.debugTrace ? new Array(this.traceMaxEntries) : null
    this._traceBufferCount = 0
    this._traceBufferIndex = 0
    this._traceSeq = 0

    this._failoverState = Object.create(null)
    this._guildLifecycleLocks = new Map()
    this._brokenPlayers = new Map()
    this._rebuildLocks = new Set()
    this._leastUsedNodesCache = null
    this._leastUsedNodesCacheTime = 0
    this._nodeLoadCache = new Map()
    this._eventHandlers = null
    this._loading = false
    this._voiceStateQueue = []
    this._voiceStateQueueHead = 0
    this._voiceStateQueued = new Set()
    this._voiceStatePending = new Map()
    this._voiceStateFlushTimer = null
    this._lastVoiceStateSendAt = 0
    this._recovery = new AquaRecovery(this, {
      _functions,
      MAX_CONCURRENT_OPS,
      BROKEN_PLAYER_TTL,
      FAILOVER_CLEANUP_TTL,
      MAX_FAILOVER_QUEUE,
      MAX_REBUILD_LOCKS,
      PLAYER_BATCH_SIZE,
      RECONNECT_DELAY,
      NODE_TIMEOUT,
      EMPTY_ARRAY
    })

    if (this.autoResume) this._bindEventHandlers()
  }

  _trace(event, data = null) {
    if (!this.debugTrace) return
    if (!this._traceBuffer || this._traceBuffer.length !== this.traceMaxEntries) {
      this._traceBuffer = new Array(this.traceMaxEntries)
      this._traceBufferCount = 0
      this._traceBufferIndex = 0
    }
    const resolvedData = typeof data === 'function' ? data() : data
    const entry = {
      seq: ++this._traceSeq,
      at: Date.now(),
      event,
      data: resolvedData
    }
    this._traceBuffer[this._traceBufferIndex] = entry
    this._traceBufferIndex = (this._traceBufferIndex + 1) % this.traceMaxEntries
    if (this._traceBufferCount < this.traceMaxEntries) this._traceBufferCount++
    if (this.traceSink) _functions.safeCall(() => this.traceSink(entry))
    if (this.listenerCount(AqualinkEvents.Debug) > 0) {
      this.emit(AqualinkEvents.Debug, 'trace', JSON.stringify(entry))
    }
  }

  getTrace(limit = 300) {
    const max = Math.max(1, Number(limit) || 300)
    if (!this._traceBuffer) return []
    const count = Math.min(max, this._traceBufferCount)
    if (!count) return []
    const out = new Array(count)
    let start =
      (this._traceBufferIndex - count + this.traceMaxEntries) %
      this.traceMaxEntries
    for (let i = 0; i < count; i++) {
      out[i] = this._traceBuffer[start]
      start = (start + 1) % this.traceMaxEntries
    }
    return out
  }

  clearTrace() {
    if (this._traceBuffer) this._traceBuffer.fill(undefined)
    this._traceBufferCount = 0
    this._traceBufferIndex = 0
  }

  _createDefaultSend() {
    return (packet) => {
      const guildId = packet?.d?.guild_id
      if (!guildId) return
      const guild =
        this.client.guilds?.cache?.get?.(guildId) ||
        this.client.cache?.guilds?.get?.(guildId)
      if (!guild) return
      const gateway = this.client.gateway
      if (gateway?.send) gateway.send(gateway.calculateShardId(guildId), packet)
      else if (guild.shard?.send) guild.shard.send(packet)
    }
  }

  queueVoiceStateUpdate(data) {
    const guildId = data?.guild_id ? String(data.guild_id) : null
    if (!guildId) return false

    this._voiceStatePending.set(guildId, data)
    if (!this._voiceStateQueued.has(guildId)) {
      this._voiceStateQueued.add(guildId)
      this._voiceStateQueue.push(guildId)
    }

    if (this.debugTrace) {
      this._trace('voice.queue.enqueue', {
        guildId,
        size: this._voiceStateQueued.size
      })
    }
    this._scheduleVoiceStateFlush()
    return true
  }

  _scheduleVoiceStateFlush(delay = 0) {
    if (this._voiceStateFlushTimer) return
    this._voiceStateFlushTimer = setTimeout(
      () => {
        this._voiceStateFlushTimer = null
        this._flushVoiceStateQueue()
      },
      Math.max(0, delay)
    )
    this._voiceStateFlushTimer.unref?.()
  }

  _flushVoiceStateQueue() {
    if (!this._voiceStateQueued.size) return

    const now = Date.now()
    const waitFor =
      VOICE_STATE_QUEUE_INTERVAL - (now - this._lastVoiceStateSendAt)
    if (waitFor > 0) {
      this._scheduleVoiceStateFlush(waitFor)
      return
    }

    let guildId = null
    while (this._voiceStateQueueHead < this._voiceStateQueue.length) {
      const candidate = this._voiceStateQueue[this._voiceStateQueueHead]
      this._voiceStateQueue[this._voiceStateQueueHead] = undefined
      this._voiceStateQueueHead++
      if (candidate && this._voiceStateQueued.has(candidate)) {
        guildId = candidate
        this._voiceStateQueued.delete(candidate)
        break
      }
    }

    if (
      this._voiceStateQueueHead > 1024 ||
      this._voiceStateQueueHead > this._voiceStateQueue.length / 2
    ) {
      this._voiceStateQueue = this._voiceStateQueue.slice(
        this._voiceStateQueueHead
      )
      this._voiceStateQueueHead = 0
    }

    const data = guildId ? this._voiceStatePending.get(guildId) : null
    if (guildId) this._voiceStatePending.delete(guildId)

    if (data) {
      this._lastVoiceStateSendAt = now
      if (this.debugTrace) {
        this._trace('voice.queue.send', {
          guildId,
          remaining: this._voiceStateQueued.size
        })
      }
      _functions.safeCall(() => this.send({ op: 4, d: data }))
    }

    if (this._voiceStateQueued.size) {
      this._scheduleVoiceStateFlush(VOICE_STATE_QUEUE_INTERVAL)
    }
  }

  _bindEventHandlers() {
    this._eventHandlers = {
      onNodeConnect: (node) => {
        if (this.debugTrace)
          this._trace('node.connect', { node: node?.name || node?.host })
        this._invalidateCache()
        this._performCleanup()
      },
      onNodeDisconnect: (node) => {
        if (this.debugTrace)
          this._trace('node.disconnect', { node: node?.name || node?.host })
        this._invalidateCache()
        queueMicrotask(() => {
          this._storeBrokenPlayers(node).catch((error) =>
            reportSuppressedError(this, 'aqua.nodeDisconnect.storeBrokenPlayers', error, {
              node: node?.name || node?.host
            })
          )
          this._performCleanup()
        })
      },
      onNodeReady: (node, { resumed }) => {
        if (this.debugTrace) {
          this._trace('node.ready', {
            node: node?.name || node?.host,
            resumed: !!resumed,
            players: this.players.size
          })
        }
        if (resumed) {
          const batch = []
          for (const player of this.players.values()) {
            if (player.nodes === node && player.connection) batch.push(player)
          }
          if (batch.length)
            queueMicrotask(() =>
              batch.forEach((p) => {
                p.connection.resendVoiceUpdate()
              })
            )
          return
        }
        queueMicrotask(() => {
          this._rebuildBrokenPlayers(node).catch((error) =>
            reportSuppressedError(
              this,
              'aqua.nodeReady.rebuildBrokenPlayers',
              error,
              {
                node: node?.name || node?.host
              }
            )
          )
        })
      }
    }
    this.on(AqualinkEvents.NodeConnect, this._eventHandlers.onNodeConnect)
    this.on(AqualinkEvents.NodeDisconnect, this._eventHandlers.onNodeDisconnect)
    this.on(AqualinkEvents.NodeReady, this._eventHandlers.onNodeReady)
  }

  destroy() {
    if (this._eventHandlers) {
      this.off(AqualinkEvents.NodeConnect, this._eventHandlers.onNodeConnect)
      this.off(
        AqualinkEvents.NodeDisconnect,
        this._eventHandlers.onNodeDisconnect
      )
      this.off(AqualinkEvents.NodeReady, this._eventHandlers.onNodeReady)
      this._eventHandlers = null
    }
    this.removeAllListeners()
    if (this._voiceStateFlushTimer) {
      clearTimeout(this._voiceStateFlushTimer)
      this._voiceStateFlushTimer = null
    }
    this._voiceStateQueue.length = 0
    this._voiceStateQueueHead = 0
    this._voiceStateQueued.clear()
    this._voiceStatePending.clear()

    for (const id of Array.from(this.nodeMap.keys())) this._destroyNode(id)
    for (const player of Array.from(this.players.values()))
      _functions.safeCall(() => player.destroy())

    this.players.clear()
    this._failoverState = Object.create(null)
    this._guildLifecycleLocks.clear()
    this._brokenPlayers.clear()
    this._rebuildLocks.clear()
    this._nodeLoadCache.clear()
    this._invalidateCache()
    _functions.safeCall(() => this._recovery?.dispose?.())
    this._recovery = null
  }

  get leastUsedNodes() {
    const now = Date.now()
    if (
      this._leastUsedNodesCache &&
      now - this._leastUsedNodesCacheTime < CACHE_VALID_TIME
    ) {
      return this._leastUsedNodesCache
    }
    const connected = []
    for (const n of this.nodeMap.values()) {
      if (n.connected) connected.push(n)
    }
    let sorted
    if (this.loadBalancer === 'leastRest') {
      sorted = connected.sort(
        (a, b) => (a.rest?.calls || 0) - (b.rest?.calls || 0)
      )
    } else if (this.loadBalancer === 'random') {
      sorted = connected.sort(() => Math.random() - 0.5)
    } else {
      const withLoads = connected.map((n) => ({
        node: n,
        load: this._getNodeLoad(n)
      }))
      withLoads.sort((a, b) => a.load - b.load)
      sorted = withLoads.map((x) => x.node)
    }
    this._leastUsedNodesCache = Object.freeze(sorted)
    this._leastUsedNodesCacheTime = now
    return this._leastUsedNodesCache
  }

  _invalidateCache() {
    this._leastUsedNodesCache = null
    this._leastUsedNodesCacheTime = 0
  }

  _getNodeLoad(node) {
    const id = node.name || node.host
    const now = Date.now()
    const cached = this._nodeLoadCache.get(id)
    if (cached && now - cached.time < 5000) {
      this._nodeLoadCache.delete(id)
      this._nodeLoadCache.set(id, cached)
      return cached.load
    }
    const stats = node?.stats
    if (!stats) return 0
    const cores = Math.max(1, stats.cpu?.cores || 1)
    const reservable = Math.max(1, stats.memory?.reservable || 1)
    const load =
      (stats.cpu ? stats.cpu.systemLoad / cores : 0) * 100 +
      (stats.playingPlayers || 0) * 0.75 +
      (stats.memory ? stats.memory.used / reservable : 0) * 40 +
      (node.rest?.calls || 0) * 0.001
    if (this._nodeLoadCache.size >= MAX_CACHE_SIZE) {
      const iterator = this._nodeLoadCache.keys()
      while (this._nodeLoadCache.size >= MAX_CACHE_SIZE) {
        const oldest = iterator.next().value
        if (!oldest) break
        this._nodeLoadCache.delete(oldest)
      }
    }
    this._nodeLoadCache.set(id, { load, time: now })
    return load
  }

  async init(clientId) {
    if (clientId) {
      const newId = String(clientId)
      if (this.clientId !== newId) {
        this.clientId = newId
      }
    }

    if (this.initiated) return this
    if (!this.clientId) return this
    await this._loadNodeSessions().catch((error) =>
      reportSuppressedError(this, 'aqua.init.loadNodeSessions', error)
    )
    const results = await Promise.allSettled(
      this.nodes.map((n) =>
        Promise.race([
          this._createNode(n),
          _functions.delay(NODE_TIMEOUT).then(() => {
            throw new Error('Timeout')
          })
        ])
      )
    )
    if (!results.some((r) => r.status === 'fulfilled'))
      throw new Error('No nodes connected')
    if (this.plugins?.length) {
      await Promise.allSettled(
        this.plugins.map((p) => _functions.safeCall(() => p.load(this)))
      )
    }
    this.initiated = true
    return this
  }

  async _createNode(options) {
    const id = options.name || options.host
    this._destroyNode(id)
    const node = new Node(this, options, this.options)
    node.players = new Set()
    this.nodeMap.set(id, node)
    this._failoverState[id] = {
      connected: false,
      failoverInProgress: false,
      attempts: 0,
      lastAttempt: 0
    }
    try {
      await node.connect()
      this._failoverState[id].connected = true
      this._failoverState[id].failoverInProgress = false
      this._invalidateCache()
      this.emit(AqualinkEvents.NodeCreate, node)
      return node
    } catch (error) {
      this._cleanupNode(id)
      throw error
    }
  }

  _destroyNode(id) {
    const node = this.nodeMap.get(id)
    if (!node) return
    _functions.safeCall(() => node.destroy(true))
    this._cleanupNode(id)
  }

  _cleanupNode(id) {
    const node = this.nodeMap.get(id)
    if (node) {
      _functions.safeCall(() => node.removeAllListeners())
      _functions.safeCall(() => node.players.clear())
      this.nodeMap.delete(id)
    }
    delete this._failoverState[id]
    this._nodeLoadCache.delete(id)
    this._invalidateCache()
  }

  _storeBrokenPlayers(node) {
    return this._recovery.storeBrokenPlayers(node)
  }

  async _rebuildBrokenPlayers(node) {
    return this._recovery.rebuildBrokenPlayers(node)
  }

  async _rebuildPlayer(state, targetNode) {
    return this._recovery.rebuildPlayer(state, targetNode)
  }

  async handleNodeFailover(failedNode) {
    return this._recovery.handleNodeFailover(failedNode)
  }

  async _migratePlayersOptimized(players, nodes) {
    return this._recovery.migratePlayersOptimized(players, nodes)
  }

  async _migratePlayer(player, pickNode) {
    return this._recovery.migratePlayer(player, pickNode)
  }

  _regionMatches(configuredRegion, extractedRegion) {
    return this._recovery.regionMatches(configuredRegion, extractedRegion)
  }

  _findBestNodeForRegion(region) {
    return this._recovery.findBestNodeForRegion(region)
  }

  async movePlayerToNode(guildId, targetNode, reason = 'region') {
    return this._recovery.movePlayerToNode(guildId, targetNode, reason)
  }

  _capturePlayerState(player) {
    return this._recovery.capturePlayerState(player)
  }

  _createPlayerOnNode(targetNode, state) {
    return this._recovery.createPlayerOnNode(targetNode, state)
  }

  _seekAfterTrackStart(player, guildId, position, delay = 50) {
    return this._recovery.seekAfterTrackStart(player, guildId, position, delay)
  }

  async _restorePlayerState(newPlayer, state) {
    return this._recovery.restorePlayerState(newPlayer, state)
  }

  updateVoiceState({ d, t }) {
    if (
      !d?.guild_id ||
      (t !== 'VOICE_STATE_UPDATE' && t !== 'VOICE_SERVER_UPDATE')
    )
      return
    const player = this.players.get(String(d.guild_id))
    if (!player) return
    if (this.debugTrace) {
      this._trace('voice.gateway', {
        guildId: String(d.guild_id),
        type: t,
        hasSessionId: !!d.session_id,
        hasEndpoint: !!d.endpoint,
        hasChannelId: d.channel_id !== undefined
      })
    }

    d.txId = player.txId
    if (t === 'VOICE_STATE_UPDATE') {
      if (d.user_id !== this.clientId) return
      if (player.connection) {
        if (!d.channel_id && player.connection.voiceChannel) {
          player.connection.setStateUpdate(d)
        } else {
          player.connection.sessionId = d.session_id
          player.connection.setStateUpdate(d)
        }
      }
    } else {
      player.connection?.setServerUpdate(d)
    }
  }

  fetchRegion(region) {
    if (!region) return this.leastUsedNodes
    const lower = region.toLowerCase()
    const filtered = []
    for (const n of this.nodeMap.values()) {
      if (n.connected && n.regions?.includes(lower)) filtered.push(n)
    }
    return Object.freeze(
      filtered.sort((a, b) => this._getNodeLoad(a) - this._getNodeLoad(b))
    )
  }

  createConnection(options) {
    if (!this.initiated) throw new Error('Aqua not initialized')
    const existing = this.players.get(String(options.guildId))
    if (existing && !existing.destroyed) {
      if (
        options.voiceChannel &&
        existing.voiceChannel !== options.voiceChannel
      ) {
        _functions.safeCall(() => existing.connect(options))
      }
      return existing
    }
    const candidates = options.region
      ? this.fetchRegion(options.region)
      : this.leastUsedNodes
    if (!candidates.length) throw new Error('No nodes available')
    return this.createPlayer(candidates[0], options)
  }

  createPlayer(node, options) {
    const guildId = String(options.guildId)
    const existing = this.players.get(guildId)
    if (existing) {
      _functions.safeCall(() =>
        existing.destroy({
          preserveMessage:
            options.preserveMessage || !!options.resuming || false,
          preserveTracks: !!options.resuming || false
        })
      )
    }
    const player = new Player(this, node, options)
    this.players.set(guildId, player)
    if (this.debugTrace) {
      this._trace('player.create', {
        guildId,
        node: node?.name || node?.host,
        voiceChannel: options.voiceChannel,
        textChannel: options.textChannel,
        resuming: !!options.resuming
      })
    }
    node?.players?.add?.(player)
    player.once('destroy', () => this._handlePlayerDestroy(player))
    player.connect(options)
    this.emit(AqualinkEvents.PlayerCreate, player)
    return player
  }

  _handlePlayerDestroy(player) {
    player.nodes?.players?.delete?.(player)
    const guildId = String(player.guildId)
    if (this.players.get(guildId) === player) this.players.delete(guildId)
    if (this.debugTrace) {
      this._trace('player.destroyed', {
        guildId,
        node: player?.nodes?.name || player?.nodes?.host
      })
    }
    this.emit(AqualinkEvents.PlayerDestroyed, player)
  }

  async destroyPlayer(guildId) {
    const id = String(guildId)
    const player = this.players.get(id)
    if (!player) return

    // Guard against recursive destroy calls triggered by Player.destroy().
    this.players.delete(id)
    await _functions.safeCall(() => player.destroy())

    // Fallback cleanup in case the player "destroy" listener was not attached.
    if (player?.nodes?.players?.has?.(player)) this._handlePlayerDestroy(player)
  }

  async resolve({ query, source, requester, nodes }) {
    if (!this.initiated) throw new Error('Aqua not initialized')
    const node = this._getRequestNode(nodes)
    if (!node) throw new Error('No nodes available')
    const formatted = _functions.formatQuery(
      query,
      source || this.defaultSearchPlatform
    )
    const endpoint = `/${this.restVersion}/loadtracks?identifier=${encodeURIComponent(formatted)}`
    try {
      const response = await node.rest.makeRequest('GET', endpoint)
      if (
        !response ||
        response.loadType === 'empty' ||
        response.loadType === 'NO_MATCHES'
      )
        return EMPTY_TRACKS_RESPONSE
      return this._constructResponse(response, requester, node)
    } catch (error) {
      throw new Error(
        error?.name === 'AbortError'
          ? 'Request timeout'
          : `Resolve failed: ${error?.message || error}`
      )
    }
  }

  _getRequestNode(nodes) {
    if (!nodes) return this._chooseLeastBusyNode(this.leastUsedNodes)
    if (nodes instanceof Node) return nodes
    if (Array.isArray(nodes)) {
      const candidates = nodes.filter((n) => n?.connected)
      return this._chooseLeastBusyNode(
        candidates.length ? candidates : this.leastUsedNodes
      )
    }
    if (typeof nodes === 'string') {
      const node = this.nodeMap.get(nodes)
      return node?.connected
        ? node
        : this._chooseLeastBusyNode(this.leastUsedNodes)
    }
    throw new TypeError(`Invalid nodes: ${typeof nodes}`)
  }

  _chooseLeastBusyNode(nodes) {
    if (!nodes?.length) return null
    if (nodes.length === 1) return nodes[0]
    let best = nodes[0],
      bestScore = this._getNodeLoad(best)
    for (let i = 1; i < nodes.length; i++) {
      const score = this._getNodeLoad(nodes[i])
      if (score < bestScore) {
        best = nodes[i]
        bestScore = score
      }
    }
    return best
  }

  _constructResponse(response, requester, node) {
    const { loadType, data, pluginInfo: rootPlugin } = response || {}
    const base = {
      loadType,
      exception: null,
      playlistInfo: null,
      pluginInfo: rootPlugin || {},
      tracks: []
    }
    if (loadType === 'error' || loadType === 'LOAD_FAILED') {
      base.exception = data || response.exception || null
      return base
    }
    if (loadType === 'track' && data) {
      base.pluginInfo =
        data.pluginInfo ||
        data.info?.pluginInfo ||
        rootPlugin ||
        base.pluginInfo
      base.tracks.push(_functions.makeTrack(data, requester, node))
    } else if (loadType === 'playlist' && data) {
      const info = data.info
      if (info) {
        base.playlistInfo = {
          name: info.name || info.title,
          thumbnail:
            data.pluginInfo?.artworkUrl ||
            data.tracks?.[0]?.info?.artworkUrl ||
            null,
          ...info
        }
      }
      base.pluginInfo = data.pluginInfo || rootPlugin || base.pluginInfo
      base.tracks = Array.isArray(data.tracks)
        ? data.tracks.map((t) => _functions.makeTrack(t, requester, node))
        : []
    } else if (loadType === 'search') {
      base.tracks = Array.isArray(data)
        ? data.map((t) => _functions.makeTrack(t, requester, node))
        : []
    }
    return base
  }

  get(guildId) {
    const player = this.players.get(String(guildId))
    if (!player) throw new Error(`Player not found: ${guildId}`)
    return player
  }

  async search(query, requester, source) {
    if (!query || !requester) return null
    try {
      const { tracks } = await this.resolve({
        query,
        source: source || this.defaultSearchPlatform,
        requester
      })
      return tracks || null
    } catch {
      return null
    }
  }

  async savePlayer(filePath = './AquaPlayers.jsonl') {
    const lockFile = `${filePath}.lock`
    const tempFile = `${filePath}.tmp`
    let ws = null
    try {
      await fs.promises.writeFile(lockFile, String(process.pid), { flag: 'wx' })
      ws = fs.createWriteStream(tempFile, { encoding: 'utf8', flags: 'w' })
      const buffer = []
      let drainPromise = Promise.resolve()

      const nodeSessions = {}
      for (const node of this.nodeMap.values()) {
        if (node.sessionId) nodeSessions[node.name] = node.sessionId
      }
      buffer.push(JSON.stringify({ type: 'node_sessions', data: nodeSessions }))
      for (const player of this.players.values()) {
        const requester = player.requester || player.current?.requester
        const data = {
          g: player.guildId,
          t: player.textChannel,
          v: player.voiceChannel,
          u: player.current?.uri || null,
          p: player.position || 0,
          ts: player.timestamp || 0,
          q: player.queue
            .toArray()
            .slice(0, this.maxQueueSave)
            .map((tr) => tr.uri),
          r: requester ? `${requester.id}:${requester.username}` : null,
          vol: player.volume,
          pa: player.paused,
          pl: player.playing,
          nw: player.nowPlayingMessage?.id || null,
          resuming: true
        }
        buffer.push(JSON.stringify(data))

        if (buffer.length >= WRITE_BUFFER_SIZE) {
          const chunk = `${buffer.join('\n')}\n`
          buffer.length = 0
          if (!ws.write(chunk)) {
            drainPromise = drainPromise.then(
              () => new Promise((r) => ws.once('drain', r))
            )
          }
        }
      }

      if (buffer.length) ws.write(`${buffer.join('\n')}\n`)
      await drainPromise
      await new Promise((resolve, reject) =>
        ws.end((err) => (err ? reject(err) : resolve()))
      )
      ws = null
      await fs.promises.rename(tempFile, filePath)
    } catch (error) {
      console.error(`[Aqua/Autoresume]Error saving players:`, error)
      this.emit(AqualinkEvents.Error, null, error)
      if (ws) _functions.safeCall(() => ws.destroy())
      await fs.promises.unlink(tempFile).catch(_functions.noop)
    } finally {
      if (ws) _functions.safeCall(() => ws.destroy())
      await fs.promises.unlink(lockFile).catch(_functions.noop)
    }
  }

  async loadPlayers(filePath = './AquaPlayers.jsonl') {
    return this._recovery.loadPlayers(filePath)
  }

  async _restorePlayer(p) {
    return this._recovery.restorePlayer(p)
  }

  async _waitForFirstNode(timeout = NODE_TIMEOUT) {
    return this._recovery.waitForFirstNode(timeout)
  }

  _performCleanup() {
    return this._recovery.performCleanup()
  }

  async _loadNodeSessions(filePath = './AquaPlayers.jsonl') {
    return this._recovery.loadNodeSessions(filePath)
  }
}

module.exports = Aqua
