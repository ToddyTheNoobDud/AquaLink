/**
 * shared modules for all, e.g: config, nodes, etc.
 */
import type { Level } from 'pino'

/**
 * Logger/retry settings and your Discord adapter.
 * logging and nodeConfigs are required when you pass options.
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
   * true delays Queue creation; false or omitted creates it with the Player.
   * play(track) can keep only current. Waiting tracks or any player.queue access
   * (even queue.size) create the queue. current/hasQueue reads don't.
   * Created queues are reused, even when empty.
   *
   * Only Queue allocation is delayed; Player/Connection creation stays the same.
   * The first queue use pays the cost, so savings depend on usage. Each player reads
   * this flag once at creation; later changes affect new players only.
   * It doesn't trigger import() or playback.
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
  /** Sends opcode 4 to the guild's shard. Required for voice joining. */
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
     * Retry limit; 0 disables finite retries. Ignored with infiniteReconnects=true.
     * Node falls back to 10 if absent; this type requires it when you pass options.
     */
    maxRetries: number
  }
}

/**
 * Outgoing voice update for AquaOptions.send. channel_id=null leaves voice;
 * a channel ID joins it.
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
 * Incoming VOICE_STATE_UPDATE. Aqua uses the bot's own state and ignores packets
 * without guild_id, which is optional here.
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
  /** User whose state changed. Aqua matches this against the bot ID. */
  user_id: string
  /** Discord voice session, not the node's WebSocket session. */
  session_id: string
  /** Current voice channel, or null when the user leaves. */
  channel_id: string | null
}

/**
 * Incoming VOICE_SERVER_UPDATE, paired with the bot's voice state.
 * endpoint=null keeps joining pending until a usable server arrives.
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
  /** Discord voice token. Don't log it. */
  token: string
  /** Voice server hostname, or null while one isn't available. */
  endpoint: string | null
}

/**
 * Incoming voice packets. Checking t narrows the type of d.
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
 * Complete voice data for a player PATCH. Connection.getVoiceInfo() can still
 * have missing fields while joining; this type requires them all.
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
 * Supported player PATCH fields: voice and encoded track. Omitted fields aren't sent.
 * Other API fields, including volume, filters and pause, still need types/handling.
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
 * Server connection config. All fields are required; password is the node's password,
 * separate from your Discord bot token.
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
  /** Unique node name, used as the nodesMap key. */
  name: string
  /** true for HTTPS/WSS, false for HTTP/WS. Required. */
  ssl: boolean
  /** password of the node */
  password: string
  /** Hostname/IP only, without http://, a port or a path. */
  host: string
  /** port of the host you want to connect */
  port: number
}

/**
 * Use TrackAPI['track'] for one payload. TrackAPI is a type container;
 * /loadtracks returns LoadResult. pluginInfo/userData aren't typed here yet.
 * uri/artworkUrl/isrc still require strings here; the protocol also allows null.
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
    /** Encoded data sent back to start playback. */
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
      /** Payload position in milliseconds; doesn't update itself. */
      position: number
      /** Display title. */
      title: string
      /** Track URL; null isn't typed yet. */
      uri: string
      /** Artwork URL; null isn't typed yet. */
      artworkUrl: string
      /** Recording code; null isn't typed yet. */
      isrc: string
      /** Source name returned by the node, for example youtube. */
      sourceName: string
    }
  }
}

/**
 * Raw /v4/loadtracks result. Check loadType before reading data.
 * Search/direct track data is typed and converted by Aqua.resolve.
 * Playlist, empty and error data still use unknown and need payload types.
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
      loadType: 'track'
      data: TrackAPI['track']
    }
  | {
      loadType: 'playlist' | 'empty' | 'error'
      data: unknown
    }
