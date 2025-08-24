'use strict'

const fs = require('node:fs')
const readline = require('node:readline')
const { EventEmitter } = require('tseep')
const Node = require('./Node')
const Player = require('./Player')
const Track = require('./Track')
const SearchPlatforms = require('./SearchPlatforms')
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

const DEFAULT_OPTIONS = Object.freeze({
  shouldDeleteMessage: false,
  defaultSearchPlatform: 'ytsearch',
  leaveOnEnd: false,
  restVersion: 'v4',
  plugins: [],
  autoResume: true,
  infiniteReconnects: true,
  urlFilteringEnabled: false,
  restrictedDomains: [],
  allowedDomains: [],
  failoverOptions: Object.freeze({
    enabled: true,
    maxRetries: 3,
    retryDelay: 1000,
    preservePosition: true,
    resumePlayback: true,
    cooldownTime: 5000,
    maxFailoverAttempts: 5,
    healthCheck: {
      enabled: true,
      interval: 30000,
      timeout: 5000
    }
  }),
  resilienceOptions: Object.freeze({
    enabled: true,
    strategy: 'priority',
    maxRetries: 5,
    retryDelay: 2000,
    retryBackoff: true,
    maxRetryDelay: 10000,
    preservePosition: true,
    resumePlayback: true,
    cooldownTime: 30000,
    maxFailoverAttempts: 10,
    healthCheck: {
      enabled: true,
      interval: 15000,
      timeout: 3000,
      maxFailures: 3,
      recoveryDelay: 60000
    },
    notifications: {
      enabled: true,
      events: ['failover', 'recovery', 'exhausted'],
      webhook: 'https://discord.com/api/webhooks/id/token'
    },
    persistence: {
      enabled: true,
      saveQueue: true,
      saveFilters: true,
      saveVolume: true
    }
  })
})

const CLEANUP_INTERVAL = 180000
const MAX_CONCURRENT_OPS = 10
const BROKEN_PLAYER_TTL = 300000
const FAILOVER_CLEANUP_TTL = 600000
const PLAYER_BATCH_SIZE = 20
const SEEK_DELAY = 120
const RECONNECT_DELAY = 400
const CACHE_VALID_TIME = 12000
const NODE_TIMEOUT = 30000
const URL_PATTERN = /^https?:\/\//i

const _normalizeHost = (h) => {
  if (!h) return ''
  h = h.toLowerCase()
  if (h.startsWith('www.')) h = h.slice(4)
  return h.endsWith('.') ? h.slice(0, -1) : h
}

const _hostMatchesSuffix = (host, suffix) => {
  host = _normalizeHost(host)
  suffix = _normalizeHost(suffix)
  return host === suffix || host.endsWith('.' + suffix)
}

const _isProbablyUrl = (s) => typeof s === 'string' && s.length > 8 && URL_PATTERN.test(s)

const _delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

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

    this.options = Object.assign({}, DEFAULT_OPTIONS, options)
    this.failoverOptions = Object.assign({}, DEFAULT_OPTIONS.failoverOptions, options.failoverOptions)
    this.resilienceOptions = Object.assign({}, DEFAULT_OPTIONS.resilienceOptions, options.resilienceOptions)
    this.shouldDeleteMessage = this.options.shouldDeleteMessage
    this.defaultSearchPlatform = this.options.defaultSearchPlatform
    this.leaveOnEnd = this.options.leaveOnEnd
    this.restVersion = this.options.restVersion || 'v4'
    this.plugins = this.options.plugins
    this.autoResume = this.options.autoResume
    this.infiniteReconnects = this.options.infiniteReconnects
    this.urlFilteringEnabled = this.options.urlFilteringEnabled
    this.restrictedDomains = this.options.restrictedDomains || []
    this.allowedDomains = this.options.allowedDomains || []
    this.send = this.options.send || this._createDefaultSend()

    this._nodeStates = new Map()
    this._failoverQueue = new Map()
    this._lastFailoverAttempt = new Map()
    this._brokenPlayers = new Map()
    this._rebuildLocks = new Set()
    this._leastUsedNodesCache = null
    this._leastUsedNodesCacheTime = 0
    this._nodeLoadCache = new Map()
    this._nodeLoadCacheTime = new Map()

    this.on('nodeReady', (node, { resumed }) => {
      for (const player of this.players.values()) {
        if (player.nodes === node && player.connection) {
          player.connection.resendVoiceUpdate({ resume: !!resumed })
        }
      }
    })

    this._bindEventHandlers()
    this._startCleanupTimer()
    this._startHealthCheckTimer()
  }

  _getDomainLists() {
    if (this._domainLists) return this._domainLists

    const allowedHostSuffixes = []
    const allowedRegexes = []
    for (const d of this.allowedDomains) {
      if (!d) continue
      if (d instanceof RegExp) allowedRegexes.push(d)
      else allowedHostSuffixes.push(_normalizeHost(String(d)))
    }

    const restrictedHostSuffixes = []
    const restrictedRegexes = []
    for (const d of this.restrictedDomains) {
      if (!d) continue
      if (d instanceof RegExp) restrictedRegexes.push(d)
      else restrictedHostSuffixes.push(_normalizeHost(String(d)))
    }

    this._domainLists = { allowedHostSuffixes, allowedRegexes, restrictedHostSuffixes, restrictedRegexes }
    return this._domainLists
  }

  _createDefaultSend() {
    return packet => {
      const guildId = packet?.d?.guild_id
      if (!guildId) return
      const guild = this.client.cache?.guilds?.get?.(guildId) ?? this.client.guilds?.cache?.get?.(guildId)
      if (!guild) return
      const gateway = this.client.gateway
      if (gateway?.send) {
        gateway.send(gateway.calculateShardId(guildId), packet)
      } else if (guild.shard?.send) {
        guild.shard.send(packet)
      }
    }
  }

  _bindEventHandlers() {
    if (!this.autoResume) return
    this._onNodeConnect = node => queueMicrotask(() => {
      this._invalidateCache()
      this._rebuildBrokenPlayers(node)
    })
    this._onNodeDisconnect = node => queueMicrotask(() => {
      this._invalidateCache()
      this._storeBrokenPlayers(node)
    })
    this.on('nodeConnect', this._onNodeConnect)
    this.on('nodeDisconnect', this._onNodeDisconnect)
  }

  _startCleanupTimer() {
    this._cleanupTimer = setInterval(() => this._performCleanup(), CLEANUP_INTERVAL)
    if (this._cleanupTimer.unref) this._cleanupTimer.unref()
  }

  get leastUsedNodes() {
    const now = Date.now()
    if (this._leastUsedNodesCache && (now - this._leastUsedNodesCacheTime) < CACHE_VALID_TIME) {
      return this._leastUsedNodesCache
    }
    const connected = Array.from(this.nodeMap.values()).filter(node => node.connected)
    connected.sort((a, b) => this._getCachedNodeLoad(a) - this._getCachedNodeLoad(b))
    this._leastUsedNodesCache = Object.freeze(connected)
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
    if (cacheTime && (now - cacheTime) < 5000) {
      return this._nodeLoadCache.get(nodeId) || 0
    }
    const load = this._calculateNodeLoad(node)
    this._nodeLoadCache.set(nodeId, load)
    this._nodeLoadCacheTime.set(nodeId, now)
    return load
  }

  _calculateNodeLoad(node) {
    const stats = node?.stats
    if (!stats) return 0
    const cpu = stats.cpu
    const cores = Math.max(1, cpu?.cores || 1)
    const cpuLoad = cpu ? (cpu.systemLoad / cores) : 0
    const playing = stats.playingPlayers || 0
    const memory = stats.memory
    const memoryUsage = memory ? (memory.used / Math.max(1, memory.reservable)) : 0
    const restCalls = node?.rest?.calls || 0
    return (cpuLoad * 100) + (playing * 0.75) + (memoryUsage * 40) + (restCalls * 0.001)
  }

  async init(clientId) {
    if (this.initiated) return this
    this.clientId = clientId
    if (!this.clientId) return
    const results = await Promise.allSettled(
      this.nodes.map(n =>
        Promise.race([
          this._createNode(n),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Node timeout')), NODE_TIMEOUT))
        ])
      )
    )
    const successCount = results.filter(r => r.status === 'fulfilled').length
    if (!successCount) throw new Error('No nodes connected')
    await this._loadPlugins()
    this.initiated = true
    return this
  }

  async _loadPlugins() {
    if (!this.plugins?.length) return
    await Promise.allSettled(
      this.plugins.map(async plugin => {
        try {
          await plugin.load(this)
        } catch (err) {
          this.emit('error', null, new Error(`Plugin error: ${err?.message || String(err)}`))
        }
      })
    )
  }

  async _createNode(options) {
    const nodeId = options.name || options.host
    this._destroyNode(nodeId)
    const node = new Node(this, options, this.options)
    if (!node.players) node.players = new Set()
    this.nodeMap.set(nodeId, node)
    this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false, failures: 0 })
    try {
      await node.connect()
      this._nodeStates.set(nodeId, { connected: true, failoverInProgress: false })
      this._invalidateCache()
      this.emit('nodeCreate', node)
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
      this.emit('nodeDestroy', node)
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
    if (this._leastUsedNodesCache?.some?.(n => (n.name || n.host) === nodeId)) {
      this._invalidateCache()
    }
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
    for (const [guildId, brokenState] of this._brokenPlayers) {
      if (brokenState.originalNodeId !== nodeId) continue
      if (Date.now() - brokenState.brokenAt > BROKEN_PLAYER_TTL) continue
      rebuilds.push({ guildId, brokenState })
    }
    if (!rebuilds.length) return
    const batchSize = Math.min(MAX_CONCURRENT_OPS, rebuilds.length)
    const successes = []
    for (const i of _range(0, rebuilds.length, batchSize)) {
      const batch = rebuilds.slice(i, i + batchSize)
      const results = await Promise.allSettled(
        batch.map(({ guildId, brokenState }) =>
          this._rebuildPlayer(brokenState, node).then(() => guildId)
        )
      )
      for (const r of results) {
        if (r.status === 'fulfilled') successes.push(r.value)
      }
    }
    for (const guildId of successes) {
      this._brokenPlayers.delete(guildId)
    }
    if (successes.length) this.emit('playersRebuilt', node, successes.length)
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
        if (brokenState.position > 0) {
          setTimeout(() => player.seek?.(brokenState.position), SEEK_DELAY)
        }
        if (brokenState.paused) {
          await player.pause(true)
        }
      }
      return player
    } finally {
      this._rebuildLocks.delete(lockKey)
    }
  }

  async handleNodeFailover(failedNode) {
    const resilience = this.resilienceOptions.enabled ? this.resilienceOptions : this.failoverOptions
    if (!resilience.enabled) return

    const nodeId = failedNode.name || failedNode.host
    const now = Date.now()
    const nodeState = this._nodeStates.get(nodeId)
    if (nodeState?.failoverInProgress) return
    const lastAttempt = this._lastFailoverAttempt.get(nodeId)
    if (lastAttempt && (now - lastAttempt) < resilience.cooldownTime) return
    const attempts = this._failoverQueue.get(nodeId) || 0
    if (attempts >= resilience.maxFailoverAttempts) {
      if (this.resilienceOptions.notifications.enabled && this.resilienceOptions.notifications.events.includes('exhausted')) {
        this._sendWebhookNotification('exhausted', failedNode)
      }
      return
    }
    this._nodeStates.set(nodeId, { ...nodeState, connected: false, failoverInProgress: true })
    this._lastFailoverAttempt.set(nodeId, now)
    this._failoverQueue.set(nodeId, attempts + 1)
    try {
      this.emit('nodeFailover', failedNode)
      if (this.resilienceOptions.notifications.enabled && this.resilienceOptions.notifications.events.includes('failover')) {
        this._sendWebhookNotification('failover', failedNode)
      }
      const affectedPlayers = Array.from(failedNode.players || [])
      if (!affectedPlayers.length) {
        this._nodeStates.set(nodeId, { ...nodeState, connected: false, failoverInProgress: false })
        return
      }
      const availableNodes = this._getAvailableNodes(failedNode)
      if (!availableNodes.length) throw new Error('No failover nodes available')

      let sortedNodes
      if (resilience.strategy === 'priority') {
        sortedNodes = availableNodes.sort((a, b) => a.priority - b.priority || this._getCachedNodeLoad(a) - this._getCachedNodeLoad(b))
      } else if (resilience.strategy === 'load-based') {
        sortedNodes = availableNodes.sort((a, b) => this._getCachedNodeLoad(a) - this._getCachedNodeLoad(b))
      } else { 
        sortedNodes = availableNodes
      }

      const results = await this._migratePlayersOptimized(affectedPlayers, sortedNodes)
      const successful = results.filter(r => r.success).length
      if (successful) {
        this.emit('nodeFailoverComplete', failedNode, successful, results.length - successful)
        if (this.resilienceOptions.notifications.enabled && this.resilienceOptions.notifications.events.includes('recovery')) {
          this._sendWebhookNotification('recovery', failedNode, successful)
        }
      }
    } catch (error) {
      this.emit('error', null, new Error(`Failover failed: ${error?.message || String(error)}`))
    } finally {
      this._nodeStates.set(nodeId, { ...nodeState, connected: false, failoverInProgress: false })
    }
  }

  async _migratePlayersOptimized(players, availableNodes) {
    const baseLoads = new Map()
    const assignedCounts = new Map()
    for (const n of availableNodes) {
      baseLoads.set(n, this._getCachedNodeLoad(n))
      assignedCounts.set(n, 0)
    }
    const pickNode = () => {
      const best = availableNodes.reduce((acc, n) => {
        const score = baseLoads.get(n) + (assignedCounts.get(n) || 0)
        return score < acc.score ? { node: n, score } : acc
      }, { node: null, score: Infinity }).node
      assignedCounts.set(best, (assignedCounts.get(best) || 0) + 1)
      return best
    }
    const results = []
    for (const i of _range(0, players.length, MAX_CONCURRENT_OPS)) {
      const batch = players.slice(i, i + MAX_CONCURRENT_OPS)
      const batchResults = await Promise.allSettled(batch.map(p => this._migratePlayer(p, pickNode)))
      results.push(...batchResults.map(r => ({ success: r.status === 'fulfilled', error: r.reason })))
    }
    return results
  }

  async _migratePlayer(player, pickNode) {
    const resilience = this.resilienceOptions.enabled ? this.resilienceOptions : this.failoverOptions
    const playerState = this._capturePlayerState(player)
    if (!playerState) throw new Error('Failed to capture state')
    for (let retry = 0; retry < resilience.maxRetries; retry++) {
      try {
        const targetNode = pickNode()
        const newPlayer = await this._createPlayerOnNode(targetNode, playerState)
        await this._restorePlayerState(newPlayer, playerState)
        this.emit('playerMigrated', player, newPlayer, targetNode)
        return newPlayer
      } catch (error) {
        if (retry === resilience.maxRetries - 1) throw error
        let delay = resilience.retryDelay
        if (resilience.retryBackoff) {
          delay = Math.min(delay * Math.pow(1.5, retry), resilience.maxRetryDelay)
        }
        await _delay(delay)
      }
    }
  }

  _capturePlayerState(player) {
    if (!player) return null
    const state = {
      guildId: player.guildId,
      textChannel: player.textChannel,
      voiceChannel: player.voiceChannel,
      volume: player.volume ?? 100,
      paused: !!player.paused,
      position: player.position || 0,
      current: player.current || null,
      queue: player.queue?.tracks?.slice(0, 50) || EMPTY_ARRAY,
      repeat: player.loop,
      shuffle: player.shuffle,
      deaf: player.deaf ?? false,
      connected: !!player.connected
    }
    if (this.resilienceOptions.persistence.enabled && this.resilienceOptions.persistence.saveFilters) {
      state.filters = player.filters.filters
    }
    return state
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
    const resilience = this.resilienceOptions.enabled ? this.resilienceOptions : this.failoverOptions
    const operations = []
    if (typeof playerState.volume === 'number') {
      if (typeof newPlayer.setVolume === 'function') {
        operations.push(newPlayer.setVolume(playerState.volume))
      } else {
        newPlayer.volume = playerState.volume
      }
    }
    if (playerState.queue?.length && newPlayer.queue?.add) {
      newPlayer.queue.add(...playerState.queue)
    }
    if (playerState.current && resilience.preservePosition) {
      if (newPlayer.queue?.add) {
        newPlayer.queue.add(playerState.current, { toFront: true })
      }
      if (resilience.resumePlayback) {
        operations.push(newPlayer.play())
        if (playerState.position > 0) {
          setTimeout(() => newPlayer.seek?.(playerState.position), SEEK_DELAY)
        }
        if (playerState.paused) {
          operations.push(newPlayer.pause(true))
        }
      }
    }
    Object.assign(newPlayer, { repeat: playerState.repeat, shuffle: playerState.shuffle })
    if (playerState.filters && this.resilienceOptions.persistence.saveFilters) {
      await newPlayer.filters.updateFilters(playerState.filters)
    }
    await Promise.allSettled(operations)
  }

  updateVoiceState({ d, t }) {
    if (!d?.guild_id) return
    if (t !== 'VOICE_STATE_UPDATE' && t !== 'VOICE_SERVER_UPDATE') return
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
    const filtered = Array.from(this.nodeMap.values())
      .filter(node => node.connected && node.region === lowerRegion)
      .sort((a, b) => a.priority - b.priority || this._getCachedNodeLoad(a) - this._getCachedNodeLoad(b))
    return Object.freeze(filtered)
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
    if (existing) {
      try { existing.destroy?.() } catch { }
    }
    const player = new Player(this, node, options)
    this.players.set(options.guildId, player)
    node?.players?.add?.(player)
    player.once('destroy', () => this._handlePlayerDestroy(player))
    player.connect(options)
    this.emit('playerCreate', player)
    return player
  }

  _handlePlayerDestroy(player) {
    const node = player.nodes
    node?.players?.delete?.(player)
    if (this.players.get(player.guildId) === player) {
      this.players.delete(player.guildId)
    }
    this.emit('playerDestroy', player)
  }

  async destroyPlayer(guildId) {
    const player = this.players.get(guildId)
    if (!player) return
    try {
      this.players.delete(guildId)
      player.removeAllListeners?.()
      await player.destroy?.()
    } finally { }
  }

  _isUrlAllowed(url) {
    if (!this.urlFilteringEnabled || !_isProbablyUrl(url)) return true
    const hostname = _safeGetHostname(url)
    if (!hostname) return false
    const { allowedHostSuffixes, allowedRegexes, restrictedHostSuffixes, restrictedRegexes } = this._getDomainLists()
    if (allowedHostSuffixes.length || allowedRegexes.length) {
      for (const rx of allowedRegexes) {
        if (rx.test(hostname)) return true
      }
      for (const suffix of allowedHostSuffixes) {
        if (_hostMatchesSuffix(hostname, suffix)) return true
      }
      return false
    }
    if (restrictedHostSuffixes.length || restrictedRegexes.length) {
      for (const rx of restrictedRegexes) {
        if (rx.test(hostname)) return false
      }
      for (const suffix of restrictedHostSuffixes) {
        if (_hostMatchesSuffix(hostname, suffix)) return false
      }
    }
    return true
  }

  _resolveSearchPlatform(source) {
    if (!source) return this.defaultSearchPlatform
    const normalized = source.toLowerCase().trim()
    return SearchPlatforms.SEARCH_PLATFORMS[normalized] || source
  }

  _validateSourceRegex(urlStr) {
    if (!_isProbablyUrl(urlStr)) return null
    const parsed = _safeParseUrl(urlStr)
    if (!parsed) return null
    const { host, path } = parsed
    if (/\.(mp3|m3u8?|mp4|m4a|wav|aacp)(?:$|\?)/i.test(path)) return 'http'
    const hostMapping = {
      'music.youtube.com': 'ytmsearch',
      'youtu.be': 'ytsearch',
      'youtube.com': 'ytsearch',
      'soundcloud.com': 'scsearch',
      'soundcloud.app.goo.gl': 'scsearch',
      'open.spotify.com': 'spsearch',
      'deezer.com': 'dzsearch',
      'deezer.page.link': 'dzsearch',
      'music.apple.com': 'amsearch',
      'tidal.com': 'tdsearch',
      'listen.tidal.com': 'tdsearch',
      'jiosaavn.com': 'jssearch',
      'music.yandex.ru': 'ymsearch',
      'bandcamp.com': 'bcsearch'
    }
    for (const [hostSuffix, platform] of Object.entries(hostMapping)) {
      if (host === hostSuffix || _hostMatchesSuffix(host, hostSuffix)) return platform
    }
    const linkHosts = ['twitch.tv', 'vimeo.com', 'tiktok.com', 'mixcloud.com', 'radiohost.de']
    for (const linkHost of linkHosts) {
      if (_hostMatchesSuffix(host, linkHost)) return 'link'
    }
    return null
  }

  async resolve({ query, source = this.defaultSearchPlatform, requester, nodes }) {
    if (!this.initiated) throw new Error('Aqua not initialized')
    const requestNode = this._getRequestNode(nodes)
    if (!requestNode) throw new Error('No nodes available')
    if (this.restrictedDomains.length > 0) {
      if (_isProbablyUrl(query) && !this._isUrlAllowed(query)) {
        this.emit('debug', `Blocked URL by domain restrictions: ${query}`)
        return EMPTY_TRACKS_RESPONSE
      }
    }
    const formattedQuery = _isProbablyUrl(query) ? query : `${source}${SEARCH_PREFIX}${query}`
    try {
      const endpoint = `/${this.restVersion}/loadtracks?identifier=${encodeURIComponent(formattedQuery)}`
      const response = await requestNode.rest.makeRequest('GET', endpoint)
      if (!response || response.loadType === 'empty' || response.loadType === 'NO_MATCHES') {
        return EMPTY_TRACKS_RESPONSE
      }
      return this._constructResponse(response, requester, requestNode)
    } catch (error) {
      throw new Error(error?.name === 'AbortError' ? 'Request timeout' : `Resolve failed: ${error?.message || String(error)}`)
    }
  }

  _getRequestNode(nodes) {
    if (!nodes) {
      const chosen = this._chooseLeastBusyNode(this.leastUsedNodes)
      if (!chosen) throw new Error('No nodes available')
      return chosen
    }
    if (nodes instanceof Node) return nodes
    if (Array.isArray(nodes)) {
      const candidates = nodes.filter(n => n?.connected)
      const chosen = this._chooseLeastBusyNode(candidates.length ? candidates : this.leastUsedNodes)
      if (!chosen) throw new Error('No nodes available')
      return chosen
    }
    if (typeof nodes === 'string') {
      const node = this.nodeMap.get(nodes)
      if (node?.connected) return node
      const chosen = this._chooseLeastBusyNode(this.leastUsedNodes)
      if (!chosen) throw new Error('No nodes available')
      return chosen
    }
    throw new TypeError(`Invalid nodes parameter: ${typeof nodes}`)
  }

  _chooseLeastBusyNode(nodes) {
    if (!nodes?.length) return null
    if (nodes.length === 1) return nodes[0]
    return nodes.reduce((acc, node) => {
      const score = this._getCachedNodeLoad(node)
      return score < acc.score ? { node, score } : acc
    }, { node: nodes[0], score: this._getCachedNodeLoad(nodes[0]) }).node
  }

  _constructResponse(response, requester, requestNode) {
    const { loadType, data, pluginInfo: rootPluginInfo } = response || {}
    const baseResponse = {
      loadType,
      exception: null,
      playlistInfo: null,
      pluginInfo: rootPluginInfo ?? {},
      tracks: []
    }
    if (loadType === 'error' || loadType === 'LOAD_FAILED') {
      baseResponse.exception = data ?? response.exception ?? null
      return baseResponse
    }
    const makeTrack = t => new Track(t, requester, requestNode)
    switch (loadType) {
      case 'track': {
        if (data) {
          baseResponse.pluginInfo = data.info?.pluginInfo ?? data.pluginInfo ?? baseResponse.pluginInfo
          baseResponse.tracks.push(makeTrack(data))
        }
        break
      }
      case 'playlist': {
        if (data) {
          const info = data.info ?? null
          const thumbnail = data.pluginInfo?.artworkUrl || data.tracks?.[0]?.info?.artworkUrl || null
          if (info) {
            baseResponse.playlistInfo = { name: info.name || info.title, thumbnail, ...info }
          }
          baseResponse.pluginInfo = data.pluginInfo ?? baseResponse.pluginInfo
          baseResponse.tracks = Array.isArray(data.tracks) ? data.tracks.map(makeTrack) : []
        }
        break
      }
      case 'search': {
        baseResponse.tracks = Array.isArray(data) ? data.map(makeTrack) : []
        break
      }
    }
    return baseResponse
  }

  get(guildId) {
    const player = this.players.get(guildId)
    if (!player) throw new Error(`Player not found: ${guildId}`)
    return player
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
      await fs.promises.writeFile(lockFile, process.pid.toString(), { flag: 'wx' }).catch(() => null)
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
      if (batch.length) {
        await Promise.allSettled(batch.map(p => this._restorePlayer(p)))
      }
      await fs.promises.writeFile(filePath, '')
    } catch (error) {
      this.emit('debug', 'Aqua', `Load players error: ${error?.message || String(error)}`)
    } finally {
      await fs.promises.unlink(lockFile).catch(() => { })
    }
  }

  async savePlayer(filePath = './AquaPlayers.jsonl') {
    const persistence = this.resilienceOptions.persistence
    if (!persistence.enabled) return

    const lockFile = `${filePath}.lock`
    try {
      await fs.promises.writeFile(lockFile, process.pid.toString(), { flag: 'wx' }).catch(() => null)
      const ws = fs.createWriteStream(filePath, { encoding: 'utf8', flags: 'w' })
      const buffer = []
      const count = this.players.size
      for (const player of this.players.values()) {
        const requester = player.requester || player.current?.requester
        const data = {
          g: player.guildId,
          t: player.textChannel,
          v: player.voiceChannel,
          u: player.current?.uri || null,
          p: player.position || 0,
          ts: player.timestamp || 0,
          q: persistence.saveQueue ? player.queue?.tracks?.slice(0, 10).map(tr => tr.uri) || [] : [],
          r: requester ? JSON.stringify({ id: requester.id, username: requester.username }) : null,
          vol: persistence.saveVolume ? player.volume : 100,
          pa: player.paused,
          pl: player.playing,
          nw: player.nowPlayingMessage?.id || null
        }
        if (persistence.saveFilters) {
          data.f = player.filters.filters
        }
        buffer.push(JSON.stringify(data))
        if (buffer.length >= 100) {
          ws.write(buffer.join('\n') + '\n')
          buffer.length = 0
        }
      }
      if (buffer.length) ws.write(buffer.join('\n') + '\n')
      await new Promise(resolve => ws.end(resolve))
      this.emit('debug', 'Aqua', `Saved ${count} players to ${filePath}`)
    } catch (error) {
      this.emit('error', null, new Error(`Save players failed: ${error?.message || String(error)}`))
    } finally {
      await fs.promises.unlink(lockFile).catch(() => { })
    }
  }

  async _restorePlayer(p) {
    const persistence = this.resilienceOptions.persistence
    if (!persistence.enabled) return

    try {
      const player = this.players.get(p.g) || this.createPlayer(this._chooseLeastBusyNode(this.leastUsedNodes), {
        guildId: p.g,
        textChannel: p.t,
        voiceChannel: p.v,
        defaultVolume: persistence.saveVolume ? p.vol || 65 : 65,
        deaf: true
      })
      const requester = this._parseRequester(p.r)
      const tracksToResolve = persistence.saveQueue ? [p.u, ...(p.q || [])].filter(Boolean).slice(0, 20) : [p.u].filter(Boolean)
      const resolved = await Promise.all(tracksToResolve.map(uri => this.resolve({ query: uri, requester }).catch(() => null)))
      const validTracks = resolved.filter(r => r?.tracks?.length).flatMap(r => r.tracks)
      if (validTracks.length && player.queue?.add) {
        if (player.queue.tracks?.length <= 2) player.queue.tracks = []
        player.queue.add(...validTracks)
      }
      if (p.u && validTracks[0]) {
        if (persistence.saveVolume && p.vol != null) {
          if (typeof player.setVolume === 'function') {
            await player.setVolume(p.vol)
          } else {
            player.volume = p.vol
          }
        }
        if (persistence.saveFilters && p.f) {
          await player.filters.updateFilters(p.f)
        }
        await player.play()
        if (p.p > 0) setTimeout(() => player.seek?.(p.p), SEEK_DELAY)
        if (p.pa) await player.pause(true)
      }
      if (p.nw && p.t) {
        const channel = this.client.channels?.cache?.get(p.t)
        if (channel?.messages) {
          try {
            player.nowPlayingMessage = await channel.messages.fetch(p.nw).catch(() => null)
          } catch { }
        }
      }
    } catch (error) {
      this.emit('debug', 'Aqua', `Error restoring player for guild ${p.g}: ${error?.message || String(error)}`)
    }
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
          this.off('nodeConnect', onReady)
          this.off('nodeCreate', onReady)
          resolve()
        }
      }
      const timer = setTimeout(() => {
        this.off('nodeConnect', onReady)
        this.off('nodeCreate', onReady)
        reject(new Error('Timeout waiting for first node'))
      }, timeout)
      this.on('nodeConnect', onReady)
      this.on('nodeCreate', onReady)
      onReady()
    })
  }

  _performCleanup() {
    const now = Date.now()
    const expiredGuilds = []
    for (const [guildId, state] of this._brokenPlayers) {
      if (now - state.brokenAt > BROKEN_PLAYER_TTL) expiredGuilds.push(guildId)
    }
    for (const g of expiredGuilds) this._brokenPlayers.delete(g)
    const expiredNodes = []
    for (const [nodeId, ts] of this._lastFailoverAttempt) {
      if (now - ts > FAILOVER_CLEANUP_TTL) expiredNodes.push(nodeId)
    }
    for (const n of expiredNodes) {
      this._lastFailoverAttempt.delete(n)
      this._failoverQueue.delete(n)
    }
    if (this._nodeLoadCache.size > 50) {
      this._nodeLoadCache.clear()
      this._nodeLoadCacheTime.clear()
    }
  }

  _getAvailableNodes(excludeNode) {
    return Array.from(this.nodeMap.values()).filter(node => node !== excludeNode && node.connected)
  }

  destroy() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer)
      this._healthCheckTimer = null
    }
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer)
      this._cleanupTimer = null
    }
    if (this._onNodeConnect) {
      this.off('nodeConnect', this._onNodeConnect)
      this.off('nodeDisconnect', this._onNodeDisconnect)
    }
    const tasks = []
    for (const player of this.players.values()) {
      player.removeAllListeners?.()
      tasks.push(Promise.resolve(player.destroy?.()).catch(() => { }))
    }
    for (const node of this.nodeMap.values()) {
      tasks.push(Promise.resolve(node.destroy?.()).catch(() => { }))
    }
    this.players.clear()
    this.nodeMap.clear()
    this._nodeStates.clear()
    this._failoverQueue.clear()
    this._lastFailoverAttempt.clear()
    this._brokenPlayers.clear()
    this._nodeLoadCache.clear()
    this._nodeLoadCacheTime.clear()
    this._leastUsedNodesCache = null
    this.removeAllListeners()
    return Promise.all(tasks)
  }

  _startHealthCheckTimer() {
    if (!this.resilienceOptions.enabled || !this.resilienceOptions.healthCheck.enabled) return
    this._healthCheckTimer = setInterval(() => this._performHealthCheck(), this.resilienceOptions.healthCheck.interval)
    if (this._healthCheckTimer.unref) this._healthCheckTimer.unref()
  }

  async _performHealthCheck() {
    const healthCheckOptions = this.resilienceOptions.healthCheck
    for (const node of this.nodeMap.values()) {
      if (!node.connected) continue

      const nodeId = node.name || node.host
      const nodeState = this._nodeStates.get(nodeId) || { failures: 0 }

      try {
        const stats = await Promise.race([
          node.rest.getStats(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), healthCheckOptions.timeout))
        ])
        if (stats) {
          nodeState.failures = 0
          this._nodeStates.set(nodeId, { ...this._nodeStates.get(nodeId), ...nodeState })
        } else {
          throw new Error('No stats returned')
        }
      } catch (error) {
        nodeState.failures = (nodeState.failures || 0) + 1
        this._nodeStates.set(nodeId, { ...this._nodeStates.get(nodeId), ...nodeState })
        this.emit('debug', `Health check failed for node ${nodeId}: ${error.message}. Failures: ${nodeState.failures}`)

        if (nodeState.failures >= healthCheckOptions.maxFailures) {
          this.emit('debug', `Node ${nodeId} exceeded max health check failures. Triggering failover.`)
          node.connected = false 
          this.emit('nodeDisconnect', node, { code: 4000, reason: 'Health check failed' })

          setTimeout(() => {
            if (!node.isDestroyed) {
              node.connect().catch(err => this.emit('error', null, `Error reconnecting node ${nodeId}: ${err.message}`))
            }
          }, healthCheckOptions.recoveryDelay)
        }
      }
    }
  }

  _sendWebhookNotification(event, node, details) {
    const webhookUrl = this.resilienceOptions.notifications.webhook
    if (!webhookUrl || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) return

    const embed = {
      title: `Node ${event.charAt(0).toUpperCase() + event.slice(1)}`,
      description: `Node \`${node.name || node.host}\` has experienced a **${event}** event.`,
      color: event === 'failover' || event === 'exhausted' ? 0xFF0000 : 0x00FF00,
      timestamp: new Date().toISOString(),
      fields: []
    }

    if (details) {
      embed.fields.push({ name: 'Details', value: `Successfully migrated ${details} players.` })
    }

    const payload = {
      embeds: [embed]
    }

    const body = JSON.stringify(payload)
    const { request } = require('node:https')
    const url = new URL(webhookUrl)
    const options = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }

    const req = request(options, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        this.emit('error', null, new Error(`Webhook failed with status ${res.statusCode}`))
      }
      res.resume()
    })

    req.on('error', err => {
      this.emit('error', null, new Error(`Webhook request error: ${err.message}`))
    })

    req.write(body)
    req.end()
  }
}

const _range = function* (start, end, step = 1) {
  for (let i = start; i < end; i += step) {
    yield i
  }
}

const _safeGetHostname = (url) => {
  try {
    return _normalizeHost(new URL(url).hostname)
  } catch {
    return null
  }
}

const _safeParseUrl = (url) => {
  try {
    const u = new URL(url)
    return { host: _normalizeHost(u.hostname), path: u.pathname.toLowerCase() }
  } catch {
    return null
  }
}

module.exports = Aqua
