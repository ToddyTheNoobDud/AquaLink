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
const MAX_CACHE_SIZE = 20
const MAX_BROKEN_PLAYERS = 50
const MAX_FAILOVER_QUEUE = 50
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

const _delay = ms => new Promise(r => setTimeout(r, ms))
const _noop = () => {}
const _isUrl = query => typeof query === 'string' && query.length > 8 && URL_PATTERN.test(query)
const _formatQuery = (query, source) => _isUrl(query) ? query : `${source}${SEARCH_PREFIX}${query}`
const _makeTrack = (t, requester, node) => new Track(t, requester, node)
const _safeCall = fn => { try { fn() } catch {} }

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

    const merged = { ...DEFAULT_OPTIONS, ...options }
    this.options = merged
    this.failoverOptions = { ...DEFAULT_OPTIONS.failoverOptions, ...options.failoverOptions }

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
    this.useHttp2 = merged.useHttp2
    this.send = merged.send || this._createDefaultSend()

    this._nodeStates = new Map()
    this._failoverQueue = new Map()
    this._lastFailoverAttempt = new Map()
    this._brokenPlayers = new Map()
    this._rebuildLocks = new Set()
    this._leastUsedNodesCache = null
    this._leastUsedNodesCacheTime = 0
    this._nodeLoadCache = new Map()
    this._cleanupTimer = null

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
    const onNodeConnect = async node => {
      this._invalidateCache()
      await this._rebuildBrokenPlayers(node)
      this._scheduleCleanup()
    }
    const onNodeDisconnect = node => {
      this._invalidateCache()
      queueMicrotask(() => this._storeBrokenPlayers(node))
    }
    const onNodeReady = (node, { resumed }) => {
      if (!resumed) return
      const batch = []
      for (const player of this.players.values()) {
        if (player.nodes === node && player.connection) batch.push(player)
      }
      if (batch.length) queueMicrotask(() => batch.forEach(p => p.connection.resendVoiceUpdate({ resume: true })))
    }
    this.on(AqualinkEvents.NodeConnect, onNodeConnect)
    this.on(AqualinkEvents.NodeDisconnect, onNodeDisconnect)
    this.on(AqualinkEvents.NodeReady, onNodeReady)
    this._scheduleCleanup()
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
        ? connected.sort(() => Math.random() - 0.5)
        : connected.sort((a, b) => this._getNodeLoad(a) - this._getNodeLoad(b))
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
    const cached = this._nodeLoadCache.get(id)
    const now = Date.now()
    if (cached && (now - cached.time) < 5000) return cached.load
    const stats = node?.stats
    if (!stats) return 0
    const load = (stats.cpu ? stats.cpu.systemLoad / Math.max(1, stats.cpu.cores || 1) : 0) * 100 +
      (stats.playingPlayers || 0) * 0.75 +
      (stats.memory ? stats.memory.used / Math.max(1, stats.memory.reservable) : 0) * 40 +
      (node.rest?.calls || 0) * 0.001
    this._nodeLoadCache.set(id, { load, time: now })
    if (this._nodeLoadCache.size > MAX_CACHE_SIZE) {
      const first = this._nodeLoadCache.keys().next().value
      this._nodeLoadCache.delete(first)
    }
    return load
  }

  async init(clientId) {
    if (this.initiated) return this
    this.clientId = clientId
    if (!this.clientId) return
    const results = await Promise.allSettled(
      this.nodes.map(n => Promise.race([this._createNode(n), _delay(NODE_TIMEOUT).then(() => { throw new Error('Timeout') })]))
    )
    if (!results.some(r => r.status === 'fulfilled')) throw new Error('No nodes connected')
    if (this.plugins?.length) {
      await Promise.allSettled(this.plugins.map(p => {
        try { return p.load(this) }
        catch (err) { this.emit(AqualinkEvents.Error, null, err) }
      }))
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
      await node.connect()
      this._nodeStates.set(id, { connected: true, failoverInProgress: false })
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
    _safeCall(() => node.destroy())
    this._cleanupNode(id)
    this.emit(AqualinkEvents.NodeDestroy, node)
  }

  _cleanupNode(id) {
    const node = this.nodeMap.get(id)
    if (node) {
      _safeCall(() => node.removeAllListeners())
      _safeCall(() => node.players.clear())
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
        this._brokenPlayers.set(player.guildId, state)
      }
    }
    this._trimBrokenPlayers()
  }

  async _rebuildBrokenPlayers(node) {
    const id = node.name || node.host
    const rebuilds = []
    const now = Date.now()
    for (const [guildId, state] of this._brokenPlayers) {
      if (state.originalNodeId === id && (now - state.brokenAt) < BROKEN_PLAYER_TTL) {
        rebuilds.push({ guildId, state })
      }
    }
    if (!rebuilds.length) return
    const successes = []
    for (let i = 0; i < rebuilds.length; i += MAX_CONCURRENT_OPS) {
      const batch = rebuilds.slice(i, i + MAX_CONCURRENT_OPS)
      const results = await Promise.allSettled(
        batch.map(({ guildId, state }) => this._rebuildPlayer(state, node).then(() => guildId))
      )
      for (const res of results) {
        if (res.status === 'fulfilled') successes.push(res.value)
      }
    }
    for (const guildId of successes) this._brokenPlayers.delete(guildId)
    if (successes.length) this.emit(AqualinkEvents.PlayersRebuilt, node, successes.length)
  }

  async _rebuildPlayer(state, targetNode) {
    const { guildId, textChannel, voiceChannel, current, volume = 65, deaf = true } = state
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
        if (state.position > 0) setTimeout(() => player.seek?.(state.position), SEEK_DELAY)
        if (state.paused) await player.pause(true)
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
    if (lastAttempt && (now - lastAttempt) < this.failoverOptions.cooldownTime) return
    const attempts = this._failoverQueue.get(id) || 0
    if (attempts >= this.failoverOptions.maxFailoverAttempts) return

    this._nodeStates.set(id, { connected: false, failoverInProgress: true })
    this._lastFailoverAttempt.set(id, now)
    this._failoverQueue.set(id, attempts + 1)

    try {
      this.emit(AqualinkEvents.NodeFailover, failedNode)
      const players = Array.from(failedNode.players || [])
      if (!players.length) return
      const available = this._getAvailableNodes(failedNode)
      if (!available.length) throw new Error('No failover nodes')
      const results = await this._migratePlayersOptimized(players, available)
      const successful = results.filter(r => r.success).length
      if (successful) this.emit(AqualinkEvents.NodeFailoverComplete, failedNode, successful, results.length - successful)
    } catch (error) {
      this.emit(AqualinkEvents.Error, null, error)
    } finally {
      this._nodeStates.set(id, { connected: false, failoverInProgress: false })
    }
  }

  async _migratePlayersOptimized(players, nodes) {
    const loads = new Map()
    const counts = new Map()
    for (const node of nodes) {
      loads.set(node, this._getNodeLoad(n))
      counts.set(node, 0)
    }
    const pickNode = () => {
      const n = nodes.reduce((best, node) => {
        const score = loads.get(node) + counts.get(node)
        const bestScore = loads.get(best) + counts.get(best)
        return score < bestScore ? node : best
      })
      counts.set(n, counts.get(n) + 1)
      return n
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
    const state = this._capturePlayerState(player)
    if (!state) throw new Error('Failed to capture state')
    for (let retry = 0; retry < this.failoverOptions.maxRetries; retry++) {
      try {
        const targetNode = pickNode()
        const newPlayer = await this._createPlayerOnNode(targetNode, state)
        await this._restorePlayerState(newPlayer, state)
        this.emit(AqualinkEvents.PlayerMigrated, player, newPlayer, targetNode)
        return newPlayer
      } catch (error) {
        if (retry === this.failoverOptions.maxRetries - 1) throw error
        await _delay(this.failoverOptions.retryDelay * Math.pow(1.5, retry))
      }
    }
  }

  _capturePlayerState(player) {
    return player ? {
      guildId: player.guildId,
      textChannel: player.textChannel,
      voiceChannel: player.voiceChannel,
      volume: player.volume ?? 100,
      paused: !!player.paused,
      position: player.position || 0,
      current: player.current || null,
      queue: player.queue?.toArray?.() || EMPTY_ARRAY,
      repeat: player.loop,
      shuffle: player.shuffle,
      deaf: player.deaf ?? false,
      connected: !!player.connected
    } : null
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

  async _restorePlayerState(newPlayer, state) {
    const ops = []
    if (typeof state.volume === 'number') {
      if (typeof newPlayer.setVolume === 'function') ops.push(newPlayer.setVolume(state.volume))
      else newPlayer.volume = state.volume
    }
    if (state.queue?.length && newPlayer.queue?.add) newPlayer.queue.add(...state.queue)
    if (state.current && this.failoverOptions.preservePosition) {
      newPlayer.queue?.add?.(state.current, { toFront: true })
      if (this.failoverOptions.resumePlayback) {
        ops.push(newPlayer.play())
        if (state.position > 0) setTimeout(() => newPlayer.seek?.(state.position), SEEK_DELAY)
        if (state.paused) ops.push(newPlayer.pause(true))
      }
    }
    Object.assign(newPlayer, { repeat: state.repeat, shuffle: state.shuffle })
    await Promise.allSettled(ops)
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
    const lower = region.toLowerCase()
    const filtered = []
    for (const node of this.nodeMap.values()) {
      if (node.connected && node.regions?.includes(lower)) filtered.push(node)
    }
    return Object.freeze(filtered.sort((a, b) => this._getNodeLoad(a) - this._getNodeLoad(b)))
  }

  createConnection(options) {
    if (!this.initiated) throw new Error('Aqua not initialized')
    const existing = this.players.get(options.guildId)
    if (existing) {
      if (options.voiceChannel && existing.voiceChannel !== options.voiceChannel) {
        _safeCall(() => existing.connect(options))
      }
      return existing
    }
    const candidates = options.region ? this.fetchRegion(options.region) : this.leastUsedNodes
    if (!candidates.length) throw new Error('No nodes available')
    return this.createPlayer(this._chooseLeastBusyNode(candidates), options)
  }

  createPlayer(node, options) {
    const existing = this.players.get(options.guildId)
    if (existing) _safeCall(() => existing.destroy())
    const player = new Player(this, node, options)
    this.players.set(options.guildId, player)
    node?.players?.add?.(player)
    player.once('destroy', () => this._handlePlayerDestroy(player))
    player.connect(options)
    this.emit(AqualinkEvents.PlayerCreate, player)
    return player
  }

  _handlePlayerDestroy(player) {
    player.nodes?.players?.delete?.(player)
    if (this.players.get(player.guildId) === player) this.players.delete(player.guildId)
    this.emit(AqualinkEvents.PlayerDestroy, player)
  }

  async destroyPlayer(guildId) {
    const player = this.players.get(guildId)
    if (!player) return
    this.players.delete(guildId)
    _safeCall(() => player.removeAllListeners())
    await _safeCall(async () => await player.destroy())
  }

  async resolve({ query, source = this.defaultSearchPlatform, requester, nodes }) {
    if (!this.initiated) throw new Error('Aqua not initialized')
    const node = this._getRequestNode(nodes)
    if (!node) throw new Error('No nodes available')
    const formatted = _formatQuery(query, source)
    const endpoint = `/${this.restVersion}/loadtracks?identifier=${encodeURIComponent(formatted)}`
    try {
      const response = await node.rest.makeRequest('GET', endpoint)
      if (!response || response.loadType === 'empty' || response.loadType === 'NO_MATCHES') return EMPTY_TRACKS_RESPONSE
      return this._constructResponse(response, requester, node)
    } catch (error) {
      throw new Error(error?.name === 'AbortError' ? 'Request timeout' : `Resolve failed: ${error?.message || String(error)}`)
    }
  }

  _getRequestNode(nodes) {
    if (!nodes) return this._chooseLeastBusyNode(this.leastUsedNodes)
    if (nodes instanceof Node) return nodes
    if (Array.isArray(nodes)) {
      const candidates = nodes.filter(n => n?.connected)
      return this._chooseLeastBusyNode(candidates.length ? candidates : this.leastUsedNodes)
    }
    if (typeof nodes === 'string') {
      const node = this.nodeMap.get(nodes)
      return node?.connected ? node : this._chooseLeastBusyNode(this.leastUsedNodes)
    }
    throw new TypeError(`Invalid nodes: ${typeof nodes}`)
  }

  _chooseLeastBusyNode(nodes) {
    if (!nodes?.length) return null
    if (nodes.length === 1) return nodes[0]
    return nodes.reduce((best, node) => {
      const score = this._getNodeLoad(node)
      const bestScore = this._getNodeLoad(best)
      return score < bestScore ? node : best
    })
  }

  _constructResponse(response, requester, node) {
    const { loadType, data, pluginInfo: rootPlugin } = response || {}
    const base = { loadType, exception: null, playlistInfo: null, pluginInfo: rootPlugin || {}, tracks: [] }
    if (loadType === 'error' || loadType === 'LOAD_FAILED') {
      base.exception = data || response.exception || null
      return base
    }
    switch (loadType) {
      case 'track':
        if (data) {
          base.pluginInfo = data.info?.pluginInfo || data.pluginInfo || base.pluginInfo
          base.tracks.push(_makeTrack(data, requester, node))
        }
        break
      case 'playlist':
        if (data) {
          const info = data.info || null
          const thumbnail = data.pluginInfo?.artworkUrl || data.tracks?.[0]?.info?.artworkUrl || null
          if (info) base.playlistInfo = { name: info.name || info.title, thumbnail, ...info }
          base.pluginInfo = data.pluginInfo || base.pluginInfo
          base.tracks = Array.isArray(data.tracks) ? data.tracks.map(t => _makeTrack(t, requester, node)) : []
        }
        break
      case 'search':
        base.tracks = Array.isArray(data) ? data.map(t => _makeTrack(t, requester, node)) : []
        break
    }
    return base
  }

  get(guildId) {
    const player = this.players.get(guildId)
    if (!player) throw new Error(`Player not found: ${guildId}`)
    return player
  }

  async search(query, requester, source = this.defaultSearchPlatform) {
    if (!query || !requester) return null
    try {
      const { tracks } = await this.resolve({ query, source: source || this.defaultSearchPlatform, requester })
      return tracks || null
    } catch { return null }
  }

  async loadPlayers(filePath = './AquaPlayers.jsonl') {
    const lockFile = `${filePath}.lock`
    try {
      await fs.promises.access(filePath).catch(_noop)
      await fs.promises.writeFile(lockFile, String(process.pid), { flag: 'wx' }).catch(_noop)
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
    } catch {} finally {
      await fs.promises.unlink(lockFile).catch(_noop)
    }
  }

  async savePlayer(filePath = './AquaPlayers.jsonl') {
    const lockFile = `${filePath}.lock`
    try {
      await fs.promises.writeFile(lockFile, String(process.pid), { flag: 'wx' }).catch(_noop)
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
          q: (player.queue?.tracks?.slice(0, 10) || []).map(tr => tr.uri),
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
      this.emit(AqualinkEvents.Error, null, error)
    } finally {
      await fs.promises.unlink(lockFile).catch(_noop)
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
      const validTracks = resolved.flatMap(r => r?.tracks || [])
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
          player.nowPlayingMessage = await channel.messages.fetch(p.nw).catch(() => null)
        }
      }
    } catch {}
  }

  _parseRequester(str) {
    if (!str || typeof str !== 'string') return null
    try { return JSON.parse(str) }
    catch {
      const i = str.indexOf(':')
      return i > 0 ? { id: str.substring(0, i), username: str.substring(i + 1) } : null
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

  _scheduleCleanup() {
    if (this._cleanupTimer) {
      clearTimeout(this._cleanupTimer)
      this._cleanupTimer = null
    }
    this._cleanupTimer = setTimeout(() => this._performCleanup(), 60000)
    if (this._cleanupTimer?.unref) this._cleanupTimer.unref()
  }

  _performCleanup() {
    const now = Date.now()
    for (const [guildId, state] of this._brokenPlayers) {
      if (now - state.brokenAt > BROKEN_PLAYER_TTL) this._brokenPlayers.delete(guildId)
    }
    for (const [id, ts] of this._lastFailoverAttempt) {
      if (now - ts > FAILOVER_CLEANUP_TTL) {
        this._lastFailoverAttempt.delete(id)
        this._failoverQueue.delete(id)
      }
    }
    this._trimBrokenPlayers()
    if (this._failoverQueue.size > MAX_FAILOVER_QUEUE) this._failoverQueue.clear()
    if (this._rebuildLocks.size > 100) this._rebuildLocks.clear()
    for (const [id] of this._nodeStates) {
      if (!this.nodeMap.has(id)) this._nodeStates.delete(id)
    }
    this._scheduleCleanup()
  }

  _trimBrokenPlayers() {
    if (this._brokenPlayers.size <= MAX_BROKEN_PLAYERS) return
    const sorted = [...this._brokenPlayers.entries()].sort((a, b) => a[1].brokenAt - b[1].brokenAt)
    sorted.slice(0, sorted.length - MAX_BROKEN_PLAYERS).forEach(([id]) => this._brokenPlayers.delete(id))
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
