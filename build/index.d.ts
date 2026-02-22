import { EventEmitter } from 'events'

declare module 'aqualink' {
  // Main Classes
  export class Aqua extends EventEmitter {
    constructor(client: any, nodes: NodeOptions[], options?: AquaOptions)

    // Core Properties
    client: any
    nodes: NodeOptions[]
    nodeMap: Map<string, Node>
    players: Map<string, Player>
    clientId: string | null
    initiated: boolean
    version: string
    options: AquaOptions
    failoverOptions: FailoverOptions

    // Configuration Properties
    shouldDeleteMessage: boolean
    defaultSearchPlatform: SearchSource
    leaveOnEnd: boolean
    restVersion: RestVersion
    plugins: Plugin[]
    autoResume: boolean
    infiniteReconnects: boolean
    urlFilteringEnabled?: boolean
    restrictedDomains: string[]
    allowedDomains: string[]
    loadBalancer: LoadBalancerStrategy
    send: (payload: any) => void
    autoRegionMigrate: boolean

    // Internal State Management
    _nodeStates: Map<
      string,
      { connected: boolean; failoverInProgress: boolean }
    >
    _failoverQueue: Map<string, number>
    _lastFailoverAttempt: Map<string, number>
    _brokenPlayers: Map<string, BrokenPlayerState>
    _rebuildLocks: Set<string>
    _leastUsedNodesCache: Node[] | null
    _leastUsedNodesCacheTime: number
    _nodeLoadCache: Map<string, { load: number; time: number }>
    _cleanupTimer: NodeJS.Timer | null
    _onNodeConnect?: (node: Node) => void
    _onNodeDisconnect?: (node: Node) => void

    // Getters
    get leastUsedNodes(): Node[]

    // Core Methods
    /**
     * Initializes the specific client id and connects to all nodes
     * @param clientId Client ID
     * @example
     * ```ts
     * await aqua.init(client.user.id);
     * ```
     */
    init(clientId: string): Promise<Aqua>

    /**
     * Creates a new node connection
     * @param options Modified node options
     */
    createNode(options: NodeOptions): Promise<Node>

    /**
     * Destroys a node by identifier
     * @param identifier Node identifier (name or host)
     */
    destroyNode(identifier: string): void

    /**
     * Updates the voice state of a player
     * @param data Voice state update packet
     */
    updateVoiceState(data: VoiceStateUpdate | VoiceServerUpdate): void

    /**
     * Fetches nodes in a specific region
     * @param region Region name
     */
    fetchRegion(region: string): Node[]

    /**
     * Creates a connection for a player
     * @param options Connection options
     */
    createConnection(options: ConnectionOptions): Player

    /**
     * Creates a player on a specific node
     * @param node Node to create player on
     * @param options Player options
     */
    createPlayer(node: Node, options: PlayerOptions): Player

    /**
     * Destroys a player
     * @param guildId Guild ID
     */
    destroyPlayer(guildId: string): Promise<void>

    /**
     * Resolves a track or playlist
     * @param options Resolution options
     * @example
     * ```ts
     * const result = await aqua.resolve({ query: 'https://...', requester: user });
     * ```
     */
    resolve(options: ResolveOptions): Promise<ResolveResponse>

    /**
     * Gets an existing player
     * @param guildId Guild ID
     */
    get(guildId: string): Player

    /**
     * Searches for tracks
     * @param query Search query
     * @param requester Requester object
     * @param source Search source (ytsearch, scsearch, etc)
     */
    search(
      query: string,
      requester: any,
      source?: SearchSource
    ): Promise<Track[] | null>

    // Save/Load Methods
    savePlayer(filePath?: string): Promise<void>
    savePlayerSync(filePath?: string): void
    loadPlayers(filePath?: string): Promise<void>

    // Failover and Migration Methods
    handleNodeFailover(failedNode: Node): Promise<void>

    /**
     * Moves a player to a different node
     * @param guildId Guild ID of the player
     * @param targetNode Target node to move to
     * @param reason Reason for migration (default: 'region')
     */
    movePlayerToNode(
      guildId: string,
      targetNode: Node,
      reason?: string
    ): Promise<Player>

    // Utility Methods
    /**
     * Destroys the Aqua instance and all players
     */
    destroy(): Promise<void>

    getTrace(limit?: number): TraceEntry[]

    // Internal Methods
    _invalidateCache(): void
    _getCachedNodeLoad(node: Node): number
    _calculateNodeLoad(node: Node): number
    _createNode(options: NodeOptions): Promise<Node>
    _destroyNode(identifier: string): void
    _cleanupNode(nodeId: string): void
    _storeBrokenPlayers(node: Node): void
    _rebuildBrokenPlayers(node: Node): Promise<void>
    _rebuildPlayer(
      brokenState: BrokenPlayerState,
      targetNode: Node
    ): Promise<Player>
    _migratePlayersOptimized(
      players: Player[],
      availableNodes: Node[]
    ): Promise<MigrationResult[]>
    _migratePlayer(player: Player, pickNode: () => Node): Promise<Player>
    _capturePlayerState(player: Player): PlayerState | null
    _createPlayerOnNode(
      targetNode: Node,
      playerState: PlayerState
    ): Promise<Player>
    _restorePlayerState(
      newPlayer: Player,
      playerState: PlayerState
    ): Promise<void>
    _getRequestNode(nodes?: string | Node | Node[]): Node
    _chooseLeastBusyNode(nodes: Node[]): Node | null
    _constructResponse(
      response: any,
      requester: any,
      requestNode: Node
    ): ResolveResponse
    _resolveSearchPlatform(source: string): SearchSource
    _getAvailableNodes(excludeNode?: Node): Node[]
    _performCleanup(): void
    _handlePlayerDestroy(player: Player): void
    _waitForFirstNode(timeout?: number): Promise<void>
    _restorePlayer(data: SavedPlayerData): Promise<void>
    _parseRequester(requesterString: string | null): any
    _loadPlugins(): Promise<void>
    _createDefaultSend(): (packet: any) => void
    _bindEventHandlers(): void
    _startCleanupTimer(): void
    _onNodeReady(node: Node, data: { resumed: boolean }): void
    _regionMatches(configuredRegion: string, extractedRegion: string): boolean
    _findBestNodeForRegion(region: string): Node | null

    // Optional bypass checks
    bypassChecks?: { nodeFetchInfo?: boolean }
  }

  export class Node extends EventEmitter {
    constructor(
      aqua: Aqua,
      connOptions: NodeOptions,
      options?: NodeAdditionalOptions
    )

    // Core Properties
    aqua: Aqua
    host: string
    name: string
    port: number
    auth: string
    ssl: boolean
    sessionId: string | null
    regions: DiscordVoiceRegion[]
    wsUrl: string
    rest: Rest
    resumeTimeout: number
    autoResume: boolean
    reconnectTimeout: number
    reconnectTries: number
    infiniteReconnects: boolean
    connected: boolean
    info: NodeInfo | null
    isNodelink: boolean
    ws: any | null // WebSocket
    reconnectAttempted: number
    reconnectTimeoutId: NodeJS.Timeout | null
    isDestroyed: boolean
    stats: NodeStats
    players: Set<Player>
    options: NodeOptions

    // Additional Properties
    timeout: number
    maxPayload: number
    skipUTF8Validation: boolean
    _isConnecting: boolean
    _debugEnabled: boolean
    _headers: Record<string, string>
    _boundHandlers: Record<string, ReturnType<typeof this._boundHandlers>>

    // Methods
    connect(): Promise<void>
    destroy(clean?: boolean): void
    getStats(): Promise<NodeStats>

    // Internal Methods
    _handleOpen(): Promise<void>
    _handleError(error: any): void
    _handleMessage(data: any, isBinary: boolean): void
    _handleClose(code: number, reason: any): void
    _handleReady(payload: any): Promise<void>
    _resumePlayers(): Promise<void>
    _emitError(error: any): void
    _emitDebug(message: string | (() => string)): void
  }

  export class Player extends EventEmitter {
    constructor(aqua: Aqua, nodes: Node, options: PlayerOptions)

    // Static Properties
    static readonly LOOP_MODES: {
      readonly NONE: 0
      readonly TRACK: 1
      readonly QUEUE: 2
    }
    static readonly EVENT_HANDLERS: Record<string, string>

    // Core Properties
    aqua: Aqua
    nodes: Node
    guildId: string
    textChannel: string
    voiceChannel: string
    connection: Connection
    filters: Filters
    state: number
    txId: number
    volume: number
    loop: LoopModeName | LoopMode
    queue: Queue
    shouldDeleteMessage: boolean
    leaveOnEnd: boolean
    playing: boolean
    paused: boolean
    connected: boolean
    destroyed: boolean
    current: Track | null
    position: number
    timestamp: number
    ping: number
    nowPlayingMessage: any
    isAutoplayEnabled: boolean
    isAutoplay: boolean
    autoplaySeed: AutoplaySeed | null
    deaf: boolean
    mute: boolean
    autoplayRetries: number
    reconnectionRetries: number
    _resuming: boolean
    _reconnecting: boolean
    previousIdentifiers: Set<string>
    self_deaf: boolean
    self_mute: boolean

    // Additional Internal Properties
    previousTracks: CircularBuffer
    _updateBatcher: MicrotaskUpdateBatcher
    _dataStore: Map<string, any> | null
    _voiceDownSince: number
    _voiceRecovering: boolean
    _voiceWatchdogTimer: NodeJS.Timer | null
    _boundPlayerUpdate: (packet: any) => void
    _boundEvent: (payload: any) => void
    _boundAquaPlayerMove: (oldChannel: string, newChannel: string) => void
    _lastVoiceChannel: string | null
    _lastTextChannel: string | null

    // Getters
    get previous(): Track | null
    get currenttrack(): Track | null

    // Core Methods
    /**
     * Plays a track. If no track is provided, plays the next track in the queue.
     * @param track The track to play
     * @param options Options for playback
     * @example
     * ```ts
     * // Play the next track in the queue
     * await player.play();
     *
     * // Play a specific track
     * await player.play(track);
     * ```
     */
    play(
      track?: Track | null,
      options?: { paused?: boolean; startTime?: number; noReplace?: boolean }
    ): Promise<Player>

    /**
     * Connects the player to a voice channel
     * @param options Connection options
     * @example
     * ```ts
     * player.connect({
     *   guildId: '...',
     *   voiceChannel: '...',
     *   deaf: true
     * });
     * ```
     */
    connect(options?: ConnectionOptions): Player

    /**
     * Destroys the player and optionally cleans up resources
     * @param options Destruction options
     */
    destroy(options?: {
      preserveClient?: boolean
      skipRemote?: boolean
      preserveMessage?: boolean
      preserveReconnecting?: boolean
      preserveTracks?: boolean
    }): Player

    /**
     * Pauses or resumes the player
     * @param paused Whether to pause
     */
    pause(paused: boolean): Player

    /**
     * Seeks to a position in the current track
     * @param position Position in milliseconds
     */
    seek(position: number): Player

    /**
     * Stops the playback
     */
    stop(): Player

    /**
     * Sets the player volume
     * @param volume Volume (0-1000)
     */
    setVolume(volume: number): Player

    /**
     * Sets the loop mode
     * @param mode Loop mode (off, track, queue)
     */
    setLoop(mode: LoopMode | LoopModeName): Player

    /**
     * Sets the text channel for the player
     * @param channel Channel ID
     */
    setTextChannel(channel: string): Player

    /**
     * Sets the voice channel and moves the player
     * @param channel Channel ID
     */
    setVoiceChannel(channel: string): Player

    /**
     * Disconnects the player from voice
     */
    disconnect(): Player

    /**
     * Shuffles the queue
     */
    shuffle(): Player

    /**
     * Gets the player queue
     */
    getQueue(): Queue

    /**
     * Replays the current track from the beginning
     */
    replay(): Player

    /**
     * Skips the current track
     */
    skip(): Player

    // Advanced Methods
    getLyrics(options?: LyricsOptions): Promise<LyricsResponse | null>
    subscribeLiveLyrics(): Promise<any>
    unsubscribeLiveLyrics(): Promise<any>
    liveLyrics(guildId: string, state: boolean): Promise<any>
    autoplay(): Promise<Player>
    setAutoplay(enabled: boolean): Player
    updatePlayer(data: any): Promise<any>
    cleanup(): Promise<void>
    getActiveMixer(guildId: string): Promise<any[]>
    updateMixerVolume(
      guildId: string,
      mix: string,
      volume: number
    ): Promise<any>
    removeMixer(guildId: string, mix: string): Promise<any>
    addMixer(guildId: string, options: MixerOptions): Promise<any>
    getLoadLyrics(encodedTrack: string): Promise<LyricsResponse | null>

    // Data Methods
    set(key: string, value: any): void
    get(key: string): any
    clearData(): Player

    // Utility Methods
    send(data: any): void
    batchUpdatePlayer(data: any, immediate?: boolean): Promise<void>

    // Internal Methods
    _parseLoop(loop: any): LoopMode
    _bindEvents(): void
    _startWatchdog(): void
    _handlePlayerUpdate(packet: any): void
    _handleEvent(payload: any): Promise<void>
    _voiceWatchdog(): Promise<void>
    _attemptVoiceResume(): Promise<void>
    _getAutoplayTrack(
      sourceName: string,
      identifier: string,
      uri: string,
      requester: any,
      prev: Track
    ): Promise<Track | null>
    _handleAquaPlayerMove(oldChannel: string, newChannel: string): void

    // Event handler methods (called internally)
    trackStart(player: Player, track: Track): Promise<void>
    trackEnd(player: Player, track: Track, payload: any): Promise<void>
    trackError(player: Player, track: Track, payload: any): Promise<void>
    trackStuck(player: Player, track: Track, payload: any): Promise<void>
    trackChange(player: Player, track: Track, payload: any): Promise<void>
    socketClosed(player: Player, track: Track, payload: any): Promise<void>
    lyricsLine(player: Player, track: Track, payload: any): Promise<void>
    lyricsFound(player: Player, track: Track, payload: any): Promise<void>
    lyricsNotFound(player: Player, track: Track, payload: any): Promise<void>
  }

  export class Track {
    constructor(data?: TrackData, requester?: any, node?: Node)

    // Properties
    identifier: string
    isSeekable: boolean
    author: string
    position: number
    duration: number
    isStream: boolean
    title: string
    uri: string
    sourceName: string
    artworkUrl: string
    track: string | null
    playlist: PlaylistInfo | null
    requester: any
    nodes: Node
    node: Node | null

    // Internal Properties
    _infoCache: TrackInfo | null

    // Getters
    get info(): TrackInfo
    get length(): number
    get thumbnail(): string

    // Methods
    /**
     * Resolves local artwork/thumbnail
     */
    resolveThumbnail(url?: string): string | null

    /**
     * Resolves the track if it needs (re)resolution
     */
    resolve(aqua: Aqua, opts?: TrackResolutionOptions): Promise<Track | null>

    /**
     * Checks if the track is valid
     */
    isValid(): boolean

    /**
     * Disposes the track and frees resources
     */
    dispose(): void

    // Internal Methods
    _computeArtworkFromKnownSources(): string | null
  }

  export class Rest {
    constructor(aqua: Aqua, node: Node)

    aqua: Aqua
    node: Node
    sessionId: string
    calls: number

    // Additional Properties
    timeout: number
    baseUrl: string
    defaultHeaders: Record<string, string>
    agent: any // HTTP/HTTPS Agent
    useHttp2: boolean

    // Core Methods
    /**
     * Sets the session ID for the REST connection
     * @param sessionId The session ID
     */
    setSessionId(sessionId: string): void

    /**
     * Makes a generic request to the Lavalink REST API
     * @param method HTTP method
     * @param endpoint API endpoint
     * @param body Request body
     */
    makeRequest(method: HttpMethod, endpoint: string, body?: any): Promise<any>

    /**
     * Updates a player via REST
     * @param options Update options
     */
    updatePlayer(options: UpdatePlayerOptions): Promise<any>

    /**
     * Destroys a player via REST
     * @param guildId Guild ID
     */
    destroyPlayer(guildId: string): Promise<any>

    /**
     * Gets lyrics for a track
     * @param options Lyrics options
     */
    getLyrics(options: GetLyricsOptions): Promise<LyricsResponse>

    /**
     * Subscribes to live lyrics events
     * @param guildId Guild ID
     * @param sync Whether to sync with playback
     */
    subscribeLiveLyrics(guildId: string, sync?: boolean): Promise<any>

    /**
     * Unsubscribes from live lyrics
     * @param guildId Guild ID
     */
    unsubscribeLiveLyrics(guildId: string): Promise<any>

    /**
     * Gets node statistics
     */
    getStats(): Promise<NodeStats>

    // Additional REST Methods
    getPlayer(guildId: string): Promise<any>
    getPlayers(): Promise<any>
    decodeTrack(encodedTrack: string): Promise<any>
    decodeTracks(encodedTracks: string[]): Promise<any>
    getInfo(): Promise<NodeInfo>
    getVersion(): Promise<string>
    getRoutePlannerStatus(): Promise<any>
    freeRoutePlannerAddress(address: string): Promise<any>
    freeAllRoutePlannerAddresses(): Promise<any>
    addMixer(guildId: string, options: MixerOptions): Promise<any>
    getActiveMixer(guildId: string): Promise<any[]>
    updateMixerVolume(
      guildId: string,
      mix: string,
      volume: number
    ): Promise<any>
    removeMixer(guildId: string, mix: string): Promise<any>
    getLoadLyrics(encodedTrack: string): Promise<LyricsResponse>
    loadTracks(identifier: string): Promise<any>
    destroy(): void
  }

  export class Queue extends Array<Track> {
    constructor(...elements: Track[])

    // Properties
    readonly size: number
    readonly first: Track | null
    readonly last: Track | null

    // Methods
    /**
     * Adds a track to the queue
     * @param track Track to add
     */
    add(track: Track): Queue

    /**
     * Adds multiple tracks to the queue
     * @param tracks Tracks to add
     */
    add(...tracks: Track[]): Queue

    push(track: Track): number
    unshift(track: Track): number
    shift(): Track | undefined
    remove(track: Track): boolean

    /**
     * Clears the queue
     */
    clear(): void

    /**
     * Shuffles the queue
     */
    shuffle(): Queue

    peek(): Track | null
    isEmpty(): boolean
    toArray(): Track[]
    at(index: number): Track | null
    dequeue(): Track | undefined
    enqueue(track: Track): Queue
    move(from: number, to: number): Queue
    swap(index1: number, index2: number): Queue
  }

  export class Filters {
    constructor(player: Player, options?: FilterOptions)

    player: Player
    _pendingUpdate: boolean

    filters: {
      volume: number
      equalizer: EqualizerBand[]
      karaoke: KaraokeSettings | null
      timescale: TimescaleSettings | null
      tremolo: TremoloSettings | null
      vibrato: VibratoSettings | null
      rotation: RotationSettings | null
      distortion: DistortionSettings | null
      channelMix: ChannelMixSettings | null
      lowPass: LowPassSettings | null
    }
    presets: {
      bassboost: number | null
      slowmode: boolean | null
      nightcore: boolean | null
      vaporwave: boolean | null
      _8d: boolean | null
    }

    // Filter Methods
    setEqualizer(bands: EqualizerBand[]): Filters
    setKaraoke(enabled: boolean, options?: KaraokeSettings): Filters
    setTimescale(enabled: boolean, options?: TimescaleSettings): Filters
    setTremolo(enabled: boolean, options?: TremoloSettings): Filters
    setVibrato(enabled: boolean, options?: VibratoSettings): Filters
    setRotation(enabled: boolean, options?: RotationSettings): Filters
    setDistortion(enabled: boolean, options?: DistortionSettings): Filters
    setChannelMix(enabled: boolean, options?: ChannelMixSettings): Filters
    setLowPass(enabled: boolean, options?: LowPassSettings): Filters
    setBassboost(enabled: boolean, options?: { value?: number }): Filters
    setSlowmode(enabled: boolean, options?: { rate?: number }): Filters
    setNightcore(enabled: boolean, options?: { rate?: number }): Filters
    setVaporwave(enabled: boolean, options?: { pitch?: number }): Filters
    set8D(enabled: boolean, options?: { rotationHz?: number }): Filters
    clearFilters(): Promise<Filters>
    updateFilters(): Promise<Filters>

    // Internal Methods
    _setFilter(filterName: string, enabled: boolean, options?: any): Filters
    _scheduleUpdate(): Filters
  }

  export class Connection {
    constructor(player: Player)

    voiceChannel: string
    sessionId: string | null
    endpoint: string | null
    token: string | null
    region: string | null
    sequence: number

    // Internal Properties
    _player: Player
    _aqua: Aqua
    _nodes: Node
    _guildId: string
    _clientId: string
    _lastEndpoint: string | null
    _pendingUpdate: any
    _updateTimer: NodeJS.Timeout | null
    _hasDebugListeners: boolean
    _hasMoveListeners: boolean
    _lastSentVoiceKey: string
    _lastVoiceDataUpdate: number
    _stateFlags: number
    _regionMigrationAttempted: boolean

    // Methods
    setServerUpdate(data: VoiceServerUpdate['d']): void
    setStateUpdate(data: VoiceStateUpdate['d']): void
    updateSequence(seq: number): void
    destroy(): void
    attemptResume(): Promise<boolean>
    resendVoiceUpdate(): boolean

    // Internal Methods
    _extractRegion(endpoint: string): string | null
    _scheduleVoiceUpdate(isResume?: boolean): void
    _executeVoiceUpdate(): void
    _sendUpdate(payload: any): Promise<void>
    _handleDisconnect(): void
    _clearPendingUpdate(): void
    _checkRegionMigration(): void
  }

  export class Plugin {
    constructor(name: string)
    name: string
    load(aqua: Aqua): void | Promise<void>
    unload?(aqua: Aqua): void | Promise<void>
  }

  // Utility Classes
  export class MicrotaskUpdateBatcher {
    constructor(player: Player)
    player: Player | null
    updates: any
    scheduled: number
    flush: () => Promise<void>

    batch(data: any, immediate?: boolean): Promise<void>
    destroy(): void
    _flush(): Promise<void>
  }

  export class CircularBuffer {
    constructor(size?: number)
    buffer: any[]
    size: number
    index: number
    count: number

    push(item: any): void
    getLast(): any
    clear(): void
    toArray(): any[]
  }

  // Configuration Interfaces
  export interface AquaOptions {
    shouldDeleteMessage?: boolean
    defaultSearchPlatform?: SearchSource
    leaveOnEnd?: boolean
    restVersion?: RestVersion
    plugins?: Plugin[]
    send?: (payload: any) => void
    autoResume?: boolean
    infiniteReconnects?: boolean
    urlFilteringEnabled?: boolean
    restrictedDomains?: string[]
    allowedDomains?: string[]
    loadBalancer?: LoadBalancerStrategy
    failoverOptions?: FailoverOptions
    useHttp2?: boolean
    autoRegionMigrate?: boolean
    debugTrace?: boolean
    traceMaxEntries?: number
  }

  export interface FailoverOptions {
    enabled?: boolean
    maxRetries?: number
    retryDelay?: number
    preservePosition?: boolean
    resumePlayback?: boolean
    cooldownTime?: number
    maxFailoverAttempts?: number
  }

  export interface NodeOptions {
    host: string
    name?: string
    port?: number | string
    auth?: string
    ssl?: boolean
    sessionId?: string
    regions?: DiscordVoiceRegion[]
  }

  export interface NodeAdditionalOptions {
    resumeTimeout?: number
    autoResume?: boolean
    reconnectTimeout?: number
    reconnectTries?: number
    infiniteReconnects?: boolean
    timeout?: number
    maxPayload?: number
    skipUTF8Validation?: boolean
  }

  export interface PlayerOptions {
    guildId: string
    textChannel: string
    voiceChannel: string
    defaultVolume?: number
    loop?: LoopModeName
    deaf?: boolean
    mute?: boolean
  }

  export interface ConnectionOptions {
    guildId: string
    voiceChannel: string
    textChannel?: string
    deaf?: boolean
    mute?: boolean
    defaultVolume?: number
    region?: DiscordVoiceRegion
  }

  export interface ResolveOptions {
    query: string
    source?: SearchSource | string
    requester: any
    nodes?: string | Node | Node[]
  }

  // Response and Data Interfaces
  export interface ResolveResponse {
    loadType: LoadType
    exception: LavalinkException | null
    playlistInfo: PlaylistInfo | null
    pluginInfo: Record<string, any>
    tracks: Track[]
  }

  export interface NodeStats {
    players: number
    playingPlayers: number
    uptime: number
    memory: {
      free: number
      used: number
      allocated: number
      reservable: number
    }
    cpu: {
      cores: number
      systemLoad: number
      lavalinkLoad: number
    }
    frameStats: {
      sent: number
      nulled: number
      deficit: number
    }
    ping?: number
  }

  export interface NodeInfo {
    version: {
      semver: string
      major: number
      minor: number
      patch: number
    }
    buildTime: number
    git: {
      branch: string
      commit: string
      commitTime: number
    }
    jvm: string
    lavaplayer: string
    sourceManagers: string[]
    filters: string[]
    plugins: Array<{
      name: string
      version: string
    }>
  }

  export interface TrackInfo {
    identifier: string
    isSeekable: boolean
    author: string
    length: number
    isStream: boolean
    title: string
    uri: string
    sourceName: string
    artworkUrl: string
    position?: number
  }

  export interface TrackData {
    encoded?: string
    track?: string
    info: TrackInfo
    playlist?: PlaylistInfo
    node?: Node
    nodes?: Node
  }

  export interface PlaylistInfo {
    name: string
    selectedTrack?: number
    thumbnail?: string
    title?: string
  }

  export interface LavalinkException {
    message: string
    severity: string
    cause: string
  }

  // Filter Interfaces
  export interface FilterOptions {
    volume?: number
    equalizer?: EqualizerBand[]
    karaoke?: KaraokeSettings
    timescale?: TimescaleSettings
    tremolo?: TremoloSettings
    vibrato?: VibratoSettings
    rotation?: RotationSettings
    distortion?: DistortionSettings
    channelMix?: ChannelMixSettings
    lowPass?: LowPassSettings
    bassboost?: number
    slowmode?: boolean
    nightcore?: boolean
    vaporwave?: boolean
    _8d?: boolean
  }

  export interface EqualizerBand {
    band: number
    gain: number
  }

  export interface KaraokeSettings {
    level?: number
    monoLevel?: number
    filterBand?: number
    filterWidth?: number
  }

  export interface TimescaleSettings {
    speed?: number
    pitch?: number
    rate?: number
  }

  export interface TremoloSettings {
    frequency?: number
    depth?: number
  }

  export interface VibratoSettings {
    frequency?: number
    depth?: number
  }

  export interface RotationSettings {
    rotationHz?: number
  }

  export interface DistortionSettings {
    distortion?: number
    sinOffset?: number
    sinScale?: number
    cosOffset?: number
    cosScale?: number
    tanOffset?: number
    tanScale?: number
    offset?: number
    scale?: number
  }

  export interface ChannelMixSettings {
    leftToLeft?: number
    leftToRight?: number
    rightToLeft?: number
    rightToRight?: number
  }

  export interface LowPassSettings {
    smoothing?: number
  }

  export interface MixerOptions {
    identifier?: string
    encoded?: string
    userData?: any
    volume?: number
  }

  // Voice Update Interfaces
  export interface VoiceStateUpdate {
    d: {
      guild_id: string
      channel_id: string | null
      user_id: string
      session_id: string
      deaf: boolean
      mute: boolean
      self_deaf: boolean
      self_mute: boolean
      suppress: boolean
      request_to_speak_timestamp: string | null
    }
    t: 'VOICE_STATE_UPDATE'
  }

  export interface VoiceServerUpdate {
    d: {
      token: string
      guild_id: string
      endpoint: string | null
    }
    t: 'VOICE_SERVER_UPDATE'
  }

  // Utility Interfaces
  export interface LyricsOptions {
    query?: string
    useCurrentTrack?: boolean
    skipTrackSource?: boolean
  }

  export interface LyricsResponse {
    text?: string
    source?: string
    lines?: Array<{
      line: string
      timestamp?: number
    }>
  }

  export interface AutoplaySeed {
    trackId: string
    artistIds: string
  }

  export interface UpdatePlayerOptions {
    guildId: string
    data: {
      track?: { encoded: string | null }
      position?: number
      volume?: number
      paused?: boolean
      filters?: any
      voice?: any
    }
  }

  export interface GetLyricsOptions {
    track: {
      info: TrackInfo
      encoded?: string
      identifier?: string
      guild_id?: string
    }
    skipTrackSource?: boolean
  }

  // State Management Interfaces
  export interface PlayerState {
    guildId: string
    textChannel: string
    voiceChannel: string
    volume: number
    paused: boolean
    position: number
    current: Track | null
    queue: Track[]
    repeat: LoopMode
    shuffle: boolean
    deaf: boolean
    connected: boolean
  }

  export interface BrokenPlayerState extends PlayerState {
    originalNodeId: string
    brokenAt: number
  }

  export interface MigrationResult {
    success: boolean
    error?: any
  }

  export interface SavedPlayerData {
    g: string // guildId
    t: string // textChannel
    v: string // voiceChannel
    u: string | null // uri
    p: number // position
    ts: number // timestamp
    q: string[] // queue uris
    r: string | null // requester
    vol: number // volume
    pa: boolean // paused
    pl: boolean // playing
    nw: string | null // nowPlayingMessage id
  }

  export interface TrackResolutionOptions {
    platform?: SearchSource
    node?: Node
    toFront?: boolean
  }

  /**
   * A map of Discord voice region codes to their string values.
   * Each entry shows the country and airport name in IntelliSense.
   *
   * Use `VoiceRegion.bom`, `VoiceRegion.gru`, etc. for full autocomplete descriptions,
   * or pass raw strings like `'bom'` directly — both are accepted by `NodeOptions.regions`.
   *
   * @example
   * ```ts
   * // With descriptions in IntelliSense
   * { host: '...', regions: [VoiceRegion.gru, VoiceRegion.eze] }
   *
   * // Raw strings also work
   * { host: '...', regions: ['gru', 'eze'] }
   * ```
   */
  export const VoiceRegion: {
    // ─── Asia Pacific ─────────────────────────────────────────────────────────

    /** 🇮🇳 Mumbai Chhatrapati Shivaji Maharaj International */
    readonly India: 'bom'
    /** 🇸🇬 Changi Airport */
    readonly Singapore: 'sin'
    /** 🇯🇵 Tokyo Narita International */
    readonly Japan: 'nrt'
    /** 🇰🇷 Seoul Incheon International */
    readonly SouthKorea: 'icn'
    /** 🇭🇰 Hong Kong International */
    readonly HongKong: 'hkg'
    /** 🇦🇺 Sydney Kingsford Smith */
    readonly Australia: 'syd'
    /** 🇮🇩 Jakarta Soekarno-Hatta International */
    readonly Indonesia: 'cgk'

    // ─── Europe ───────────────────────────────────────────────────────────────

    /** 🇩🇪 Frankfurt Airport */
    readonly Germany: 'fra'
    /** 🇳🇱 Amsterdam Schiphol */
    readonly Netherlands: 'ams'
    /** 🇬🇧 London Heathrow */
    readonly UnitedKingdom: 'lhr'
    /** 🇫🇷 Paris Charles de Gaulle */
    readonly France: 'cdg'
    /** 🇪🇸 Madrid Barajas */
    readonly Spain: 'mad'
    /** 🇮🇹 Milan Malpensa */
    readonly Italy: 'mxp'
    /** 🇸🇪 Stockholm Arlanda */
    readonly Sweden: 'arn'
    /** 🇫🇮 Helsinki Vantaa */
    readonly Finland: 'hel'
    /** 🇵🇱 Warsaw Chopin */
    readonly Poland: 'waw'
    /** 🇷🇴 Bucharest Henri Coanda */
    readonly Romania: 'buh'
    /** 🇷🇺 St. Petersburg Pulkovo */
    readonly RussiaSTP: 'led'
    /** 🇷🇺 Moscow Sheremetyevo */
    readonly RussiaMoscow: 'svo'

    // ─── Middle East & Africa ─────────────────────────────────────────────────

    /** 🇮🇱 Tel Aviv Ben Gurion */
    readonly Israel: 'tlv'
    /** 🇦🇪 Dubai International */
    readonly UAE: 'dxb'
    /** 🇸🇦 Dammam King Fahd International */
    readonly SaudiArabia: 'dmm'
    /** 🇿🇦 Johannesburg O.R. Tambo International */
    readonly SouthAfrica: 'jnb'

    // ─── North America ────────────────────────────────────────────────────────

    /** 🇺🇸 Newark / New York */
    readonly USANewark: 'ewr'
    /** 🇺🇸 Washington D.C. Dulles */
    readonly USAWashington: 'iad'
    /** 🇺🇸 Atlanta Hartsfield-Jackson */
    readonly USAAtlanta: 'atl'
    /** 🇺🇸 Miami International */
    readonly USAMiami: 'mia'
    /** 🇺🇸 Chicago O'Hare */
    readonly USAChicago: 'ord'
    /** 🇺🇸 Dallas/Fort Worth */
    readonly USADallas: 'dfw'
    /** 🇺🇸 Seattle-Tacoma / Oregon */
    readonly USASeattle: 'sea'
    /** 🇺🇸 Los Angeles International */
    readonly USALosAngeles: 'lax'
    /** 🇨🇦 Toronto Pearson International */
    readonly CanadaToronto: 'yyz'
    /** 🇨🇦 Montreal Pierre Elliott Trudeau */
    readonly CanadaMontreal: 'ymq'

    // ─── South America ────────────────────────────────────────────────────────

    /** 🇧🇷 Sao Paulo Guarulhos International */
    readonly Brazil: 'gru'
    /** 🇨🇱 Santiago Arturo Merino Benitez */
    readonly Chile: 'scl'
    /** 🇦🇷 Buenos Aires Ministro Pistarini */
    readonly Argentina: 'eze'
  }

  /**
   * Discord voice server region prefix (derived from IATA airport codes).
   * Used in `NodeOptions.regions` to match players to the best Lavalink node
   * based on Discord's voice endpoint (e.g. `c-bom06-xxxx.discord.media` -> `'bom'`).
   *
   * For descriptions on each value, use the `VoiceRegion` object in your IDE.
   */
  export type DiscordVoiceRegion =
    | (typeof VoiceRegion)[keyof typeof VoiceRegion]
    | (string & {})

  // Type Unions and Enums
  export type SearchSource =
    | 'ytsearch'
    | 'ytmsearch'
    | 'scsearch'
    | 'spsearch'
    | 'amsearch'
    | 'dzsearch'
    | 'yandexsearch'
    | 'soundcloud'
    | 'youtube'
    | 'spotify'
    | 'applemusic'
    | 'deezer'
    | 'bandcamp'
    | 'vimeo'
    | 'twitch'
    | 'http'

  export type LoopMode = 0 | 1 | 2
  export type LoopModeName = 'none' | 'track' | 'queue'

  export type LoadType =
    | 'track'
    | 'playlist'
    | 'search'
    | 'empty'
    | 'error'
    | 'LOAD_FAILED'
    | 'NO_MATCHES'

  export type RestVersion = 'v3' | 'v4'

  export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

  export type LoadBalancerStrategy = 'leastLoad' | 'leastRest' | 'random'

  export type EventHandler<T = any> = (...args: T[]) => void | Promise<void>

  // Event Interfaces
  export interface AquaEvents {
    nodeConnect: (node: Node) => void
    nodeConnected: (node: Node) => void
    nodeDisconnect: (node: Node, data: { code: number; reason: string }) => void
    nodeError: (node: Node, error: Error) => void
    nodeReconnect: (node: Node, data: any) => void
    nodeCreate: (node: Node) => void
    nodeDestroy: (node: Node) => void
    nodeReady: (node: Node, data: any) => void
    nodeFailover: (node: Node) => void
    nodeFailoverComplete: (
      node: Node,
      successful: number,
      failed: number
    ) => void
    playerCreate: (player: Player) => void
    playerDestroy: (player: Player) => void
    playerUpdate: (player: Player, packet: any) => void
    playerMigrated: (
      oldPlayer: Player,
      newPlayer: Player,
      targetNode: Node
    ) => void
    playerReconnected: (player: Player, data: any) => void
    trackStart: (player: Player, track: Track) => void
    trackEnd: (player: Player, track: Track, reason?: string) => void
    trackError: (player: Player, track: Track, error: any) => void
    trackStuck: (player: Player, track: Track, thresholdMs: number) => void
    trackChange: (player: Player, track: Track, payload: any) => void
    queueEnd: (player: Player) => void
    playerMove: (oldChannel: string, newChannel: string) => void
    playersRebuilt: (node: Node, count: number) => void
    reconnectionFailed: (player: Player, data: any) => void
    socketClosed: (player: Player, payload: any) => void
    lyricsLine: (player: Player, track: Track, payload: any) => void
    lyricsFound: (player: Player, track: Track, payload: any) => void
    lyricsNotFound: (player: Player, track: Track, payload: any) => void
    autoplayFailed: (player: Player, error: Error) => void
    debug: (source: string, message: string) => void
    error: (node: Node | null, error: Error) => void
  }

  export interface PlayerEvents {
    destroy: () => void
    playerUpdate: (packet: any) => void
    event: (payload: any) => void
    trackStart: (track: Track) => void
    trackEnd: (track: Track, reason?: string) => void
    trackError: (track: Track, error: any) => void
    trackStuck: (track: Track, thresholdMs: number) => void
    trackChange: (track: Track, payload: any) => void
    socketClosed: (payload: any) => void
    lyricsLine: (track: Track, payload: any) => void
    lyricsFound: (track: Track, payload: any) => void
    lyricsNotFound: (track: Track, payload: any) => void
  }

  // Event Emitter Type Extensions for Aqua
  interface Aqua {
    on<K extends keyof AquaEvents>(event: K, listener: AquaEvents[K]): this
    on(event: string | symbol, listener: (...args: any[]) => void): this

    once<K extends keyof AquaEvents>(event: K, listener: AquaEvents[K]): this
    once(event: string | symbol, listener: (...args: any[]) => void): this

    emit<K extends keyof AquaEvents>(
      event: K,
      ...args: Parameters<AquaEvents[K]>
    ): boolean
    emit(event: string | symbol, ...args: any[]): boolean

    off<K extends keyof AquaEvents>(event: K, listener: AquaEvents[K]): this
    off(event: string | symbol, listener: (...args: any[]) => void): this

    removeListener<K extends keyof AquaEvents>(
      event: K,
      listener: AquaEvents[K]
    ): this
    removeListener(
      event: string | symbol,
      listener: (...args: any[]) => void
    ): this

    addListener<K extends keyof AquaEvents>(
      event: K,
      listener: AquaEvents[K]
    ): this
    addListener(
      event: string | symbol,
      listener: (...args: any[]) => void
    ): this

    removeAllListeners<K extends keyof AquaEvents>(event?: K): this
    removeAllListeners(event?: string | symbol): this
  }

  interface Player {
    on<K extends keyof PlayerEvents>(event: K, listener: PlayerEvents[K]): this
    on(event: string | symbol, listener: (...args: any[]) => void): this

    once<K extends keyof PlayerEvents>(
      event: K,
      listener: PlayerEvents[K]
    ): this
    once(event: string | symbol, listener: (...args: any[]) => void): this

    emit<K extends keyof PlayerEvents>(
      event: K,
      ...args: Parameters<PlayerEvents[K]>
    ): boolean
    emit(event: string | symbol, ...args: any[]): boolean

    off<K extends keyof PlayerEvents>(event: K, listener: PlayerEvents[K]): this
    off(event: string | symbol, listener: (...args: any[]) => void): this

    removeListener<K extends keyof PlayerEvents>(
      event: K,
      listener: PlayerEvents[K]
    ): this
    removeListener(
      event: string | symbol,
      listener: (...args: any[]) => void
    ): this

    addListener<K extends keyof PlayerEvents>(
      event: K,
      listener: PlayerEvents[K]
    ): this
    addListener(
      event: string | symbol,
      listener: (...args: any[]) => void
    ): this

    removeAllListeners<K extends keyof PlayerEvents>(event?: K): this
    removeAllListeners(event?: string | symbol): this
  }

  // Additional Filter Preset Options
  export interface FilterPresetOptions {
    value?: number
    rate?: number
    pitch?: number
    rotationHz?: number
  }

  // Error Extensions
  export interface AquaError extends Error {
    statusCode?: number
    statusMessage?: string
    headers?: Record<string, string>
    body?: any
  }

  // Extended ResolveOptions for internal use
  export interface ExtendedResolveOptions extends ResolveOptions {
    node?: Node
  }

  // Export constants
  export const LOOP_MODES: {
    readonly NONE: 0
    readonly TRACK: 1
    readonly QUEUE: 2
  }

  export const AqualinkEvents: {
    readonly TrackStart: 'trackStart'
    readonly TrackEnd: 'trackEnd'
    readonly TrackError: 'trackError'
    readonly TrackStuck: 'trackStuck'
    readonly TrackChange: 'trackChange'
    readonly SocketClosed: 'socketClosed'
    readonly LyricsLine: 'lyricsLine'
    readonly LyricsFound: 'lyricsFound'
    readonly LyricsNotFound: 'lyricsNotFound'
    readonly QueueEnd: 'queueEnd'
    readonly PlayerUpdate: 'playerUpdate'
    readonly PlayerMove: 'playerMove'
    readonly PlayerReconnected: 'playerReconnected'
    readonly AutoplayFailed: 'autoplayFailed'
    readonly ReconnectionFailed: 'reconnectionFailed'
    readonly NodeConnect: 'nodeConnect'
    readonly NodeCreate: 'nodeCreate'
    readonly NodeError: 'nodeError'
    readonly NodeDisconnect: 'nodeDisconnect'
    readonly NodeReconnect: 'nodeReconnect'
    readonly NodeDestroy: 'nodeDestroy'
    readonly NodeReady: 'nodeReady'
    readonly NodeCustomOp: 'nodeCustomOp'
    readonly NodeFailover: 'nodeFailover'
    readonly NodeFailoverComplete: 'nodeFailoverComplete'
    readonly Debug: 'debug'
    readonly Error: 'error'
    readonly PlayerCreate: 'playerCreate'
    readonly PlayerDestroy: 'playerDestroy'
    readonly PlayersRebuilt: 'playersRebuilt'
    readonly PlayerMigrated: 'playerMigrated'
  }
}
