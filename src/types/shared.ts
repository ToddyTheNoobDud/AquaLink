/**
 * shared modules for all, e.g: config, nodes, etc.
 */
import type { Level } from 'pino'

/**
 * Aqua's logging/retry settings and the bridge to your Discord library.
 * If you pass options, logging and nodeConfigs are required by this type.
 *
 * @example
 * ```ts
 * const options: AquaOptions = {
 *   logging: { level: 'debug' },
 *   lazyloadPlayer: true,
 *   nodeConfigs: { infiniteReconnects: false, maxRetries: 3 },
 *   send: payload => sendToDiscord(payload)
 * }
 * ```
 */
export interface AquaOptions {
  /**
   * Creates the player's Queue only when it's needed, instead of in the constructor.
   * play(track) can set current without a Queue. Tracks waiting behind other work
   * need one. Once created, the same queue is reused even after it becomes empty.
   * Accessing player.queue also creates it, including reads like queue.size;
   * player.hasQueue and player.current don't allocate a queue.
   *
   * true enables lazy queue creation; false or omitted keeps immediate creation.
   * This only changes Queue allocation: Player and Connection are still created
   * normally. It doesn't load modules with import() or start playback by itself.
   * The first queue use pays the creation cost, so savings depend on actual usage.
   * The flag is read when each player is constructed; changing it later doesn't
   * reconfigure existing players. Default is false.
   *
   * @example
   * ```ts
   * const options: AquaOptions = {
   *   lazyloadPlayer: true,
   *   logging: { level: 'info' },
   *   nodeConfigs: { infiniteReconnects: false, maxRetries: 3 }
   * }
   * const aqua = new AquaManager(client, [nodeOptions], options)
   * ```
   */
  lazyloadPlayer?: boolean
  /** Your adapter: send opcode 4 to the guild's shard. Required when joining voice. */
  send?: (payload: VoiceUpdatePayload) => void | Promise<void>
  /** Pino settings used by Aqua's shared logger. */
  logging: {
    /** Pino level, for example debug, info or silent. */
    level: Level
  }
  /** What Node should do after its socket closes. */
  nodeConfigs: {
    /** Keep retrying while the node is down, ignoring maxRetries when true. */
    infiniteReconnects: boolean
    /**
     * Finite retry limit; 0 disables retries. Ignored if infiniteReconnects is true.
     * Node uses 10 if this setting is absent, though this type requires it in options.
     */
    maxRetries: number
  }
}

/**
 * Outgoing Discord gateway voice update, sent through AquaOptions.send.
 * channel_id=null leaves voice; a channel ID joins voice.
 *
 * @example
 * ```ts
 * const payload: VoiceUpdatePayload = {
 *   op: 4,
 *   d: { guild_id: '123', channel_id: '456', self_deaf: true, self_mute: false }
 * }
 * await aqua.send(payload)
 * ```
 */
export interface VoiceUpdatePayload {
  /** Discord's voice-state update opcode, always 4. */
  op: 4
  /** Discord uses snake_case for these gateway fields. */
  d: {
    /** Guild whose shard should receive this payload. */
    guild_id: string
    /** Voice channel to join, or null to leave. */
    channel_id: string | null
    /** Whether the bot should deafen itself. */
    self_deaf: boolean
    /** Whether the bot should mute itself. */
    self_mute: boolean
  }
}

/**
 * Incoming Discord VOICE_STATE_UPDATE data; Aqua needs the bot's own update.
 * guild_id is optional in this type; Aqua ignores packets without one.
 *
 * @example
 * ```ts
 * const data: VoiceStateUpdate = {
 *   guild_id: '123', user_id: client.id, session_id: 'voice-session', channel_id: '456'
 * }
 * await aqua.updateVoiceState({ t: 'VOICE_STATE_UPDATE', d: data })
 * ```
 */
export interface VoiceStateUpdate {
  /** Discord guild ID, if this voice state belongs to a guild. */
  guild_id?: string
  /** User whose voice state changed; Aqua checks this against its bot ID. */
  user_id: string
  /** Discord voice session, not the node's WebSocket session. */
  session_id: string
  /** Current voice channel, or null when the user leaves. */
  channel_id: string | null
}

/**
 * Incoming Discord VOICE_SERVER_UPDATE data, paired with the bot's voice state.
 * endpoint=null means we still need a usable voice server before sending REST data.
 *
 * @example
 * ```ts
 * const data: VoiceServerUpdate = {
 *   guild_id: '123', token: 'voice-token', endpoint: 'voice.example.invalid'
 * }
 * await aqua.updateVoiceState({ t: 'VOICE_SERVER_UPDATE', d: data })
 * ```
 */
export interface VoiceServerUpdate {
  /** Guild these voice credentials belong to. */
  guild_id: string
  /** Voice credential from Discord; don't print real tokens in logs. */
  token: string
  /** Voice server hostname, or null while one isn't available. */
  endpoint: string | null
}

/**
 * The two incoming gateway packets Aqua understands for voice joining.
 * Check t first and TypeScript knows which data shape is inside d.
 *
 * @example
 * ```ts
 * const packet: VoicePacket = {
 *   t: 'VOICE_SERVER_UPDATE',
 *   d: { guild_id: '123', token: 'voice-token', endpoint: 'voice.example.invalid' }
 * }
 * await aqua.updateVoiceState(packet)
 * ```
 */
export type VoicePacket =
  | { t: 'VOICE_STATE_UPDATE'; d: VoiceStateUpdate }
  | { t: 'VOICE_SERVER_UPDATE'; d: VoiceServerUpdate }

/**
 * Complete voice fields sent to the node in a player PATCH.
 * Connection.getVoiceInfo() may still contain missing fields while joining;
 * this type represents the completed data sent by Connection instead.
 *
 * @example
 * ```ts
 * const voice: VoiceInfo = {
 *   token: 'voice-token', endpoint: 'voice.example.invalid',
 *   sessionId: 'discord-voice-session', channelId: '456'
 * }
 * await node.rest.updatePlayers('123', { voice })
 * ```
 */
export interface VoiceInfo {
  /** Discord voice token. */
  token: string
  /** Discord voice server hostname. */
  endpoint: string
  /** Session from Discord's voice-state packet, not node.sessionId. */
  sessionId: string
  /** Discord voice channel ID. */
  channelId: string
}

/**
 * Player PATCH fields supported by the client so far: voice and encoded track.
 * This isn't the complete Lavalink update API yet; volume, filters, pause, etc.
 * still need types/handling. Omitted fields aren't sent in the body.
 *
 * @example
 * ```ts
 * const update: PlayerUpdate = { track: { encoded: track.encoded } }
 * await node.rest.updatePlayers('123', update)
 * ```
 */
export interface PlayerUpdate {
  /** Complete voice credentials for joining. */
  voice?: VoiceInfo
  /** Encoded track string; the protocol also allows null to stop a track. */
  track?: { encoded: string | null }
}

/**
 * How Aqua reaches one Lavalink/NodeLink server.
 * All fields are required here. Password is the server password, not your bot token.
 *
 * @example
 * ```ts
 * const options: NodeOptions = {
 *   name: 'local', host: '127.0.0.1', port: 2333,
 *   password: 'your-node-password', ssl: false
 * }
 * ```
 */
export interface NodeOptions {
  /** Node name, also used as its nodesMap key. Use a unique one. */
  name: string
  /** true uses HTTPS/WSS; false uses HTTP/WS. Set it explicitly. */
  ssl: boolean
  /** password of the node */
  password: string
  /** Hostname/IP only, without http://, a port or a path. */
  host: string
  /** port of the host you want to connect */
  port: number
}

/**
 * Current track payload shape. Use TrackAPI['track'] when you need one track;
 * TrackAPI itself is only the type container, not the /loadtracks response.
 * pluginInfo/userData aren't declared here yet. The protocol also allows null
 * for uri/artworkUrl/isrc, but these draft fields still require strings.
 * @see https://lavalink.dev/api/rest#track-info
 *
 * @example
 * ```ts
 * const data: TrackAPI['track'] = {
 *   encoded: 'encoded-data-from-the-node',
 *   info: {
 *     identifier: 'track-id', isSeekable: true, author: 'Artist',
 *     length: 180000, isStream: false, position: 0, title: 'Song',
 *     uri: 'https://example.invalid/song', artworkUrl: 'https://example.invalid/art',
 *     isrc: 'TEST123', sourceName: 'youtube'
 *   }
 * }
 * const track = new Track(data)
 * ```
 */
export interface TrackAPI {
  /** One raw track object from the server. */
  track: {
    /** Encoded track data to send back when starting playback. */
    encoded: string
    /** Track metadata; time values below are in milliseconds. */
    info: {
      /** Identifier used by the source, for example a YouTube video ID. */
      identifier: string
      /** Whether this track supports seeking. */
      isSeekable: boolean
      /** Artist/uploader name. */
      author: string
      /** Track duration in milliseconds. */
      length: number
      /** Whether this is a live stream. */
      isStream: boolean
      /** Position in milliseconds supplied by this payload, not a live clock. */
      position: number
      /** Display title. */
      title: string
      /** Link to the track; this draft doesn't represent protocol null yet. */
      uri: string
      /** Artwork URL; this draft doesn't represent protocol null yet. */
      artworkUrl: string
      /** Recording code; this draft doesn't represent protocol null yet. */
      isrc: string
      /** Source name returned by the node, for example youtube. */
      sourceName: string
    }
  }
}

/**
 * Raw /v4/loadtracks result. Check loadType before using data.
 * search has typed tracks; the other branches still use unknown and need their
 * own payload types. Aqua.resolve currently converts only the search branch.
 *
 * @example
 * ```ts
 * const result = await node.rest.loadTracks('slayr eyesight', 'ytsearch')
 * if (result?.loadType === 'search') {
 *   const tracks = result.data.map(data => new Track(data))
 *   console.log(tracks[0]?.info.title)
 * }
 * ```
 */
export type LoadResult =
  | {
      loadType: 'search'
      data: TrackAPI['track'][]
    }
  | {
      loadType: 'track' | 'playlist' | 'empty' | 'error'
      data: unknown
    }
