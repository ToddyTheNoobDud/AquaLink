const fs = require('node:fs')
const readline = require('node:readline')
const { EventEmitter } = require('node:events')
const { AqualinkEvents } = require('./AqualinkEvents')
const Node = require('./Node')
const Player = require('./Player')
const Track = require('./Track')
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
  maxTracksRestore: 20
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
    this.destroyed = false
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
    this.send = merged.send || this._createDefaultSend()
    this.debugTrace = !!merged.debugTrace
    this.traceMaxEntries = Math.max(
      100,
      Number(merged.traceMaxEntries) || TRACE_BUFFER_SIZE
    )
    this.traceSink =
      typeof merged.traceSink === 'function' ? merged.traceSink : null
    this._traceBuffer = new Array(this.traceMaxEntries)
    this._traceBufferCount = 0
    this._traceBufferIndex = 0
    this._traceSeq = 0

    this._nodeStates = new Map()
    this._failoverQueue = new Map()
    this._lastFailoverAttempt = new Map()
    this._brokenPlayers = new Map()
    this._rebuildLocks = new Set()
    this._leastUsedNodesCache = null
    this._leastUsedNodesCacheTime = 0
    this._nodeLoadCache = new Map()
    this._eventHandlers = null
    this._loading = false

    if (this.autoResume) this._bindEventHandlers()
  }

  _trace(event, data = null) {
    if (!this.debugTrace) return
    const entry = {
      seq: ++this._traceSeq,
      at: Date.now(),
      event,
      data
    }
    if (this._traceBuffer.length !== this.traceMaxEntries) {
      this._traceBuffer = new Array(this.traceMaxEntries)
      this._traceBufferCount = 0
      this._traceBufferIndex = 0
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
    this._traceBuffer.fill(undefined)
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

  _bindEventHandlers() {
    this._eventHandlers = {
      onNodeConnect: (node) => {
        this._trace('node.connect', { node: node?.name || node?.host })
        this._invalidateCache()
        this._performCleanup()
      },
      onNodeDisconnect: (node) => {
        this._trace('node.disconnect', { node: node?.name || node?.host })
        this._invalidateCache()
        queueMicrotask(() => {
          this._storeBrokenPlayers(node)
          this._performCleanup()
        })
      },
      onNodeReady: (node, { resumed }) => {
        this._trace('node.ready', {
          node: node?.name || node?.host,
          resumed: !!resumed,
          players: this.players.size
        })
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
          this._rebuildBrokenPlayers(node).catch(_functions.noop)
        })
      }
    }
    this.on(AqualinkEvents.NodeConnect, this._eventHandlers.onNodeConnect)
    this.on(AqualinkEvents.NodeDisconnect, this._eventHandlers.onNodeDisconnect)
    this.on(AqualinkEvents.NodeReady, this._eventHandlers.onNodeReady)
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true

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

    for (const id of Array.from(this.nodeMap.keys())) this._destroyNode(id)
    for (const player of Array.from(this.players.values()))
      _functions.safeCall(() => player.destroy())

    this.players.clear()
    this._nodeStates.clear()
    this._failoverQueue.clear()
    this._lastFailoverAttempt.clear()
    this._brokenPlayers.clear()
    this._rebuildLocks.clear()
    this._nodeLoadCache.clear()
    this._invalidateCache()
    this.initiated = false
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
    await this._loadNodeSessions().catch(() => {})
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
    this._nodeStates.set(id, { connected: false, failoverInProgress: false })
    try {
      node.connect()
      await this._awaitNodeConnect(node)
      this._nodeStates.set(id, { connected: true, failoverInProgress: false })
      this._invalidateCache()
      this.emit(AqualinkEvents.NodeCreate, node)
      return node
    } catch (error) {
      this._destroyNode(id)
      throw error
    }
  }

  _awaitNodeConnect(node, timeout = NODE_TIMEOUT) {
    if (node?.connected) return Promise.resolve(node)
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (ok, value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.off(AqualinkEvents.NodeConnect, onConnect)
        this.off(AqualinkEvents.NodeError, onError)
        ok ? resolve(value) : reject(value)
      }
      const onConnect = (connectedNode) => {
        if (connectedNode !== node) return
        finish(true, connectedNode)
      }
      const onError = (errorNode, error) => {
        if (errorNode !== node) return
        finish(
          false,
          error instanceof Error
            ? error
            : new Error(`Node connect failed: ${error?.message || error}`)
        )
      }
      const timer = setTimeout(
        () =>
          finish(
            false,
            new Error(
              `Node connect timeout (${timeout}ms): ${node?.name || node?.host}`
            )
          ),
        timeout
      )
      timer.unref?.()
      this.on(AqualinkEvents.NodeConnect, onConnect)
      this.on(AqualinkEvents.NodeError, onError)
    })
  }

  destroyNode(id) {
    this._destroyNode(id)
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
    this._nodeStates.delete(id)
    this._failoverQueue.delete(id)
    this._lastFailoverAttempt.delete(id)
    this._nodeLoadCache.delete(id)
    this._invalidateCache()
  }

  _storeBrokenPlayers(node) {
    const id = node.name || node.host
    const now = Date.now()
    for (const player of this.players.values()) {
      if (player.nodes !== node) continue
      const state = this._capturePlayerState(player)
      if (state) {
        state.originalNodeId = id
        state.brokenAt = now
        this._brokenPlayers.set(String(player.guildId), state)
      }
    }
  }

  async _rebuildBrokenPlayers(node) {
    const id = node.name || node.host
    const rebuilds = []
    const now = Date.now()
    for (const [guildId, state] of this._brokenPlayers) {
      if (
        state.originalNodeId === id &&
        now - state.brokenAt < BROKEN_PLAYER_TTL
      ) {
        rebuilds.push({ guildId, state })
      }
    }
    if (!rebuilds.length) return
    const successes = []
    for (let i = 0; i < rebuilds.length; i += MAX_CONCURRENT_OPS) {
      const batch = rebuilds.slice(i, i + MAX_CONCURRENT_OPS)
      const results = await Promise.allSettled(
        batch.map(({ guildId, state }) =>
          this._rebuildPlayer(state, node).then(() => guildId)
        )
      )
      for (const r of results) {
        if (r.status === 'fulfilled') successes.push(r.value)
      }
    }
    for (const guildId of successes) this._brokenPlayers.delete(guildId)
    if (successes.length)
      this.emit(AqualinkEvents.PlayersRebuilt, node, successes.length)
    this._performCleanup()
  }

  async _rebuildPlayer(state, targetNode) {
    const {
      guildId,
      textChannel,
      voiceChannel,
      current,
      volume = 65,
      deaf = true
    } = state
    const lockKey = `rebuild_${guildId}`
    if (this._rebuildLocks.has(lockKey)) return
    this._rebuildLocks.add(lockKey)
    try {
      if (this.players.has(guildId)) {
        await this.destroyPlayer(guildId)
        await _functions.delay(RECONNECT_DELAY)
      }
      const player = this.createPlayer(targetNode, {
        guildId,
        textChannel,
        voiceChannel,
        defaultVolume: volume,
        deaf
      })
      if (current && player?.queue?.add) {
        player.queue.add(current)
        await player.play()
        this._seekAfterTrackStart(player, guildId, state.position, 50)
        if (state.paused) player.pause(true)
      }
      return player
    } finally {
      this._rebuildLocks.delete(lockKey)
    }
  }

  async handleNodeFailover(failedNode) {
    if (!this.failoverOptions.enabled) return
    const id = failedNode.name || failedNode.host
    const now = Date.now()
    const state = this._nodeStates.get(id)
    if (state?.failoverInProgress) return
    const lastAttempt = this._lastFailoverAttempt.get(id)
    if (lastAttempt && now - lastAttempt < this.failoverOptions.cooldownTime)
      return
    const attempts = this._failoverQueue.get(id) || 0
    if (attempts >= this.failoverOptions.maxFailoverAttempts) return

    this._nodeStates.set(id, { connected: false, failoverInProgress: true })
    this._lastFailoverAttempt.set(id, now)
    this._failoverQueue.set(id, attempts + 1)

    try {
      this.emit(AqualinkEvents.NodeFailover, failedNode)
      const players = Array.from(failedNode.players || [])
      if (!players.length) return
      const available = []
      for (const n of this.nodeMap.values()) {
        if (n !== failedNode && n.connected) available.push(n)
      }
      if (!available.length) throw new Error('No failover nodes')
      const results = await this._migratePlayersOptimized(players, available)
      const successful = results.filter((r) => r.success).length
      if (successful) {
        this.emit(
          AqualinkEvents.NodeFailoverComplete,
          failedNode,
          successful,
          results.length - successful
        )
        this._performCleanup()
      }
    } catch (error) {
      this.emit(AqualinkEvents.Error, null, error)
    } finally {
      this._nodeStates.set(id, { connected: false, failoverInProgress: false })
    }
  }

  async _migratePlayersOptimized(players, nodes) {
    const loads = new Map()
    const counts = new Map()
    for (const n of nodes) {
      loads.set(n, this._getNodeLoad(n))
      counts.set(n, 0)
    }
    const pickNode = () => {
      let best = nodes[0],
        bestScore = loads.get(best) + counts.get(best)
      for (let i = 1; i < nodes.length; i++) {
        const score = loads.get(nodes[i]) + counts.get(nodes[i])
        if (score < bestScore) {
          best = nodes[i]
          bestScore = score
        }
      }
      counts.set(best, counts.get(best) + 1)
      return best
    }
    const results = []
    for (let i = 0; i < players.length; i += MAX_CONCURRENT_OPS) {
      const batch = players.slice(i, i + MAX_CONCURRENT_OPS)
      const batchResults = await Promise.allSettled(
        batch.map((p) => this._migratePlayer(p, pickNode))
      )
      for (const r of batchResults)
        results.push({ success: r.status === 'fulfilled', error: r.reason })
    }
    return results
  }

  async _migratePlayer(player, pickNode) {
    const state = this._capturePlayerState(player)
    if (!state) throw new Error('Failed to capture state')
    const { maxRetries, retryDelay } = this.failoverOptions
    for (let retry = 0; retry < maxRetries; retry++) {
      try {
        const targetNode = pickNode()
        const newPlayer = this._createPlayerOnNode(targetNode, state)
        await this._restorePlayerState(newPlayer, state)
        this.emit(AqualinkEvents.PlayerMigrated, player, newPlayer, targetNode)
        return newPlayer
      } catch (error) {
        if (retry === maxRetries - 1) throw error
        await _functions.delay(retryDelay * 1.5 ** retry)
      }
    }
  }

  _regionMatches(configuredRegion, extractedRegion) {
    if (!configuredRegion || !extractedRegion) return false
    const configured = String(configuredRegion).trim().toLowerCase()
    const extracted = String(extractedRegion).trim().toLowerCase()
    if (!configured || !extracted) return false
    return configured === extracted
  }

  _findBestNodeForRegion(region) {
    if (!region) return null
    const candidates = []
    for (const node of this.nodeMap.values()) {
      if (!node?.connected) continue
      const regions = Array.isArray(node.regions) ? node.regions : []
      if (regions.some((r) => this._regionMatches(r, region))) {
        candidates.push(node)
      }
    }
    if (!candidates.length) return null
    return this._chooseLeastBusyNode(candidates)
  }

  async movePlayerToNode(guildId, targetNode, reason = 'region') {
    const id = String(guildId)
    const player = this.players.get(id)
    if (!player || player.destroyed) throw new Error(`Player not found: ${id}`)
    if (!targetNode?.connected) throw new Error('Target node is not connected')
    if (player.nodes === targetNode || player.nodes?.name === targetNode.name)
      return player

    const state = this._capturePlayerState(player)
    if (!state) throw new Error(`Failed to capture state for ${id}`)
    const oldPlayer = player
    const oldNode = oldPlayer.nodes
    const oldMessage = oldPlayer.nowPlayingMessage || null
    const oldConn = oldPlayer.connection
    const oldVoice = oldConn
      ? {
          sessionId: oldConn.sessionId || null,
          endpoint: oldConn.endpoint || null,
          token: oldConn.token || null,
          region: oldConn.region || null,
          channelId: oldConn.channelId || null
        }
      : null

    oldPlayer.destroy({
      preserveClient: true,
      skipRemote: true,
      preserveMessage: true,
      preserveTracks: true,
      preserveReconnecting: true
    })

    const newPlayer = this.createPlayer(targetNode, {
      guildId: state.guildId,
      textChannel: state.textChannel,
      voiceChannel: state.voiceChannel,
      defaultVolume: state.volume || 100,
      deaf: state.deaf || false,
      mute: oldPlayer.mute || false,
      resuming: true,
      preserveMessage: true
    })

    // Bootstrap voice on the new node using last known voice state to avoid
    // "track queued, waiting for voice state" after region migration.
    if (oldVoice && newPlayer.connection) {
      if (oldVoice.sessionId)
        newPlayer.connection.sessionId = oldVoice.sessionId
      if (oldVoice.endpoint) newPlayer.connection.endpoint = oldVoice.endpoint
      if (oldVoice.token) newPlayer.connection.token = oldVoice.token
      if (oldVoice.region) newPlayer.connection.region = oldVoice.region
      if (oldVoice.channelId)
        newPlayer.connection.channelId = oldVoice.channelId
      newPlayer.connection._lastVoiceDataUpdate = Date.now()
      newPlayer.connection.resendVoiceUpdate(true)
      this._trace('player.migrate.voiceBootstrap', {
        guildId: id,
        from: oldNode?.name || oldNode?.host,
        to: targetNode?.name || targetNode?.host,
        hasSessionId: !!newPlayer.connection.sessionId,
        hasEndpoint: !!newPlayer.connection.endpoint,
        hasToken: !!newPlayer.connection.token
      })
    }

    await this._restorePlayerState(newPlayer, state)
    if (oldMessage) newPlayer.nowPlayingMessage = oldMessage

    this._trace('player.migrated', {
      guildId: id,
      reason,
      from: oldNode?.name || oldNode?.host,
      to: targetNode?.name || targetNode?.host,
      region:
        newPlayer?.connection?.region || oldPlayer?.connection?.region || null
    })
    this.emit(AqualinkEvents.PlayerMigrated, oldPlayer, newPlayer, targetNode)
    return newPlayer
  }

  _capturePlayerState(player) {
    if (!player) return null
    let position = player.position || 0
    if (player.playing && !player.paused && player.timestamp) {
      const elapsed = Date.now() - player.timestamp
      position = Math.min(
        position + elapsed,
        player.current?.info?.length || position + elapsed
      )
    }
    return {
      guildId: player.guildId,
      textChannel: player.textChannel,
      voiceChannel: player.voiceChannel,
      volume: player.volume ?? 100,
      paused: !!player.paused,
      position,
      current: player.current || null,
      queue: player.queue?.toArray?.() || EMPTY_ARRAY,
      loop: player.loop,
      shuffle: player.shuffle,
      deaf: player.deaf ?? false,
      connected: !!player.connected
    }
  }

  _createPlayerOnNode(targetNode, state) {
    return this.createPlayer(targetNode, {
      guildId: state.guildId,
      textChannel: state.textChannel,
      voiceChannel: state.voiceChannel,
      defaultVolume: state.volume || 100,
      deaf: state.deaf || false
    })
  }

  _seekAfterTrackStart(player, guildId, position, delay = 50) {
    if (!player || !guildId || !(position > 0)) return
    const seekOnce = (p) => {
      if (p.guildId !== guildId) return
      _functions.unrefTimeout(() => player.seek?.(position), delay)
    }
    this.once(AqualinkEvents.TrackStart, seekOnce)
    player.once('destroy', () => this.off(AqualinkEvents.TrackStart, seekOnce))
  }

  async _restorePlayerState(newPlayer, state) {
    const ops = []
    if (typeof state.volume === 'number') {
      if (typeof newPlayer.setVolume === 'function')
        ops.push(newPlayer.setVolume(state.volume))
      else newPlayer.volume = state.volume
    }
    if (state.queue?.length && newPlayer.queue?.add)
      newPlayer.queue.add(...state.queue)
    if (state.current && this.failoverOptions.preservePosition) {
      if (this.failoverOptions.resumePlayback) {
        ops.push(newPlayer.play(state.current))
        this._seekAfterTrackStart(
          newPlayer,
          newPlayer.guildId,
          state.position,
          50
        )
        if (state.paused) ops.push(newPlayer.pause(true))
      } else if (newPlayer.queue?.add) {
        newPlayer.queue.add(state.current)
      }
    }
    newPlayer.loop = state.loop
    newPlayer.shuffle = state.shuffle
    await Promise.allSettled(ops)
  }

  updateVoiceState({ d, t }) {
    if (
      !d?.guild_id ||
      (t !== 'VOICE_STATE_UPDATE' && t !== 'VOICE_SERVER_UPDATE')
    )
      return
    const player = this.players.get(String(d.guild_id))
    if (!player) return
    this._trace('voice.gateway', {
      guildId: String(d.guild_id),
      type: t,
      hasSessionId: !!d.session_id,
      hasEndpoint: !!d.endpoint,
      hasChannelId: d.channel_id !== undefined
    })

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
    return this.createPlayer(this._chooseLeastBusyNode(candidates), options)
  }

  createPlayer(node, options) {
    const existing = this.players.get(options.guildId)
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
    const guildId = String(options.guildId)
    this.players.set(guildId, player)
    this._trace('player.create', {
      guildId,
      node: node?.name || node?.host,
      voiceChannel: options.voiceChannel,
      textChannel: options.textChannel,
      resuming: !!options.resuming
    })
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
    this._trace('player.destroyed', {
      guildId,
      node: player?.nodes?.name || player?.nodes?.host
    })
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
    if (this._loading) return
    this._loading = true
    const lockFile = `${filePath}.lock`
    let stream = null,
      rl = null
    try {
      await fs.promises.access(filePath)
      await fs.promises.writeFile(lockFile, String(process.pid), { flag: 'wx' })
      await this._waitForFirstNode()

      stream = fs.createReadStream(filePath, { encoding: 'utf8' })
      rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

      const batch = []
      for await (const line of rl) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          if (parsed.type === 'node_sessions') continue
          batch.push(parsed)
        } catch {
          continue
        }
        if (batch.length >= PLAYER_BATCH_SIZE) {
          await Promise.allSettled(batch.map((p) => this._restorePlayer(p)))
          batch.length = 0
        }
      }
      if (batch.length)
        await Promise.allSettled(batch.map((p) => this._restorePlayer(p)))
      await fs.promises.writeFile(filePath, '')
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[Aqua/Autoresume]Error loading players:`, err)
        this.emit(AqualinkEvents.Error, null, err)
      }
    } finally {
      this._loading = false
      if (rl) _functions.safeCall(() => rl.close())
      if (stream) _functions.safeCall(() => stream.destroy())
      await fs.promises.unlink(lockFile).catch(_functions.noop)
    }
  }

  async _restorePlayer(p) {
    try {
      const gId = String(p.g)
      const existing = this.players.get(gId)
      if (existing?.playing) return

      const player =
        existing ||
        this.createPlayer(this._chooseLeastBusyNode(this.leastUsedNodes), {
          guildId: gId,
          textChannel: p.t,
          voiceChannel: p.v,
          defaultVolume: p.vol || 65,
          deaf: true,
          resuming: !!p.resuming
        })
      player._resuming = !!p.resuming
      const requester = _functions.parseRequester(p.r)
      const tracksToResolve = [p.u, ...(p.q || [])]
        .filter(Boolean)
        .slice(0, this.maxTracksRestore)
      const resolved = await Promise.all(
        tracksToResolve.map((uri) =>
          this.resolve({ query: uri, requester }).catch(() => null)
        )
      )
      const validTracks = resolved.flatMap((r) => r?.tracks || [])
      if (validTracks.length && player.queue?.add) {
        player.queue.add(...validTracks)
      }
      if (p.u && validTracks[0]) {
        if (p.vol != null) {
          if (typeof player.setVolume === 'function')
            await player.setVolume(p.vol)
          else player.volume = p.vol
        }

        this._seekAfterTrackStart(player, gId, p.p, 100)

        await player.play(undefined, { startTime: p.p, paused: p.pa })
      }
      if (p.nw && p.t) {
        const channel = this.client.channels?.cache?.get?.(p.t)
        if (channel?.messages?.fetch) {
          player.nowPlayingMessage = await channel.messages
            .fetch(p.nw)
            .catch(() => null)
        } else if (this.client.messages?.fetch) {
          player.nowPlayingMessage = await this.client.messages
            .fetch(p.nw, p.t)
            .catch(() => null)
        }
        this._trace('player.nowPlaying.restore', {
          guildId: gId,
          messageId: p.nw,
          restored: !!player.nowPlayingMessage
        })
      }
    } catch (e) {
      console.error(
        `[Aqua/Autoresume]Failed to restore player for guild: ${p.g}`,
        e
      )
    }
  }

  async _waitForFirstNode(timeout = NODE_TIMEOUT) {
    if (this.leastUsedNodes.length) return
    return new Promise((resolve, reject) => {
      let resolved = false
      const cleanup = () => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        this.off(AqualinkEvents.NodeConnect, onReady)
        this.off(AqualinkEvents.NodeCreate, onReady)
      }
      const onReady = () => {
        if (this.leastUsedNodes.length) {
          cleanup()
          resolve()
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Timeout waiting for first node'))
      }, timeout)
      timer.unref?.()
      this.on(AqualinkEvents.NodeConnect, onReady)
      this.on(AqualinkEvents.NodeCreate, onReady)
      onReady()
    })
  }

  _performCleanup() {
    const now = Date.now()
    for (const [guildId, state] of this._brokenPlayers) {
      if (now - state.brokenAt > BROKEN_PLAYER_TTL)
        this._brokenPlayers.delete(guildId)
    }
    for (const [id, ts] of this._lastFailoverAttempt) {
      if (now - ts > FAILOVER_CLEANUP_TTL) {
        this._lastFailoverAttempt.delete(id)
        this._failoverQueue.delete(id)
      }
    }
    if (this._failoverQueue.size > MAX_FAILOVER_QUEUE)
      this._failoverQueue.clear()
    if (this._rebuildLocks.size > MAX_REBUILD_LOCKS) this._rebuildLocks.clear()
    for (const id of this._nodeStates.keys()) {
      if (!this.nodeMap.has(id)) this._nodeStates.delete(id)
    }
  }

  async _loadNodeSessions(filePath = './AquaPlayers.jsonl') {
    let stream = null,
      rl = null
    try {
      await fs.promises.access(filePath)
      stream = fs.createReadStream(filePath, { encoding: 'utf8' })
      rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

      for await (const line of rl) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          if (parsed.type === 'node_sessions') {
            for (const [name, sessionId] of Object.entries(parsed.data)) {
              const nodeOptions = this.nodes.find(
                (n) => (n.name || n.host) === name
              )
              if (nodeOptions) {
                nodeOptions.sessionId = sessionId
              }
            }
            break
          }
        } catch {}
      }
    } catch {
    } finally {
      if (rl) _functions.safeCall(() => rl.close())
      if (stream) _functions.safeCall(() => stream.destroy())
    }
  }
}

module.exports = Aqua
