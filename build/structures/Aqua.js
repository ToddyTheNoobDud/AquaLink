'use strict'

const { promises: fs } = require('node:fs')
const { EventEmitter } = require('tseep')

const Node = require('./Node')
const Player = require('./Player')
const Track = require('./Track')
const { version: pkgVersion } = require('../../package.json')

const URL_REGEX = /^https?:\/\//
const GUILD_ID_REGEX = /^\d+$/

const DEFAULT_OPTIONS = Object.freeze({
  nodeResolver: 'LeastLoad',
  autoplayPlatform: ['spsearch', 'ytsearch'],
  shouldDeleteMessage: false,
  defaultSearchPlatform: 'ytsearch',
  leaveOnEnd: true,
  restVersion: 'v4',
  plugins: [],
  autoResume: false,
  infiniteReconnects: false,
  failoverOptions: {
    enabled: true,
    maxRetries: 3,
    retryDelay: 1000,
    preservePosition: true,
    resumePlayback: true,
    cooldownTime: 5000,
    maxFailoverAttempts: 5
  },
  partialTrack: [
    'pluginInfo', 'title', 'author', 'length', 'uri', 'requester', 'artworkUrl',
    'sourceName', 'identifier', 'isSeekable', 'isStream', 'position', 'isrc'
  ],
})

const CLEANUP_INTERVAL = 60000
const MAX_CONCURRENT_OPERATIONS = 3
const BROKEN_PLAYER_TTL = 300000
const FAILOVER_CLEANUP_TTL = 600000

class Aqua extends EventEmitter {
  constructor(client, nodes, options = {}) {
    super()

    if (!client) throw new Error('Client is required')
    if (!Array.isArray(nodes) || !nodes.length) {
      throw new TypeError(`Nodes must be non-empty Array (got ${typeof nodes})`)
    }

    this.client = client
    this.nodes = nodes
    this.nodeMap = new Map()
    this.players = new Map()
    this.clientId = null
    this.initiated = false
    this.version = pkgVersion
    this.manager = this

    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.failoverOptions = { ...DEFAULT_OPTIONS.failoverOptions, ...options.failoverOptions }

    this.shouldDeleteMessage = this.options.shouldDeleteMessage
    this.defaultSearchPlatform = this.options.defaultSearchPlatform
    this.leaveOnEnd = this.options.leaveOnEnd
    this.restVersion = this.options.restVersion
    this.plugins = this.options.plugins
    this.autoResume = this.options.autoResume
    this.infiniteReconnects = this.options.infiniteReconnects
    this.partialTrack = this.options.partialTrack
    this.autoplayPlatform = this.options.autoplayPlatform
    this.nodeResolver = this.options.nodeResolver
    this.send = this.options.send || this._defaultSend

    this._nodeStates = new Map()
    this._failoverQueue = new Map()
    this._lastFailoverAttempt = new Map()
    this._brokenPlayers = new Map()

    this._bindEventHandlers()
    this._startCleanupTimer()
  }

  _defaultSend = (packet) => {
    const guildId = packet.d.guild_id
    const guild = this.client?.cache?.guilds.get(guildId) ?? this.client.guilds?.cache?.get(guildId)

    if (!guild) return;

    if (this.client.gateway) {
      this.client.gateway.send(this.client.gateway.calculateShardId(guildId), packet)
    } else {
      guild.shard?.send(packet)
    }
  }

  _bindEventHandlers() {
    this._boundCleanupPlayer = this._cleanupPlayer.bind(this)
    this._boundHandleDestroy = this._handlePlayerDestroy.bind(this)
    this._boundNodeConnect = this._handleNodeConnect.bind(this)
    this._boundNodeDisconnect = this._handleNodeDisconnect.bind(this)

    this.on('nodeConnect', this._boundNodeConnect)
    this.on('nodeDisconnect', this._boundNodeDisconnect)
  }

  _startCleanupTimer() {
    this._cleanupTimer = setInterval(() => this._performCleanup(), CLEANUP_INTERVAL)
  }

  get leastUsedNodes() {
    const connectedNodes = []

    for (const node of this.nodeMap.values()) {
      if (node.connected) {
        connectedNodes.push(node)
      }
    }

    if (this.nodeResolver === 'LeastLoad') {
      return connectedNodes.sort((a, b) => this._getNodeLoad(a) - this._getNodeLoad(b))
    }

    return connectedNodes.sort((a, b) => (a.rest?.calls || 0) - (b.rest?.calls || 0))
  }

  hasAvailableNodes() {
    return this.leastUsedNodes.length > 0
  }

  async init(clientId) {
    if (this.initiated) return this

    this.clientId = clientId
    let successCount = 0

    const batchSize = 2
    for (let i = 0; i < this.nodes.length; i += batchSize) {
      const batch = this.nodes.slice(i, i + batchSize)
      const results = await Promise.allSettled(batch.map(node => this._createNode(node)))
      successCount += results.filter(r => r.status === 'fulfilled').length
    }

    if (successCount === 0) {
      throw new Error('No nodes connected')
    }

    if (this.plugins.length > 0) {
      this.plugins.forEach(plugin => {
        Promise.resolve(plugin.load(this)).catch(err =>
          this.emit('error', null, new Error(`Plugin error: ${err.message}`))
        )
      })
    }

    this.initiated = true
    return this
  }

  async _createNode(options) {
    const nodeId = options.name || options.host
    this._destroyNode(nodeId)

    const node = new Node(this, options, this.options)
    node.players = new Set()
    this.nodeMap.set(nodeId, node)

    this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false })

    try {
      await node.connect()
      this._nodeStates.set(nodeId, { connected: true, failoverInProgress: false })
      this.emit('nodeCreate', node)
      return node
    } catch (error) {
      this._cleanupNode(nodeId)
      throw error
    }
  }

  _handleNodeConnect(node) {
    if (!this.autoResume) return;

    const nodeId = node.name || node.host
    this._nodeStates.set(nodeId, { connected: true, failoverInProgress: false })

    process.nextTick(() => this._rebuildBrokenPlayers(node))
  }

  _handleNodeDisconnect(node) {
    if (!this.autoResume) return;

    const nodeId = node.name || node.host
    this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false })

    process.nextTick(() => this._storeBrokenPlayers(node))
  }

  _storeBrokenPlayers(node) {
    const nodeId = node.name || node.host
    const now = Date.now()

    for (const player of this.players.values()) {
      if (player.nodes === node) {
        const state = this._capturePlayerState(player)
        if (state) {
          state.originalNodeId = nodeId
          state.brokenAt = now
          this._brokenPlayers.set(player.guildId, state)
        }
      }
    }
  }

  _rebuildBrokenPlayers(node) {
    const nodeId = node.name || node.host
    let rebuiltCount = 0

    for (const [guildId, brokenState] of this._brokenPlayers.entries()) {
      if (brokenState.originalNodeId === nodeId) {
        this._rebuildPlayer(brokenState, node)
          .then(() => {
            this._brokenPlayers.delete(guildId)
            rebuiltCount++
          })
          .catch(() => {
            if (Date.now() - brokenState.brokenAt > BROKEN_PLAYER_TTL) {
              this._brokenPlayers.delete(guildId)
            }
          })
      }
    }

    if (rebuiltCount > 0) {
      this.emit('playersRebuilt', node, rebuiltCount)
    }
  }

  async _rebuildPlayer(brokenState, targetNode) {
    const { guildId, textChannel, voiceChannel, current, volume = 65, deaf = true } = brokenState

    const existingPlayer = this.players.get(guildId)
    if (existingPlayer) {
      await existingPlayer.destroy()
    }

    setTimeout(async () => {
      try {
        const player = await this.createConnection({
          guildId,
          textChannel,
          voiceChannel,
          defaultVolume: volume,
          deaf
        })

        if (current) {
          await player.queue.add(current)
          await player.play()
          this.emit('trackStart', player, current)
        }
      } catch (error) {
        this._brokenPlayers.delete(guildId)
      }
    }, 1000)
  }

  _destroyNode(identifier) {
    const node = this.nodeMap.get(identifier)
    if (node) {
      this._cleanupNode(identifier)
      this.emit('nodeDestroy', node)
    }
  }

  _cleanupNode(nodeId) {
    const node = this.nodeMap.get(nodeId)
    if (node) {
      node.removeAllListeners()
    }

    this.nodeMap.delete(nodeId)
    this._nodeStates.delete(nodeId)
    this._failoverQueue.delete(nodeId)
    this._lastFailoverAttempt.delete(nodeId)
  }

  async handleNodeFailover(failedNode) {
    if (!this.failoverOptions.enabled) return;

    const nodeId = failedNode.name || failedNode.host
    const now = Date.now()

    const nodeState = this._nodeStates.get(nodeId)
    if (nodeState?.failoverInProgress) return;

    const lastAttempt = this._lastFailoverAttempt.get(nodeId)
    if (lastAttempt && (now - lastAttempt) < this.failoverOptions.cooldownTime) return;

    const attempts = this._failoverQueue.get(nodeId) || 0
    if (attempts >= this.failoverOptions.maxFailoverAttempts) return;

    this._nodeStates.set(nodeId, { connected: false, failoverInProgress: true })
    this._lastFailoverAttempt.set(nodeId, now)
    this._failoverQueue.set(nodeId, attempts + 1)

    try {
      this.emit('nodeFailover', failedNode)

      const affectedPlayers = Array.from(failedNode.players)
      if (affectedPlayers.length === 0) {
        this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false })
        return;
      }

      const availableNodes = this._getAvailableNodes(failedNode)
      if (availableNodes.length === 0) {
        this.emit('error', null, new Error('No failover nodes available'))
        return;
      }

      const results = await this._migratePlayersOptimized(affectedPlayers, availableNodes)
      const successful = results.filter(r => r.success).length

      if (successful > 0) {
        this.emit('nodeFailoverComplete', failedNode, successful, results.length - successful)
      }
    } catch (error) {
      this.emit('error', null, new Error(`Failover failed: ${error.message}`))
    } finally {
      this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false })
    }
  }

  async _migratePlayersOptimized(players, availableNodes) {
    const results = []

    for (let i = 0; i < players.length; i += MAX_CONCURRENT_OPERATIONS) {
      const batch = players.slice(i, i + MAX_CONCURRENT_OPERATIONS)
      const batchResults = await Promise.allSettled(
        batch.map(player => this._migratePlayer(player, availableNodes))
      )

      results.push(...batchResults.map(r => ({
        success: r.status === 'fulfilled',
        error: r.reason
      })))
    }

    return results
  }

  async _migratePlayer(player, availableNodes) {
    let retryCount = 0

    while (retryCount < this.failoverOptions.maxRetries) {
      try {
        const targetNode = availableNodes[0]
        const playerState = this._capturePlayerState(player)

        if (!playerState) throw new Error('Failed to capture state')

        const newPlayer = await this._createPlayerOnNode(targetNode, playerState)
        await this._restorePlayerState(newPlayer, playerState)

        this.emit('playerMigrated', player, newPlayer, targetNode)
        return newPlayer
      } catch (error) {
        retryCount++
        if (retryCount >= this.failoverOptions.maxRetries) throw error
        await this._delay(this.failoverOptions.retryDelay)
      }
    }
  }

  _capturePlayerState(player) {
    try {
      return {
        guildId: player.guildId,
        textChannel: player.textChannel,
        voiceChannel: player.voiceChannel,
        volume: player.volume || 100,
        paused: player.paused || false,
        position: player.position || 0,
        current: player.current || null,
        queue: player.queue?.tracks?.slice(0, 10) || [],
        repeat: player.loop,
        shuffle: player.shuffle,
        deaf: player.deaf || false,
        connected: player.connected || false
      }
    } catch {
      return null
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
    if (playerState.volume !== undefined) {
      newPlayer.setVolume(playerState.volume)
    }

    if (playerState.queue?.length > 0) {
      newPlayer.queue.add(...playerState.queue)
    }

    if (playerState.current && this.failoverOptions.preservePosition) {
      newPlayer.queue.unshift(playerState.current)

      if (this.failoverOptions.resumePlayback) {
        await newPlayer.play()

        if (playerState.position > 0) {
          setTimeout(() => newPlayer.seek(playerState.position), 200)
        }

        if (playerState.paused) {
          newPlayer.pause()
        }
      }
    }

    newPlayer.repeat = playerState.repeat
    newPlayer.shuffle = playerState.shuffle
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  _cleanupPlayer(player) {
    if (player) {
      player.destroy()
    }
  }

  updateVoiceState({ d, t }) {
    if (!GUILD_ID_REGEX.test(d.guild_id)) return;

    const player = this.players.get(d.guild_id)
    if (!player) return;

    if (t === 'VOICE_SERVER_UPDATE' || (t === 'VOICE_STATE_UPDATE' && d.user_id === this.clientId)) {
      if (t === 'VOICE_SERVER_UPDATE') {
        player.connection?.setServerUpdate?.(d)
      } else {
        player.connection?.setStateUpdate?.(d)
      }

      if (d.channel_id === null) {
        this._boundCleanupPlayer(player)
      }
    }
  }

  fetchRegion(region) {
    if (!region) return this.leastUsedNodes

    const lowerRegion = region.toLowerCase()
    const regionNodes = []

    for (const node of this.nodeMap.values()) {
      if (node.connected && node.regions?.includes(lowerRegion)) {
        regionNodes.push(node)
      }
    }

    return regionNodes.sort((a, b) => this._getNodeLoad(a) - this._getNodeLoad(b))
  }

  _getNodeLoad(node) {
    const stats = node?.stats?.cpu
    return stats ? (stats.systemLoad / stats.cores) * 100 : 0
  }

  createConnection(options) {
    if (!this.initiated) throw new Error('Aqua not initialized')

    const existingPlayer = this.players.get(options.guildId)
    if (existingPlayer?.voiceChannel) return existingPlayer

    const availableNodes = options.region ? this.fetchRegion(options.region) : this.leastUsedNodes

    if (!availableNodes.length) throw new Error('No nodes available')

    return this.createPlayer(availableNodes[0], options)
  }

  createPlayer(node, options) {
    this.destroyPlayer(options.guildId)

    const player = new Player(this, node, options)
    this.players.set(options.guildId, player)

    player.once('destroy', this._boundHandleDestroy)
    player.connect(options)
    this.emit('playerCreate', player)
    return player
  }

  _handlePlayerDestroy(player) {
    const node = player.nodes
    if (node?.players) {
      node.players.delete(player)
    }
    this.players.delete(player.guildId)
    this.emit('playerDestroy', player)
  }

  async destroyPlayer(guildId) {
    const player = this.players.get(guildId)
    if (!player) return;

    try {
      await player.clearData()
      player.removeAllListeners()
      this.players.delete(guildId)
      this.emit('playerDestroy', player)
    } catch {
      // Silent cleanup
    }
  }

  async resolve({ query, source = this.defaultSearchPlatform, requester, nodes }) {
    if (!this.initiated) throw new Error('Aqua not initialized')

    const requestNode = this._getRequestNode(nodes)
    const formattedQuery = URL_REGEX.test(query) ? query : `${source}:${query}`

    try {
      const endpoint = `/v4/loadtracks?identifier=${encodeURIComponent(formattedQuery)}`
      const response = await requestNode.rest.makeRequest('GET', endpoint)

      if (['empty', 'NO_MATCHES'].includes(response.loadType)) {
        return this._createEmptyResponse()
      }

      return this._constructResponse(response, requester, requestNode)
    } catch (error) {
      throw new Error(error.name === 'AbortError' ? 'Request timeout' : `Resolve failed: ${error.message}`)
    }
  }

  _getRequestNode(nodes) {
    if (!nodes) return this.leastUsedNodes[0]
    if (nodes instanceof Node) return nodes
    if (typeof nodes === 'string') {
      return this.nodeMap.get(nodes) || this.leastUsedNodes[0]
    }
    throw new TypeError(`Invalid nodes parameter: ${typeof nodes}`)
  }

  _createEmptyResponse() {
    return {
      loadType: 'empty',
      exception: null,
      playlistInfo: null,
      pluginInfo: {},
      tracks: []
    }
  }

  _constructResponse(response, requester, requestNode) {
    const baseResponse = {
      loadType: response.loadType,
      exception: null,
      playlistInfo: null,
      pluginInfo: response.pluginInfo || {},
      tracks: []
    }

    if (response.loadType === 'error' || response.loadType === 'LOAD_FAILED') {
      baseResponse.exception = response.data || response.exception
      return baseResponse
    }

    switch (response.loadType) {
      case 'track':
        if (response.data) {
          baseResponse.tracks.push(new Track(response.data, requester, requestNode))
        }
        break

      case 'playlist': {
        const info = response.data?.info
        if (info) {
          baseResponse.playlistInfo = {
            name: info.name || info.title,
            thumbnail: response.data.pluginInfo?.artworkUrl ||
              response.data.tracks?.[0]?.info?.artworkUrl || null,
            ...info
          }
        }

        const tracks = response.data?.tracks
        if (tracks?.length) {
          baseResponse.tracks = tracks.map(track => new Track(track, requester, requestNode))
        }
        break
      }

      case 'search': {
        const searchData = response.data || []
        if (searchData.length) {
          baseResponse.tracks = searchData.map(track => new Track(track, requester, requestNode))
        }
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
      const { tracks } = await this.resolve({ query, source, requester })
      return tracks || null
    } catch {
      return null
    }
  }

  async loadPlayers(filePath = './AquaPlayers.json') {
    try {
      await fs.access(filePath)
      await this._waitForFirstNode()

      const data = JSON.parse(await fs.readFile(filePath, 'utf8'))

      const batchSize = 5
      for (let i = 0; i < data.length; i += batchSize) {
        const batch = data.slice(i, i + batchSize)
        await Promise.all(batch.map(p => this._restorePlayer(p)))
      }

      await fs.writeFile(filePath, '[]', 'utf8')
    } catch (error) {
      // Silent error handling
    }
  }

  async savePlayer(filePath = './AquaPlayers.json') {
    const data = Array.from(this.players.values()).map(player => {
      const requester = player.requester || player.current?.requester

      return {
        g: player.guildId,
        t: player.textChannel,
        v: player.voiceChannel,
        u: player.current?.uri || null,
        p: player.position || 0,
        ts: player.timestamp || 0,
        q: player.queue?.tracks?.map(tr => tr.uri).slice(0, 5) || [],
        r: requester ? {
          id: requester.id,
          username: requester.username,
          globalName: requester.globalName,
          discriminator: requester.discriminator,
          avatar: requester.avatar
        } : null,
        vol: player.volume,
        pa: player.paused,
        isPlaying: player.playing,
        sessionId: player.connection.sessionId,
        endpoint: player.connection.endpoint,
        token: player.connection.token
      }
    })

    await fs.writeFile(filePath, JSON.stringify(data), 'utf8')
    this.emit('debug', 'Aqua', `Saved ${data.length} players to ${filePath}`)
  }

  async _restorePlayer(p) {
    try {
      let player = this.players.get(p.g)
      if (!player) {
        const targetNode = (p.n && this.nodeMap.get(p.n)?.connected) ?
          this.nodeMap.get(p.n) : this.leastUsedNodes[0]

        if (!targetNode) return;

        player = await this.createConnection({
          guildId: p.g,
          textChannel: p.t,
          voiceChannel: p.v,
          defaultVolume: p.vol || 65,
          deaf: true
        })
      }

      if (player?.connection) {
        if (p.sessionId) player.connection.sessionId = p.sessionId
        if (p.endpoint) player.connection.endpoint = p.endpoint
        if (p.token) player.connection.token = p.token
      }

      if (p.u && player) {
        const resolved = await this.resolve({ query: p.u, requester: p.r })
        if (resolved.tracks?.[0]) {
          player.queue.add(resolved.tracks[0])
          player.position = p.p || 0
          if (typeof p.ts === 'number') player.timestamp = p.ts
        }
      }

      if (p.q?.length && player) {
        const queuePromises = p.q
          .filter(uri => uri !== p.u)
          .map(uri => this.resolve({ query: uri, requester: p.r }))

        const queueResults = await Promise.allSettled(queuePromises)
        queueResults.forEach(result => {
          if (result.status === 'fulfilled' && result.value.tracks?.[0]) {
            player.queue.add(result.value.tracks[0])
          }
        })
      }

      if (player) {
        if (typeof p.vol === 'number') {
          player.volume = p.vol
        }

        player.paused = !!p.pa

        if ((p.isPlaying || (p.pa && p.u)) && player.queue.size > 0) {
          player.play()
        }
      }
    } catch (error) {
      this.emit('debug', 'Aqua', `Error restoring player for guild ${p.g}: ${error.message}`)
    }
  }

  async _waitForFirstNode() {
    if (this.leastUsedNodes.length > 0) return;

    return new Promise(resolve => {
      const checkInterval = setInterval(() => {
        if (this.leastUsedNodes.length > 0) {
          clearInterval(checkInterval)
          resolve()
        }
      }, 100)
    })
  }

  _performCleanup() {
    const now = Date.now()

    for (const [guildId, state] of this._brokenPlayers.entries()) {
      if (now - state.brokenAt > BROKEN_PLAYER_TTL) {
        this._brokenPlayers.delete(guildId)
      }
    }

    for (const [nodeId, timestamp] of this._lastFailoverAttempt.entries()) {
      if (now - timestamp > FAILOVER_CLEANUP_TTL) {
        this._lastFailoverAttempt.delete(nodeId)
        this._failoverQueue.delete(nodeId)
      }
    }
  }

  getBrokenPlayersCount() {
    return this._brokenPlayers.size
  }

  getNodeStats() {
    const stats = {}
    for (const [name, node] of this.nodeMap) {
      const nodeStats = node.stats || {}
      stats[name] = {
        connected: node.connected,
        players: nodeStats.players || 0,
        playingPlayers: nodeStats.playingPlayers || 0,
        uptime: nodeStats.uptime || 0,
        cpu: nodeStats.cpu || {},
        memory: nodeStats.memory || {},
        ping: nodeStats.ping || 0
      }
    }
    return stats
  }

  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer)
    }

    this.removeAllListeners()

    for (const player of this.players.values()) {
      this._cleanupPlayer(player)
    }

    for (const node of this.nodeMap.values()) {
      node.removeAllListeners()
    }

    this.players.clear()
    this.nodeMap.clear()
    this._brokenPlayers.clear()
    this._nodeStates.clear()
    this._failoverQueue.clear()
    this._lastFailoverAttempt.clear()
  }

  _getAvailableNodes(excludeNode) {
    const available = []
    for (const node of this.nodeMap.values()) {
      if (node !== excludeNode && node.connected) {
        available.push(node)
      }
    }
    return available
  }
}

module.exports = Aqua
