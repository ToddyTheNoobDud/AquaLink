'use strict'

const fs = require('node:fs')
const readline = require('node:readline')
const { EventEmitter } = require('tseep')
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
const SEEK_DELAY = 120
const RECONNECT_DELAY = 400
const CACHE_VALID_TIME = 12000
const NODE_TIMEOUT = 30000

const URL_PATTERN = /^https?:\/\//i
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
  failoverOptions: Object.freeze({
    enabled: true,
    maxRetries: 3,
    retryDelay: 1000,
    preservePosition: true,
    resumePlayback: true,
    cooldownTime: 5000,
    maxFailoverAttempts: 5
  })
})

const _delay = (ms) => new Promise(r => setTimeout(r, ms))

class Aqua extends EventEmitter {
  constructor(client, nodes, options = {}) {
    super()
    if (!client) throw new Error('Client is required')
    if (!Array.isArray(nodes) || !nodes.length) throw new TypeError('Nodes must be non-empty Array')

    this.client = client
    this.nodes = nodes
    this.nodeMap = new Map()
    this.players = new Map()
    this.clientId = null
    this.initiated = false
    this.version = pkgVersion

    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.failoverOptions = { ...DEFAULT_OPTIONS.failoverOptions, ...options.failoverOptions }

    const opts = this.options
    this.shouldDeleteMessage = opts.shouldDeleteMessage
    this.defaultSearchPlatform = opts.defaultSearchPlatform
    this.leaveOnEnd = opts.leaveOnEnd
    this.restVersion = opts.restVersion || 'v4'
    this.plugins = opts.plugins
    this.autoResume = opts.autoResume
    this.infiniteReconnects = opts.infiniteReconnects
    this.urlFilteringEnabled = opts.urlFilteringEnabled
    this.restrictedDomains = opts.restrictedDomains || []
    this.allowedDomains = opts.allowedDomains || []
    this.loadBalancer = opts.loadBalancer
    this.useHttp2 = opts.useHttp2
    this.send = opts.send || this._createDefaultSend()

    this._nodeStates = new Map()
    this._failoverQueue = new Map()
    this._lastFailoverAttempt = new Map()
    this._brokenPlayers = new Map()
    this._rebuildLocks = new Set()
    this._leastUsedNodesCache = null
    this._leastUsedNodesCacheTime = 0
    this._nodeLoadCache = new Map()
    this._nodeLoadCacheTime = new Map()
    this._nodeLoadCacheMaxSize = 20

    this._bindEventHandlers()
  }

  _createDefaultSend() {
    return packet => {
      const guildId = packet?.d?.guild_id
      if (!guildId) return
      const guild = this.client.guilds?.cache?.get?.(guildId) || this.client.cache?.guilds?.get?.(guildId)
      if (!guild) return
      const gateway = this.client.gateway
      if (gateway?.send) gateway.send(gateway.calculateShardId(guildId), packet)
      else if (guild.shard?.send) guild.shard.send(packet)
    }
  }

  _bindEventHandlers() {
    if (!this.autoResume) return
    this._onNodeConnect = async node => {
      this._invalidateCache()
      await this._rebuildBrokenPlayers(node)
      this._performCleanup()
    }
    this._onNodeDisconnect = node => {
      this._invalidateCache()
      queueMicrotask(() => this._storeBrokenPlayers(node))
    }
    this._onNodeReady = (node, { resumed }) => {
      if (!resumed) return
      const playersToUpdate = []
      for (const player of this.players.values()) {
        if (player.nodes === node && player.connection) playersToUpdate.push(player)
      }
      if (playersToUpdate.length) {
        queueMicrotask(() => {
          for (const player of playersToUpdate) {
            player.connection.resendVoiceUpdate({ resume: true })
          }
        })
      }
    }
    this.on(AqualinkEvents.NodeConnect, this._onNodeConnect)
    this.on(AqualinkEvents.NodeDisconnect, this._onNodeDisconnect)
    this.on(AqualinkEvents.NodeReady, this._onNodeReady)

    this._performCleanup()
  }

  get leastUsedNodes() {
    const now = Date.now()
    if (this._leastUsedNodesCache && (now - this._leastUsedNodesCacheTime) < CACHE_VALID_TIME) {
      return this._leastUsedNodesCache
    }
    const connected = []
    for (const node of this.nodeMap.values()) {
      if (node.connected) connected.push(node)
    }
    const sorted = this.loadBalancer === 'leastRest'
      ? connected.sort((a, b) => (a.rest?.calls || 0) - (b.rest?.calls || 0))
      : this.loadBalancer === 'random'
        ? connected.slice()
        : connected.sort((a, b) => this._getCachedNodeLoad(a) - this._getCachedNodeLoad(b))
    this._leastUsedNodesCache = Object.freeze(sorted)
    this._leastUsedNodesCacheTime = now
    return this._leastUsedNodesCache
  }

  _invalidateCache() {
    this._leastUsedNodesCache = null
    this._leastUsedNodesCacheTime = 0
  }

  _getCachedNodeLoad(node) {
    const nodeId = node.name || node.host
    const now = Date.now()
    const cacheTime = this._nodeLoadCacheTime.get(nodeId)
    if (cacheTime && (now - cacheTime) < 5000) return this._nodeLoadCache.get(nodeId) || 0
    const load = this._calculateNodeLoad(node)
    this._nodeLoadCache.set(nodeId, load)
    this._nodeLoadCacheTime.set(nodeId, now)
    // Limit cache size
    if (this._nodeLoadCache.size > this._nodeLoadCacheMaxSize) {
      const oldest = this._nodeLoadCacheTime.keys().next().value
      this._nodeLoadCache.delete(oldest)
      this._nodeLoadCacheTime.delete(oldest)
    }
    return load
  }

  _calculateNodeLoad(node) {
    const stats = node?.stats
    if (!stats) return 0
    const cpu = stats.cpu
    const cpuLoad = cpu ? (cpu.systemLoad / Math.max(1, cpu.cores || 1)) : 0
    const playing = stats.playingPlayers || 0
    const memory = stats.memory
    const memUsage = memory ? (memory.used / Math.max(1, memory.reservable)) : 0
    const restCalls = node.rest?.calls || 0
    return (cpuLoad * 100) + (playing * 0.75) + (memUsage * 40) + (restCalls * 0.001)
  }

  async init(clientId) {
    if (this.initiated) return this
    this.clientId = clientId
    if (!this.clientId) return
    const nodePromises = this.nodes.map(n => Promise.race([
      this._createNode(n),
      _delay(NODE_TIMEOUT).then(() => { throw new Error('Node timeout') })
    ]))
    const results = await Promise.allSettled(nodePromises)
    const successCount = results.filter(r => r.status === 'fulfilled').length
    if (!successCount) throw new Error('No nodes connected')
    await this._loadPlugins()
    this.initiated = true
    return this
  }

  async _loadPlugins() {
    if (!this.plugins?.length) return
    await Promise.allSettled(this.plugins.map(plugin => {
      try {
        return plugin.load(this)
      } catch (err) {
        this.emit(AqualinkEvents.Error, null, new Error(`Plugin error: ${err?.message || String(err)}`))
      }
    }))
  }

  async _createNode(options) {
    const nodeId = options.name || options.host
    this._destroyNode(nodeId)
    const node = new Node(this, options, this.options)
    node.players = node.players || new Set()
    this.nodeMap.set(nodeId, node)
    this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false })
    try {
      await node.connect()
      this._nodeStates.set(nodeId, { connected: true, failoverInProgress: false })
      this._invalidateCache()
      this.emit(AqualinkEvents.NodeCreate, node)
      return node
    } catch (error) {
      this._cleanupNode(nodeId)
      throw error
    }
  }

  _destroyNode(identifier) {
    const node = this.nodeMap.get(identifier)
    if (node) {
      try { node.destroy?.() } catch { }
      this._cleanupNode(identifier)
      this.emit(AqualinkEvents.NodeDestroy, node)
    }
  }

  _cleanupNode(nodeId) {
    const node = this.nodeMap.get(nodeId)
    if (node) {
      node.removeAllListeners?.()
      node.players?.clear?.()
      this.nodeMap.delete(nodeId)
    }
    this._nodeStates.delete(nodeId)
    this._failoverQueue.delete(nodeId)
    this._lastFailoverAttempt.delete(nodeId)
    this._nodeLoadCache.delete(nodeId)
    this._nodeLoadCacheTime.delete(nodeId)
    this._invalidateCache()
  }

  _storeBrokenPlayers(node) {
    const nodeId = node.name || node.host
    const now = Date.now()
    for (const player of this.players.values()) {
      if (player.nodes !== node) continue
      const state = this._capturePlayerState(player)
      if (state) {
        state.originalNodeId = nodeId
        state.brokenAt = now
        this._brokenPlayers.set(player.guildId, state)
      }
    }
  }

  async _rebuildBrokenPlayers(node) {
    const nodeId = node.name || node.host
    const rebuilds = []
    const now = Date.now()
    for (const [guildId, brokenState] of this._brokenPlayers) {
      if (brokenState.originalNodeId !== nodeId || now - brokenState.brokenAt > BROKEN_PLAYER_TTL) continue
      rebuilds.push({ guildId, brokenState })
    }
    if (!rebuilds.length) return

    const successes = []
    for (let i = 0; i < rebuilds.length; i += MAX_CONCURRENT_OPS) {
      const batch = rebuilds.slice(i, i + MAX_CONCURRENT_OPS)
      const results = await Promise.allSettled(batch.map(({ guildId, brokenState }) =>
        this._rebuildPlayer(brokenState, node).then(() => guildId)
      ))
      results.forEach(r => r.status === 'fulfilled' && successes.push(r.value))
    }
    successes.forEach(guildId => this._brokenPlayers.delete(guildId))
    if (successes.length) this.emit(AqualinkEvents.PlayersRebuilt, node, successes.length)
    this._performCleanup()
  }

  async _rebuildPlayer(brokenState, targetNode) {
    const { guildId, textChannel, voiceChannel, current, volume = 65, deaf = true } = brokenState
    const lockKey = `rebuild_${guildId}`
    if (this._rebuildLocks.has(lockKey)) return
    this._rebuildLocks.add(lockKey)
    try {
      const existing = this.players.get(guildId)
      if (existing) {
        await this.destroyPlayer(guildId)
        await _delay(RECONNECT_DELAY)
      }
      const player = this.createPlayer(targetNode, { guildId, textChannel, voiceChannel, defaultVolume: volume, deaf })
      if (current && player?.queue?.add) {
        player.queue.add(current)
        await player.play()
        if (brokenState.position > 0) setTimeout(() => player.seek?.(brokenState.position), SEEK_DELAY)
        if (brokenState.paused) await player.pause(true)
      }
      return player
    } finally {
      this._rebuildLocks.delete(lockKey)
    }
  }

  async handleNodeFailover(failedNode) {
    if (!this.failoverOptions.enabled) return
    const nodeId = failedNode.name || failedNode.host
    const now = Date.now()
    const nodeState = this._nodeStates.get(nodeId)
    if (nodeState?.failoverInProgress) return
    const lastAttempt = this._lastFailoverAttempt.get(nodeId)
    if (lastAttempt && (now - lastAttempt) < this.failoverOptions.cooldownTime) return
    const attempts = this._failoverQueue.get(nodeId) || 0
    if (attempts >= this.failoverOptions.maxFailoverAttempts) return

    this._nodeStates.set(nodeId, { connected: false, failoverInProgress: true })
    this._lastFailoverAttempt.set(nodeId, now)
    this._failoverQueue.set(nodeId, attempts + 1)

    try {
      this.emit(AqualinkEvents.NodeFailover, failedNode)
      const affectedPlayers = Array.from(failedNode.players || [])
      if (!affectedPlayers.length) {
        this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false })
        return
      }
      const availableNodes = this._getAvailableNodes(failedNode)
      if (!availableNodes.length) throw new Error('No failover nodes available')
      const results = await this._migratePlayersOptimized(affectedPlayers, availableNodes)
      const successful = results.filter(r => r.success).length
      if (successful) this.emit(AqualinkEvents.NodeFailoverComplete, failedNode, successful, results.length - successful)
    } catch (error) {
      this.emit(AqualinkEvents.Error, null, new Error(`Failover failed: ${error?.message || String(error)}`))
    } finally {
      this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false })
    }
  }

  async _migratePlayersOptimized(players, availableNodes) {
    const baseLoads = new Map()
    const assignedCounts = new Map()
    availableNodes.forEach(n => {
      baseLoads.set(n, this._getCachedNodeLoad(n))
      assignedCounts.set(n, 0)
    })

    const pickNode = () => {
      let bestNode = availableNodes[0]
      let bestScore = Infinity
      for (const n of availableNodes) {
        const score = baseLoads.get(n) + assignedCounts.get(n)
        if (score < bestScore) {
          bestNode = n
          bestScore = score
        }
      }
      assignedCounts.set(bestNode, assignedCounts.get(bestNode) + 1)
      return bestNode
    }

    const results = []
    for (let i = 0; i < players.length; i += MAX_CONCURRENT_OPS) {
      const batch = players.slice(i, i + MAX_CONCURRENT_OPS)
      const batchResults = await Promise.allSettled(batch.map(p => this._migratePlayer(p, pickNode)))
      results.push(...batchResults.map(r => ({ success: r.status === 'fulfilled', error: r.reason })))
    }
    return results
  }

  async _migratePlayer(player, pickNode) {
    const playerState = this._capturePlayerState(player)
    if (!playerState) throw new Error('Failed to capture state')

    for (let retry = 0; retry < this.failoverOptions.maxRetries; retry++) {
      try {
        const targetNode = pickNode()
        const newPlayer = await this._createPlayerOnNode(targetNode, playerState)
        await this._restorePlayerState(newPlayer, playerState)
        this.emit(AqualinkEvents.PlayerMigrated, player, newPlayer, targetNode)
        return newPlayer
      } catch (error) {
        if (retry === this.failoverOptions.maxRetries - 1) throw error
        await _delay(this.failoverOptions.retryDelay * Math.pow(1.5, retry))
      }
    }
  }

  _capturePlayerState(player) {
    if (!player) return null
    return {
      guildId: player.guildId,
      textChannel: player.textChannel,
      voiceChannel: player.voiceChannel,
      volume: player.volume ?? 100,
      paused: !!player.paused,
      position: player.position || 0,
      current: player.current || null,
      queue: player.queue?.toArray() || EMPTY_ARRAY,
      repeat: player.loop,
      shuffle: player.shuffle,
      deaf: player.deaf ?? false,
      connected: !!player.connected
    }
  }

  async _createPlayerOnNode(targetNode, playerState) {
    return this.createPlayer(targetNode, {
      guildId: playerState.guildId,
      textChannel: playerState.textChannel,
      voiceChannel: playerState.voiceChannel,
      defaultVolume: playerState.volume || 100,
      deaf: playerState.deaf || false
    })
  }

  async _restorePlayerState(newPlayer, playerState) {
    const operations = []
    if (typeof playerState.volume === 'number') {
      if (typeof newPlayer.setVolume === 'function') operations.push(newPlayer.setVolume(playerState.volume))
      else newPlayer.volume = playerState.volume
    }
    if (playerState.queue?.length && newPlayer.queue?.add) newPlayer.queue.add(...playerState.queue)
    if (playerState.current && this.failoverOptions.preservePosition) {
      if (newPlayer.queue?.add) newPlayer.queue.add(playerState.current, { toFront: true })
      if (this.failoverOptions.resumePlayback) {
        operations.push(newPlayer.play())
        if (playerState.position > 0) setTimeout(() => newPlayer.seek?.(playerState.position), SEEK_DELAY)
        if (playerState.paused) operations.push(newPlayer.pause(true))
      }
    }
    Object.assign(newPlayer, { repeat: playerState.repeat, shuffle: playerState.shuffle })
    await Promise.allSettled(operations)
  }

  updateVoiceState({ d, t }) {
    if (!d?.guild_id || (t !== 'VOICE_STATE_UPDATE' && t !== 'VOICE_SERVER_UPDATE')) return
    const player = this.players.get(d.guild_id)
    if (!player) return

    if (t === 'VOICE_STATE_UPDATE') {
      if (d.user_id !== this.clientId) return
      if (!d.channel_id) {
        this.destroyPlayer(d.guild_id)
        return
      }
      if (player.connection) {
        player.connection.sessionId = d.session_id
        player.connection.setStateUpdate(d)
      }
    } else {
      player.connection?.setServerUpdate(d)
    }
  }

  fetchRegion(region) {
    if (!region) return this.leastUsedNodes
    const lowerRegion = region.toLowerCase()
    const filtered = []
    for (const node of this.nodeMap.values()) {
      if (node.connected && node.regions?.includes(lowerRegion)) filtered.push(node)
    }
    return Object.freeze(filtered.sort((a, b) => this._getCachedNodeLoad(a) - this._getCachedNodeLoad(b)))
  }

  createConnection(options) {
    if (!this.initiated) throw new Error('Aqua not initialized')
    const existing = this.players.get(options.guildId)
    if (existing) {
      if (options.voiceChannel && existing.voiceChannel !== options.voiceChannel) {
        try { existing.connect(options) } catch { }
      }
      return existing
    }
    const candidateNodes = options.region ? this.fetchRegion(options.region) : this.leastUsedNodes
    if (!candidateNodes.length) throw new Error('No nodes available')
    const node = this._chooseLeastBusyNode(candidateNodes)
    if (!node) throw new Error('No suitable node found')
    return this.createPlayer(node, options)
  }

  createPlayer(node, options) {
    const existing = this.players.get(options.guildId)
    if (existing) try { existing.destroy?.() } catch { }
    const player = new Player(this, node, options)
    this.players.set(options.guildId, player)
    node?.players?.add?.(player)
    player.once('destroy', () => this._handlePlayerDestroy(player))
    player.connect(options)
    this.emit(AqualinkEvents.PlayerCreate, player)
    return player
  }

  _handlePlayerDestroy(player) {
    const node = player.nodes
    node?.players?.delete?.(player)
    if (this.players.get(player.guildId) === player) this.players.delete(player.guildId)
    this.emit(AqualinkEvents.PlayerDestroy, player)
  }

  async destroyPlayer(guildId) {
    const player = this.players.get(guildId)
    if (!player) return
    try {
      this.players.delete(guildId)
      player.removeAllListeners?.()
      await player.destroy?.()
    } catch { }
  }

  async resolve({ query, source = this.defaultSearchPlatform, requester, nodes }) {
    if (!this.initiated) throw new Error('Aqua not initialized')
    const requestNode = this._getRequestNode(nodes)
    if (!requestNode) throw new Error('No nodes available')
    const formattedQuery = (typeof query === 'string' && query.length > 8 && URL_PATTERN.test(query))
      ? query
      : `${source}${SEARCH_PREFIX}${query}`
    const endpoint = `/${this.restVersion}/loadtracks?identifier=${encodeURIComponent(formattedQuery)}`
    try {
      const response = await requestNode.rest.makeRequest('GET', endpoint)
      if (!response || response.loadType === 'empty' || response.loadType === 'NO_MATCHES') return EMPTY_TRACKS_RESPONSE
      return this._constructResponse(response, requester, requestNode)
    } catch (error) {
      throw new Error(error?.name === 'AbortError' ? 'Request timeout' : `Resolve failed: ${error?.message || String(error)}`)
    }
  }

  _getRequestNode(nodes) {
    if (!nodes) return this._chooseLeastBusyNode(this.leastUsedNodes) || (() => { throw new Error('No nodes available') })()
    if (nodes instanceof Node) return nodes
    if (Array.isArray(nodes)) {
      const candidates = nodes.filter(n => n?.connected)
      return this._chooseLeastBusyNode(candidates.length ? candidates : this.leastUsedNodes) || (() => { throw new Error('No nodes available') })()
    }
    if (typeof nodes === 'string') {
      const node = this.nodeMap.get(nodes)
      if (node?.connected) return node
      return this._chooseLeastBusyNode(this.leastUsedNodes) || (() => { throw new Error('No nodes available') })()
    }
    throw new TypeError(`Invalid nodes parameter: ${typeof nodes}`)
  }

  _chooseLeastBusyNode(nodes) {
    if (!nodes?.length) return null
    if (nodes.length === 1) return nodes[0]
    let bestNode = nodes[0]
    let bestScore = this._getCachedNodeLoad(bestNode)
    for (let i = 1; i < nodes.length; i++) {
      const score = this._getCachedNodeLoad(nodes[i])
      if (score < bestScore) {
        bestNode = nodes[i]
        bestScore = score
      }
    }
    return bestNode
  }

  _constructResponse(response, requester, requestNode) {
    const { loadType, data, pluginInfo: rootPluginInfo } = response || {}
    const baseResponse = { loadType, exception: null, playlistInfo: null, pluginInfo: rootPluginInfo || {}, tracks: [] }

    if (loadType === 'error' || loadType === 'LOAD_FAILED') {
      baseResponse.exception = data || response.exception || null
      return baseResponse
    }

    const makeTrack = t => new Track(t, requester, requestNode)

    switch (loadType) {
      case 'track':
        if (data) {
          baseResponse.pluginInfo = data.info?.pluginInfo || data.pluginInfo || baseResponse.pluginInfo
          baseResponse.tracks.push(makeTrack(data))
        }
        break
      case 'playlist':
        if (data) {
          const info = data.info || null
          const thumbnail = data.pluginInfo?.artworkUrl || data.tracks?.[0]?.info?.artworkUrl || null
          if (info) baseResponse.playlistInfo = { name: info.name || info.title, thumbnail, ...info }
          baseResponse.pluginInfo = data.pluginInfo || baseResponse.pluginInfo
          baseResponse.tracks = Array.isArray(data.tracks) ? data.tracks.map(makeTrack) : []
        }
        break
      case 'search':
        baseResponse.tracks = Array.isArray(data) ? data.map(makeTrack) : []
        break
    }
    return baseResponse
  }

  get(guildId) {
    const player = this.players.get(guildId)
    if (!player) throw new Error(`Player not found: ${guildId}`)
    return player
  }

  _resolveSearchPlatform(source) {
    return source || this.defaultSearchPlatform
  }

  async search(query, requester, source = this.defaultSearchPlatform) {
    if (!query || !requester) return null
    try {
      const resolvedSource = this._resolveSearchPlatform(source)
      const { tracks } = await this.resolve({ query, source: resolvedSource, requester })
      return tracks || null
    } catch {
      return null
    }
  }

  async loadPlayers(filePath = './AquaPlayers.jsonl') {
    const lockFile = `${filePath}.lock`
    try {
      await fs.promises.access(filePath).catch(() => null)
      await fs.promises.writeFile(lockFile, String(process.pid), { flag: 'wx' }).catch(() => null)
      await this._waitForFirstNode()
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
      const batch = []
      for await (const line of rl) {
        if (!line.trim()) continue
        try { batch.push(JSON.parse(line)) } catch { continue }
        if (batch.length >= PLAYER_BATCH_SIZE) {
          await Promise.allSettled(batch.map(p => this._restorePlayer(p)))
          batch.length = 0
        }
      }
      if (batch.length) await Promise.allSettled(batch.map(p => this._restorePlayer(p)))
      await fs.promises.writeFile(filePath, '')
    } catch { } finally {
      await fs.promises.unlink(lockFile).catch(() => null)
    }
  }

  async savePlayer(filePath = './AquaPlayers.jsonl') {
    const lockFile = `${filePath}.lock`
    try {
      await fs.promises.writeFile(lockFile, String(process.pid), { flag: 'wx' }).catch(() => null)
      const ws = fs.createWriteStream(filePath, { encoding: 'utf8', flags: 'w' })
      const buffer = []
      for (const player of this.players.values()) {
        const requester = player.requester || player.current?.requester
        const data = {
          g: player.guildId,
          t: player.textChannel,
          v: player.voiceChannel,
          u: player.current?.uri || null,
          p: player.position || 0,
          ts: player.timestamp || 0,
          q: player.queue?.tracks?.slice(0, 10).map(tr => tr.uri) || [],
          r: requester ? JSON.stringify({ id: requester.id, username: requester.username }) : null,
          vol: player.volume,
          pa: player.paused,
          pl: player.playing,
          nw: player.nowPlayingMessage?.id || null
        }
        buffer.push(JSON.stringify(data))
        if (buffer.length >= 100) {
          ws.write(buffer.join('\n') + '\n')
          buffer.length = 0
        }
      }
      if (buffer.length) ws.write(buffer.join('\n') + '\n')
      await new Promise(resolve => ws.end(resolve))
    } catch (error) {
      this.emit(AqualinkEvents.Error, null, new Error(`Save players failed: ${error?.message || String(error)}`))
    } finally {
      await fs.promises.unlink(lockFile).catch(() => null)
    }
  }

  async _restorePlayer(p) {
    try {
      const player = this.players.get(p.g) || this.createPlayer(this._chooseLeastBusyNode(this.leastUsedNodes), {
        guildId: p.g,
        textChannel: p.t,
        voiceChannel: p.v,
        defaultVolume: p.vol || 65,
        deaf: true
      })
      const requester = this._parseRequester(p.r)
      const tracksToResolve = [p.u, ...(p.q || [])].filter(Boolean).slice(0, 20)
      const resolved = await Promise.all(tracksToResolve.map(uri => this.resolve({ query: uri, requester }).catch(() => null)))
      const validTracks = []
      for (const r of resolved) {
        if (r?.tracks?.length) validTracks.push(...r.tracks)
      }
      if (validTracks.length && player.queue?.add) {
        if (player.queue.tracks?.length <= 2) player.queue.tracks = []
        player.queue.add(...validTracks)
      }
      if (p.u && validTracks[0]) {
        if (p.vol != null) {
          if (typeof player.setVolume === 'function') await player.setVolume(p.vol)
          else player.volume = p.vol
        }
        await player.play()
        if (p.p > 0) setTimeout(() => player.seek?.(p.p), SEEK_DELAY)
        if (p.pa) await player.pause(true)
      }
      if (p.nw && p.t) {
        const channel = this.client.channels?.cache?.get(p.t)
        if (channel?.messages) {
          try { player.nowPlayingMessage = await channel.messages.fetch(p.nw).catch(() => null) } catch { }
        }
      }
    } catch { }
  }

  _parseRequester(requesterString) {
    if (!requesterString || typeof requesterString !== 'string') return null
    try {
      return JSON.parse(requesterString)
    } catch {
      const i = requesterString.indexOf(':')
      if (i <= 0) return null
      return { id: requesterString.substring(0, i), username: requesterString.substring(i + 1) }
    }
  }

  async _waitForFirstNode(timeout = NODE_TIMEOUT) {
    if (this.leastUsedNodes.length) return
    return new Promise((resolve, reject) => {
      const onReady = () => {
        if (this.leastUsedNodes.length) {
          clearTimeout(timer)
          this.off(AqualinkEvents.NodeConnect, onReady)
          this.off(AqualinkEvents.NodeCreate, onReady)
          resolve()
        }
      }
      const timer = setTimeout(() => {
        this.off(AqualinkEvents.NodeConnect, onReady)
        this.off(AqualinkEvents.NodeCreate, onReady)
        reject(new Error('Timeout waiting for first node'))
      }, timeout)
      this.on(AqualinkEvents.NodeConnect, onReady)
      this.on(AqualinkEvents.NodeCreate, onReady)
      onReady()
    })
  }

  _performCleanup() {
    const now = Date.now()
    const expiredPlayers = []
    const expiredNodes = []

    for (const [guildId, state] of this._brokenPlayers) {
      if (now - state.brokenAt > BROKEN_PLAYER_TTL) expiredPlayers.push(guildId)
    }
    expiredPlayers.forEach(id => this._brokenPlayers.delete(id))

    for (const [nodeId, ts] of this._lastFailoverAttempt) {
      if (now - ts > FAILOVER_CLEANUP_TTL) expiredNodes.push(nodeId)
    }
    expiredNodes.forEach(id => {
      this._lastFailoverAttempt.delete(id)
      this._failoverQueue.delete(id)
    })

    if (this._brokenPlayers.size > 100) {
      const sorted = [...this._brokenPlayers.entries()].sort((a, b) => a[1].brokenAt - b[1].brokenAt)
      sorted.slice(0, sorted.length - 50).forEach(([guildId]) => this._brokenPlayers.delete(guildId))
    }

    if (this._failoverQueue.size > 50) this._failoverQueue.clear()
    if (this._lastFailoverAttempt.size > 50) this._lastFailoverAttempt.clear()
    if (this._rebuildLocks.size > 100) this._rebuildLocks.clear()

    for (const [nodeId] of this._nodeStates) {
      if (!this.nodeMap.has(nodeId)) this._nodeStates.delete(nodeId)
    }

    this._invalidateCache()
    if (this._nodeLoadCache.size > this._nodeLoadCacheMaxSize) {
      const sorted = [...this._nodeLoadCacheTime.entries()].sort((a, b) => a[1] - b[1])
      sorted.slice(0, sorted.length - this._nodeLoadCacheMaxSize).forEach(([nodeId]) => {
        this._nodeLoadCache.delete(nodeId)
        this._nodeLoadCacheTime.delete(nodeId)
      })
    }
  }

  _getAvailableNodes(excludeNode) {
    const nodes = []
    for (const node of this.nodeMap.values()) {
      if (node !== excludeNode && node.connected) nodes.push(node)
    }
    return nodes
  }
}

module.exports = Aqua
