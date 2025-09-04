import { EventEmitter } from "events";

declare module "aqualink" {
    // Main Classes
    export class Aqua extends EventEmitter {
        constructor(client: any, nodes: NodeOptions[], options?: AquaOptions);

       // Additional properties found in implementation
        plugins: Plugin[];
        players: Map<string, Player>;
        nodeMap: Map<string, Node>;
        _nodeStates: Map<string, { connected: boolean; failoverInProgress: boolean }>;
        _failoverQueue: Map<string, number>;
        _lastFailoverAttempt: Map<string, number>;
        _brokenPlayers: Map<string, any>;
        _rebuildLocks: Set<string>;
        _leastUsedNodesCache: Node[] | null;
        _leastUsedNodesCacheTime: number;
        _nodeLoadCache: Map<string, number>;
        _nodeLoadCacheTime: Map<string, number>;


        init(clientId: string): Promise<Aqua>;
        createNode(options: NodeOptions): Promise<Node>;
        destroyNode(identifier: string): void;
        updateVoiceState(data: VoiceStateUpdate): void;
        fetchRegion(region: string): Node[];
        createConnection(options: ConnectionOptions): Player;
        createPlayer(node: Node, options: PlayerOptions): Player;
        destroyPlayer(guildId: string): Promise<void>;
        resolve(options: ResolveOptions): Promise<ResolveResponse>;
        get(guildId: string): Player;
        search(query: string, requester: any, source?: SearchSource): Promise<Track[] | null>;


        // Missing public methods
        bypassChecks?: { nodeFetchInfo?: boolean };
    }

    export class Node {
        constructor(aqua: Aqua, connOptions: NodeOptions, options?: NodeAdditionalOptions);

        // Core Properties
        aqua: Aqua;
        host: string;
        name: string;
        port: number;
        password: string;
        ssl: boolean;
        sessionId: string | null;
        regions: string[];
        wsUrl: string;
        rest: Rest;
        resumeTimeout: number;
        autoResume: boolean;
        reconnectTimeout: number;
        reconnectTries: number;
        infiniteReconnects: boolean;
        connected: boolean;
        info: NodeInfo | null;
        ws: any | null; // WebSocket
        reconnectAttempted: number;
        reconnectTimeoutId: NodeJS.Timeout | null;
        isDestroyed: boolean;
        stats: NodeStats;
        players: Set<Player>;
        options: NodeOptions;

        // Methods
        connect(): Promise<void>;
        destroy(clean?: boolean): void;
        getStats(): Promise<NodeStats>;
    }

    export class Player extends EventEmitter {
        constructor(aqua: Aqua, nodes: Node, options: PlayerOptions);

        // Static Properties
        static readonly LOOP_MODES: {
            readonly NONE: 0;
            readonly TRACK: 1;
            readonly QUEUE: 2;
        };

        // Core Properties
        aqua: Aqua;
        nodes: Node;
        guildId: string;
        textChannel: string;
        voiceChannel: string;
        connection: Connection;
        filters: Filters;
        volume: number;
        loop: LoopModeName | LoopMode;
        queue: Queue;
        shouldDeleteMessage: boolean;
        leaveOnEnd: boolean;
        playing: boolean;
        paused: boolean;
        connected: boolean;
        destroyed: boolean;
        current: Track | null;
        position: number;
        timestamp: number;
        ping: number;
        nowPlayingMessage: any;
        isAutoplayEnabled: boolean;
        isAutoplay: boolean;
        autoplaySeed: AutoplaySeed | null;
        deaf: boolean;
        mute: boolean;
        autoplayRetries: number;
        reconnectionRetries: number;
        previousIdentifiers: Set<string>;

        // Getters
        get previous(): Track | null;
        get currenttrack(): Track | null;

        // Core Methods
        play(): Promise<Player>;
        connect(options?: ConnectionOptions): Player;
        destroy(options?: { preserveClient?: boolean; skipRemote?: boolean }): Player;
        pause(paused: boolean): Player;
        seek(position: number): Player;
        stop(): Player;
        setVolume(volume: number): Player;
        setLoop(mode: LoopMode | LoopModeName): Player;
        setTextChannel(channel: string): Player;
        setVoiceChannel(channel: string): Player;
        disconnect(): Player;
        shuffle(): Player;
        getQueue(): Queue;
        replay(): Player;
        skip(): Player;

        // Advanced Methods
        getLyrics(options?: LyricsOptions): Promise<LyricsResponse | null>;
        subscribeLiveLyrics(): Promise<any>;
        unsubscribeLiveLyrics(): Promise<any>;
        autoplay(): Promise<Player>;
        setAutoplay(enabled: boolean): Player;
        updatePlayer(data: any): Promise<any>;
        cleanup(): Promise<void>;

        // Data Methods
        set(key: string, value: any): void;
        get(key: string): any;
        clearData(): Player;

        // Utility Methods
        send(data: any): void;
        batchUpdatePlayer(data: any, immediate?: boolean): Promise<void>;
    }

    export class Track {
        constructor(data?: TrackData, requester?: any, nodes?: Node);

        // Properties
        identifier: string;
        isSeekable: boolean;
        author: string;
        position: number;
        duration: number;
        isStream: boolean;
        title: string;
        uri: string;
        sourceName: string;
        artworkUrl: string;
        track: string | null;
        playlist: PlaylistInfo | null;
        requester: any;
        nodes: Node;

        // Getters
        get info(): TrackInfo;
        get length(): number;
        get thumbnail(): string;

        // Methods
        resolveThumbnail(url?: string): string | null;
        resolve(aqua: Aqua): Promise<Track | null>;
        isValid(): boolean;
        dispose(): void;
    }

    export class Rest {
        constructor(aqua: Aqua, node: Node);

        aqua: Aqua;
        node: Node;
        sessionId: string;
        calls: number;

        setSessionId(sessionId: string): void;
        makeRequest(method: HttpMethod, endpoint: string, body?: any): Promise<any>;
        updatePlayer(options: UpdatePlayerOptions): Promise<any>;
        destroyPlayer(guildId: string): Promise<any>;
        getLyrics(options: GetLyricsOptions): Promise<LyricsResponse>;
        subscribeLiveLyrics(guildId: string, sync?: boolean): Promise<any>;
        unsubscribeLiveLyrics(guildId: string): Promise<any>;
        getStats(): Promise<NodeStats>;
    }

    export class Queue extends Array<Track> {
        constructor(...elements: Track[]);

        // Properties
        size: number;
        first: Track | null;
        last: Track | null;

        // Methods
        add(...tracks: Track[]): void;
        push(track: Track): number;
        unshift(track: Track): number;
        shift(): Track | undefined;
        clear(): void;
        isEmpty(): boolean;
        toArray(): Track[];
    }

    export class Filters {
        constructor(player: Player, options?: FilterOptions);

        player: Player;
        filters: {
            volume: number;
            equalizer: EqualizerBand[];
            karaoke: KaraokeSettings | null;
            timescale: TimescaleSettings | null;
            tremolo: TremoloSettings | null;
            vibrato: VibratoSettings | null;
            rotation: RotationSettings | null;
            distortion: DistortionSettings | null;
            channelMix: ChannelMixSettings | null;
            lowPass: LowPassSettings | null;
        };
        presets: {
            bassboost: number | null;
            slowmode: boolean | null;
            nightcore: boolean | null;
            vaporwave: boolean | null;
            _8d: boolean | null;
        };

        // Filter Methods
        setEqualizer(bands: EqualizerBand[]): Filters;
        setKaraoke(enabled: boolean, options?: KaraokeSettings): Filters;
        setTimescale(options?: TimescaleSettings): Filters;
        setTremolo(options?: TremoloSettings): Filters;
        setVibrato(options?: VibratoSettings): Filters;
        setRotation( options?: RotationSettings): Filters;
        setDistortion( options?: DistortionSettings): Filters;
        setChannelMix(options?: ChannelMixSettings): Filters;
        setLowPass( options?: LowPassSettings): Filters;
        setBassboost(enabled: boolean, options?: { value?: number }): Filters;
        setSlowmode(enabled: boolean, options?: { rate?: number }): Filters;
        setNightcore(enabled: boolean, options?: { rate?: number }): Filters;
        setVaporwave(enabled: boolean, options?: { pitch?: number }): Filters;
        set8D(enabled: boolean, options?: { rotationHz?: number }): Filters;
        clearFilters(): Promise<Filters>;
        updateFilters(): Promise<Filters>;
    }

    export class Connection {
        constructor(player: Player);

        voiceChannel: string;
        sessionId: string | null;
        endpoint: string | null;
        token: string | null;
        region: string | null;
        sequence: number;

        setServerUpdate(data: VoiceServerUpdate['d']): void;
        setStateUpdate(data: VoiceStateUpdate['d']): void;
        updateSequence(seq: number): void;
        destroy(): void;
    }

    export class Plugin {
        constructor(name: string);
        name: string;
        load(aqua: Aqua): void | Promise<void>;
        unload?(aqua: Aqua): void | Promise<void>;
    }

    // Configuration Interfaces
    export interface AquaOptions {
        shouldDeleteMessage?: boolean;
        defaultSearchPlatform?: SearchSource;
        leaveOnEnd?: boolean;
        restVersion?: RestVersion;
        plugins?: Plugin[];
        send?: (payload: any) => void;
        autoResume?: boolean;
        infiniteReconnects?: boolean;
        failoverOptions?: FailoverOptions;
    }

    export interface FailoverOptions {
        enabled?: boolean;
        maxRetries?: number;
        retryDelay?: number;
        preservePosition?: boolean;
        resumePlayback?: boolean;
        cooldownTime?: number;
        maxFailoverAttempts?: number;
    }

    export interface NodeOptions {
        host: string;
        name?: string;
        port?: number;
        password?: string;
        ssl?: boolean;
        sessionId?: string;
        regions?: string[];
    }

    export interface NodeAdditionalOptions {
        resumeTimeout?: number;
        autoResume?: boolean;
        reconnectTimeout?: number;
        reconnectTries?: number;
        infiniteReconnects?: boolean;
        timeout?: number;
        maxPayload?: number;
        skipUTF8Validation?: boolean;
    }

    export interface PlayerOptions {
        guildId: string;
        textChannel: string;
        voiceChannel: string;
        defaultVolume?: number;
        loop?: LoopModeName;
        deaf?: boolean;
        mute?: boolean;
    }

    export interface ConnectionOptions {
        guildId: string;
        voiceChannel: string;
        textChannel?: string;
        deaf?: boolean;
        mute?: boolean;
        defaultVolume?: number;
        region?: string;
    }

    export interface ResolveOptions {
        query: string;
        source?: SearchSource | string;
        requester: any;
        nodes?: string | Node | Node[];
    }

    // Response and Data Interfaces
    export interface ResolveResponse {
        loadType: LoadType;
        exception: LavalinkException | null;
        playlistInfo: PlaylistInfo | null;
        pluginInfo: Record<string, any>;
        tracks: Track[];
    }

    export interface NodeStats {
        players: number;
        playingPlayers: number;
        uptime: number;
        memory: {
            free: number;
            used: number;
            allocated: number;
            reservable: number;
        };
        cpu: {
            cores: number;
            systemLoad: number;
            lavalinkLoad: number;
        };
        frameStats: {
            sent: number;
            nulled: number;
            deficit: number;
        };
        ping?: number;
    }

    export interface NodeInfo {
        version: {
            semver: string;
            major: number;
            minor: number;
            patch: number;
        };
        buildTime: number;
        git: {
            branch: string;
            commit: string;
            commitTime: number;
        };
        jvm: string;
        lavaplayer: string;
        sourceManagers: string[];
        filters: string[];
        plugins: Array<{
            name: string;
            version: string;
        }>;
    }

    export interface TrackInfo {
        identifier: string;
        isSeekable: boolean;
        author: string;
        length: number;
        isStream: boolean;
        title: string;
        uri: string;
        sourceName: string;
        artworkUrl: string;
        position?: number;
    }

    export interface TrackData {
        encoded?: string;
        info: TrackInfo;
        playlist?: PlaylistInfo;
    }

    export interface PlaylistInfo {
        name: string;
        selectedTrack?: number;
        thumbnail?: string;
    }

    export interface LavalinkException {
        message: string;
        severity: string;
        cause: string;
    }

    // Filter Interfaces
    export interface FilterOptions {
        volume?: number;
        equalizer?: EqualizerBand[];
        karaoke?: KaraokeSettings;
        timescale?: TimescaleSettings;
        tremolo?: TremoloSettings;
        vibrato?: VibratoSettings;
        rotation?: RotationSettings;
        distortion?: DistortionSettings;
        channelMix?: ChannelMixSettings;
        lowPass?: LowPassSettings;
        bassboost?: number;
        slowmode?: boolean;
        nightcore?: boolean;
        vaporwave?: boolean;
        _8d?: boolean;
    }

    export interface EqualizerBand {
        band: number;
        gain: number;
    }

    export interface KaraokeSettings {
        level?: number;
        monoLevel?: number;
        filterBand?: number;
        filterWidth?: number;
    }

    export interface TimescaleSettings {
        speed?: number;
        pitch?: number;
        rate?: number;
    }

    export interface TremoloSettings {
        frequency?: number;
        depth?: number;
    }

    export interface VibratoSettings {
        frequency?: number;
        depth?: number;
    }

    export interface RotationSettings {
        rotationHz?: number;
    }

    export interface DistortionSettings {
        distortion?: number;
        sinOffset?: number;
        sinScale?: number;
        cosOffset?: number;
        cosScale?: number;
        tanOffset?: number;
        tanScale?: number;
        offset?: number;
        scale?: number;
    }

    export interface ChannelMixSettings {
        leftToLeft?: number;
        leftToRight?: number;
        rightToLeft?: number;
        rightToRight?: number;
    }

    export interface LowPassSettings {
        smoothing?: number;
    }

    // Voice Update Interfaces
    export interface VoiceStateUpdate {
        d: {
            guild_id: string;
            channel_id: string | null;
            user_id: string;
            session_id: string;
            deaf: boolean;
            mute: boolean;
            self_deaf: boolean;
            self_mute: boolean;
            suppress: boolean;
            request_to_speak_timestamp: string | null;
        };
        t: 'VOICE_STATE_UPDATE';
    }

    export interface VoiceServerUpdate {
        d: {
            token: string;
            guild_id: string;
            endpoint: string | null;
        };
        t: 'VOICE_SERVER_UPDATE';
    }

    // Utility Interfaces
    export interface LyricsOptions {
        query?: string;
        useCurrentTrack?: boolean;
        skipTrackSource?: boolean;
    }

    export interface LyricsResponse {
        text?: string;
        source?: string;
        lines?: Array<{
            line: string;
            timestamp?: number;
        }>;
    }

    export interface AutoplaySeed {
        trackId: string;
        artistIds: string;
    }

    export interface UpdatePlayerOptions {
        guildId: string;
        data: {
            track?: { encoded: string | null };
            position?: number;
            volume?: number;
            paused?: boolean;
            filters?: any;
            voice?: any;
        };
    }

    export interface GetLyricsOptions {
        track: {
            info: TrackInfo;
            encoded?: string;
            identifier?: string;
            guild_id?: string;
        };
        skipTrackSource?: boolean;
    }

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
        | 'http';

    export type LoopMode = 0 | 1 | 2;
    export type LoopModeName = 'none' | 'track' | 'queue';

    export type LoadType =
        | 'track'
        | 'playlist'
        | 'search'
        | 'empty'
        | 'error';

    export type RestVersion = 'v3' | 'v4';

    export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

    // Event Interfaces
    export interface AquaEvents {
        'nodeConnect': (node: Node) => void;
        'nodeConnected': (node: Node) => void;
        'nodeDisconnect': (node: Node, data: { code: number; reason: string }) => void;
        'nodeError': (node: Node, error: Error) => void;
        'nodeReconnect': (node: Node, data: any) => void;
        'nodeCreate': (node: Node) => void;
        'nodeDestroy': (node: Node) => void;
        'nodeReady': (node: Node, data: any) => void;
        'nodeFailover': (node: Node) => void;
        'nodeFailoverComplete': (node: Node, successful: number, failed: number) => void;
        'playerCreate': (player: Player) => void;
        'playerDestroy': (player: Player) => void;
        'playerUpdate': (player: Player, packet: any) => void;
        'playerMigrated': (oldPlayer: Player, newPlayer: Player, targetNode: Node) => void;
        'playerReconnected': (player: Player, data: any) => void;
        'trackStart': (player: Player, track: Track) => void;
        'trackEnd': (player: Player, track: Track, reason?: string) => void;
        'trackError': (player: Player, track: Track, error: any) => void;
        'trackStuck': (player: Player, track: Track, thresholdMs: number) => void;
        'trackChange': (player: Player, track: Track, payload: any) => void;
        'queueEnd': (player: Player) => void;
        'playerMove': (oldChannel: string, newChannel: string) => void;
        'playersRebuilt': (node: Node, count: number) => void;
        'reconnectionFailed': (player: Player, data: any) => void;
        'socketClosed': (player: Player, payload: any) => void;
        'lyricsLine': (player: Player, track: Track, payload: any) => void;
        'lyricsFound': (player: Player, track: Track, payload: any) => void;
        'lyricsNotFound': (player: Player, track: Track, payload: any) => void;
        'autoplayFailed': (player: Player, error: Error) => void;
        'debug': (source: string, message: string) => void;
        'error': (node: Node | null, error: Error) => void;
    }

    // Event Emitter Type Extensions for Aqua
    interface Aqua {
        on<K extends keyof AquaEvents>(event: K, listener: AquaEvents[K]): this;
        on(event: string | symbol, listener: (...args: any[]) => void): this;

        once<K extends keyof AquaEvents>(event: K, listener: AquaEvents[K]): this;
        once(event: string | symbol, listener: (...args: any[]) => void): this;

        emit<K extends keyof AquaEvents>(event: K, ...args: Parameters<AquaEvents[K]>): boolean;
        emit(event: string | symbol, ...args: any[]): boolean;

        off<K extends keyof AquaEvents>(event: K, listener: AquaEvents[K]): this;
        off(event: string | symbol, listener: (...args: any[]) => void): this;

        removeListener<K extends keyof AquaEvents>(event: K, listener: AquaEvents[K]): this;
        removeListener(event: string | symbol, listener: (...args: any[]) => void): this;

        addListener<K extends keyof AquaEvents>(event: K, listener: AquaEvents[K]): this;
        addListener(event: string | symbol, listener: (...args: any[]) => void): this;

        removeAllListeners<K extends keyof AquaEvents>(event?: K): this;
        removeAllListeners(event?: string | symbol): this;
    }
    export interface PlayerEvents {
        'destroy': () => void;
        'playerUpdate': (packet: any) => void;
        'event': (payload: any) => void;
        'trackStart': (track: Track) => void;
        'trackEnd': (track: Track, reason?: string) => void;
        'trackError': (track: Track, error: any) => void;
        'trackStuck': (track: Track, thresholdMs: number) => void;
        'trackChange': (track: Track, payload: any) => void;
        'socketClosed': (payload: any) => void;
        'lyricsLine': (track: Track, payload: any) => void;
        'lyricsFound': (track: Track, payload: any) => void;
        'lyricsNotFound': (track: Track, payload: any) => void;
    }

      interface Player {
        on<K extends keyof PlayerEvents>(event: K, listener: PlayerEvents[K]): this;
        on(event: string | symbol, listener: (...args: any[]) => void): this;

        once<K extends keyof PlayerEvents>(event: K, listener: PlayerEvents[K]): this;
        once(event: string | symbol, listener: (...args: any[]) => void): this;

        emit<K extends keyof PlayerEvents>(event: K, ...args: Parameters<PlayerEvents[K]>): boolean;
        emit(event: string | symbol, ...args: any[]): boolean;

        off<K extends keyof PlayerEvents>(event: K, listener: PlayerEvents[K]): this;
        off(event: string | symbol, listener: (...args: any[]) => void): this;

        removeListener<K extends keyof PlayerEvents>(event: K, listener: PlayerEvents[K]): this;
        removeListener(event: string | symbol, listener: (...args: any[]) => void): this;

        addListener<K extends keyof PlayerEvents>(event: K, listener: PlayerEvents[K]): this;
        addListener(event: string | symbol, listener: (...args: any[]) => void): this;

        removeAllListeners<K extends keyof PlayerEvents>(event?: K): this;
        removeAllListeners(event?: string | symbol): this;
    }

    // Missing Player Properties and Methods
    interface Player {
        // Additional properties found in implementation
        self_deaf: boolean;
        self_mute: boolean;
        players: Set<Player>; // For Node class

        // Internal properties
        _updateBatcher: any;
        _dataStore: Map<string, any>;

        // Event handler methods (these are called internally)
        trackStart(player: Player, track: Track): Promise<void>;
        trackEnd(player: Player, track: Track, payload: any): Promise<void>;
        trackError(player: Player, track: Track, payload: any): Promise<void>;
        trackStuck(player: Player, track: Track, payload: any): Promise<void>;
        trackChange(player: Player, track: Track, payload: any): Promise<void>;
        socketClosed(player: Player, track: Track, payload: any): Promise<void>;
        lyricsLine(player: Player, track: Track, payload: any): Promise<void>;
        lyricsFound(player: Player, track: Track, payload: any): Promise<void>;
        lyricsNotFound(player: Player, track: Track, payload: any): Promise<void>;
    }

    interface Node {
        // Additional properties found in implementation
        timeout: number;
        maxPayload: number;
        skipUTF8Validation: boolean;
        _isConnecting: boolean;
        _debugEnabled: boolean;
        _headers: Record<string, string>;
        _boundHandlers: Record<string, Function>;

        // Methods missing from original definitions
        _handleOpen(): Promise<void>;
        _handleError(error: any): void;
        _handleMessage(data: any, isBinary: boolean): void;
        _handleClose(code: number, reason: any): void;
        _handleReady(payload: any): Promise<void>;
        _emitError(error: any): void;
        _emitDebug(message: string | (() => string)): void;
    }

    interface Rest {
        // Additional properties
        timeout: number;
        baseUrl: string;
        defaultHeaders: Record<string, string>;
        agent: any; // HTTP/HTTPS Agent

        // Missing REST methods found in implementation
        getPlayer(guildId: string): Promise<any>;
        getPlayers(): Promise<any>;
        decodeTrack(encodedTrack: string): Promise<any>;
        decodeTracks(encodedTracks: string[]): Promise<any>;
        getInfo(): Promise<NodeInfo>;
        getVersion(): Promise<string>;
        getRoutePlannerStatus(): Promise<any>;
        freeRoutePlannerAddress(address: string): Promise<any>;
        freeAllRoutePlannerAddresses(): Promise<any>;
        destroy(): void;
    }

   interface Connection {
        // Internal properties found in implementation
        _player: Player;
        _aqua: Aqua;
        _nodes: Node;
        _guildId: string;
        _clientId: string;
        _lastEndpoint: string | null;
        _pendingUpdate: any;
        _updateTimer: NodeJS.Timeout | null;
        _hasDebugListeners: boolean;
        _hasMoveListeners: boolean;

        // Methods not in original definition
        _extractRegion(endpoint: string): string | null;
        _scheduleVoiceUpdate(isResume?: boolean): void;
        _executeVoiceUpdate(): void;
        _sendUpdate(payload: any): Promise<void>;
        _handleDisconnect(): void;
        _clearPendingUpdate(): void;
    }

  export type EventHandler<T = any> = (...args: T[]) => void | Promise<void>;

    // Extended ResolveOptions for internal use
    export interface ExtendedResolveOptions extends ResolveOptions {
        node?: Node;
    }
     interface Plugin {
        // Optional unload method should be properly typed
        unload?(aqua: Aqua): void | Promise<void>;
    }

      export const LOOP_MODES: {
        readonly NONE: 0;
        readonly TRACK: 1;
        readonly QUEUE: 2;
    };

      interface Player {
        readonly EVENT_HANDLERS: Record<string, string>;
    }
      export interface TrackResolutionOptions {
        toFront?: boolean;
    }

    // Additional Filter Preset Options
    export interface FilterPresetOptions {
        value?: number;
        rate?: number;
        pitch?: number;
        rotationHz?: number;
    }

    // Error Extensions
    export interface AquaError extends Error {
        statusCode?: number;
        statusMessage?: string;
        headers?: Record<string, string>;
        body?: any;
    }

    // Save/Load Player Data Interfaces
    export interface SavedPlayerData {
        g: string; // guildId
        t: string; // textChannel
        v: string; // voiceChannel
        u: string | null; // uri
        p: number; // position
        ts: number; // timestamp
        q: string[]; // queue uris
        r: string | null; // requester
        vol: number; // volume
        pa: boolean; // paused
        pl: boolean; // playing
        nw: string | null; // nowPlayingMessage id
    }
}
