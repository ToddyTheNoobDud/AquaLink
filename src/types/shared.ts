import type Node from '../nodes/Node.ts'
import type Connection from '../player/Connection.ts'
import type Filters from '../player/Filters.ts'
import type Player from '../player/Player.ts'
import type PlayerEvents from '../player/PlayerEvents.ts'
import type Queue from '../player/Queue.ts'
import type Rest from '../rest/Rest.ts'
import type Track from '../shared/Track.ts'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
export type LoopMode = 0 | 1 | 2
export type LoopModeName = 'none' | 'track' | 'queue'
export type SearchSource =
  | 'ytsearch'
  | 'ytmsearch'
  | 'scsearch'
  | 'spsearch'
  | (string & {})
export type LoadBalancerStrategy = 'leastLoad' | 'random'

/** Pino and small bot-owned loggers both fit this interface. */
export interface Logger {
  info(fieldsOrMessage: object | string, message?: string): void
  debug(fieldsOrMessage: object | string, message?: string): void
  error(fieldsOrMessage: object | string, message?: string): void
}
export type LogLevel =
  | 'trace'
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'fatal'
  | 'silent'

/** Supply subclasses from your bot before anything is created.
 * @example new Aqua(client, nodes, { structures: { Player: MyPlayer } })
 */
export interface Structures {
  Node: typeof Node
  Rest: typeof Rest
  Player: typeof Player
  Queue: typeof Queue
  Connection: typeof Connection
  PlayerEvents: typeof PlayerEvents
  Filters: typeof Filters
  Track: typeof Track
}
/** Waiting-track storage used by Player. Methods are synchronous.
 * Use options.queue as a factory when each player needs its own custom queue.
 */
export interface QueueLike {
  /** Number of waiting tracks. Current stays on Player. */
  readonly size: number
  /** Append references in playback order. */
  add(...tracks: Track[]): unknown
  /** Read without removing. Return null or undefined when the index is missing. */
  at(index: number): Track | null | undefined
  /** Remove the first waiting track, or return undefined when empty. */
  dequeue(): Track | undefined
  /** Drop queue references. Shared Track objects should remain usable. */
  clear(): void
  /** Return a snapshot of the waiting order. */
  toArray(): Track[]
  /** Optional; player.shuffle() delegates here when provided. */
  shuffle?(): unknown
}
/** Defaults are usable; recovery and recommendation policies are opt-in.
 * @example { lazyloadPlayer: true, send: packet => gateway.send(packet) }
 */
export interface AquaOptions {
  /** false by default. true delays Queue creation until it is accessed or needed.
   * Current stays on Player; reading hasQueue doesn't allocate a queue.
   * @example { lazyloadPlayer: true }
   */
  lazyloadPlayer?: boolean
  /** Forward gateway op 4 through the guild's shard. Required for joining voice. */
  send?: (payload: VoiceUpdatePayload) => void | Promise<void>
  /** Your logger instance. Omit it to use Pino. */
  logger?: Logger
  /** Default Pino level is info. Ignored when you supply logger. */
  logging?: { level?: LogLevel }
  /** Retry defaults: infiniteReconnects=false, maxRetries=10. */
  nodeConfigs?: { infiniteReconnects?: boolean; maxRetries?: number }
  /** Override classes before the corresponding instances are created. */
  structures?: Partial<Structures>
  /** false disables waiting tracks. A factory creates separate storage per player.
   * Passing one instance shares it across players, so use that only intentionally.
   * @example { queue: () => new MyQueue() }
   */
  queue?: QueueLike | false | ((player: Player) => QueueLike)
  /** Search prefix for plain queries. Default: ytsearch. URLs pass through. */
  defaultSearchPlatform?: SearchSource
  /** Default: leastLoad. Applies when choosing a node, without moving existing players. */
  loadBalancer?: LoadBalancerStrategy
  /** false by default. Resume server sessions and rebuild players if that session expired.
   * This doesn't rejoin Discord after a kick or move players between nodes.
   */
  autoResume?: boolean
  /** Server session retention in seconds when autoResume is enabled. Default: 60. */
  resumeTimeout?: number
  /** Legacy shorthand; nodeConfigs.infiniteReconnects takes precedence. Default: false. */
  infiniteReconnects?: boolean
  /** false by default. true destroys the player after the waiting queue ends. */
  leaveOnEnd?: boolean
  /** savePlayer stores URLs by default; full stores track payloads. */
  persistTracks?: 'uri' | 'full'
  /** Maximum waiting tracks saved per player. Default: 10. */
  maxQueueSave?: number
  /** Maximum waiting tracks loaded per player. Default: 20. */
  maxTracksRestore?: number
  /** Response-header deadline in ms. Default: 15000. Bodies stay alive until consumed/cancelled. */
  restTimeout?: number
  /** Discord voice join deadline in ms, including the node voice PATCH. Default: 15000. */
  voiceTimeout?: number
  /** Supply your own recommendation policy; no source-specific autoplay in core. */
  autoplay?: (player: Player) => Track | null | Promise<Track | null>
}
export interface NodeOptions {
  /** Hostname without a URL scheme or path. */
  host: string
  /** Registry key; defaults to host. Names must be unique within Aqua. */
  name?: string
  /** Default: 2333. Numeric strings from environment variables are accepted. */
  port?: number | string
  /** Server password. Takes precedence over auth. */
  password?: string
  /** v3 name for password. */
  auth?: string
  /** true uses HTTPS/WSS. Default: false. */
  ssl?: boolean
  /** Previous server session to request when reconnecting. Not Discord's session ID. */
  sessionId?: string
}
/** Per-node constructor overrides. Aqua options supply the defaults. */
export interface NodeAdditionalOptions {
  /** Server resuming timeout in seconds. */
  resumeTimeout?: number
  autoResume?: boolean
  /** Base reconnect delay in ms. Default: 5000; backoff caps at 420000. */
  reconnectTimeout?: number
  /** Retry limit unless infiniteReconnects is enabled. Default: 10. */
  reconnectTries?: number
  infiniteReconnects?: boolean
  /** Per-node REST response-header deadline in ms. Overrides Aqua's restTimeout. */
  timeout?: number
}
/** Guild/channel IDs are strings. Creation waits for the Discord voice handshake. */
export interface ConnectionOptions {
  guildId: string
  voiceChannel: string
  textChannel?: string
  /** Defaults to true. */
  deaf?: boolean
  /** Defaults to false. */
  mute?: boolean
  /** Initial player volume. Default: 100. */
  defaultVolume?: number
  /** Per-player queue override. false/null disables waiting tracks. */
  queue?: QueueLike | false | null
}
export interface PlayerOptions extends ConnectionOptions {
  loop?: LoopMode | LoopModeName
}
export interface VoiceUpdatePayload {
  op: 4
  d: {
    guild_id: string
    channel_id: string | null
    self_deaf: boolean
    self_mute: boolean
  }
}
export interface VoiceStateUpdate {
  guild_id?: string
  user_id: string
  session_id: string
  channel_id: string | null
  self_deaf?: boolean
  self_mute?: boolean
}
export interface VoiceServerUpdate {
  guild_id: string
  token: string
  endpoint: string | null
}
export type VoicePacket =
  | { t: 'VOICE_STATE_UPDATE'; d: VoiceStateUpdate }
  | { t: 'VOICE_SERVER_UPDATE'; d: VoiceServerUpdate }
/** Credentials sent to the node. Keep these out of logs and saved player records. */
export interface VoiceInfo {
  token: string
  endpoint: string
  sessionId: string
  channelId: string
}
/** Server track metadata. Times and lengths use milliseconds. Extra source fields pass through. */
export interface TrackInfo {
  identifier: string
  isSeekable: boolean
  author: string
  length: number
  isStream: boolean
  position: number
  title: string
  uri: string | null
  artworkUrl: string | null
  isrc: string | null
  sourceName: string
  [field: string]: unknown
}
/** Payload accepted by Track. An unresolved item can omit encoded and resolve later by URI. */
export interface TrackData {
  encoded?: string | null
  track?: string | null
  info: TrackInfo
  pluginInfo?: Record<string, unknown>
  userData?: Record<string, unknown> | null
  playlist?: PlaylistInfo | null
  requester?: unknown
  node?: Node | null
  nodes?: Node | null
}
export interface TrackAPI {
  track: TrackData & { encoded: string }
}
export interface PlaylistInfo {
  name: string
  selectedTrack?: number
  thumbnail?: string | null
  [field: string]: unknown
}
export interface LavalinkException {
  message: string | null
  severity: string
  cause: string
  [field: string]: unknown
}
export type LoadType = 'track' | 'playlist' | 'search' | 'empty' | 'error'
export type LoadResult = (
  | { loadType: 'search'; data: TrackAPI['track'][] }
  | { loadType: 'track'; data: TrackAPI['track'] }
  | {
      loadType: 'playlist'
      data: {
        info: PlaylistInfo
        tracks: TrackAPI['track'][]
        pluginInfo?: Record<string, unknown>
      }
    }
  | { loadType: 'empty'; data: Record<string, never> | null }
  | { loadType: 'error'; data: LavalinkException }
) & { pluginInfo?: Record<string, unknown> }
/** Object-form resolve input. URLs and explicit source prefixes pass through unchanged.
 * @example await aqua.resolve({ query: 'artist song', source: 'scsearch', requester: user })
 */
export interface ResolveOptions {
  query: string
  source?: SearchSource
  requester?: unknown
  nodes?: string | Node | Node[]
}
/** Object-form result. Empty/error loads have no tracks; inspect exception for server errors. */
export interface ResolveResponse {
  loadType: LoadType
  exception: LavalinkException | null
  playlistInfo: PlaylistInfo | null
  pluginInfo: Record<string, unknown>
  tracks: Track[]
}
export interface TrackResolutionOptions {
  platform?: SearchSource
  node?: Node
  toFront?: boolean
}
export type SerializedTrack = TrackData
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
/** Protocol filters and open plugin fields.
 * @example await player.updatePlayer({ filters: { echo: { delay: 500 } } })
 */
export interface FilterOptions {
  volume?: number
  equalizer?: EqualizerBand[]
  karaoke?: KaraokeSettings | null
  timescale?: TimescaleSettings | null
  tremolo?: TremoloSettings | null
  vibrato?: VibratoSettings | null
  rotation?: RotationSettings | null
  distortion?: DistortionSettings | null
  channelMix?: ChannelMixSettings | null
  lowPass?: LowPassSettings | null
  pluginFilters?: Record<string, unknown> | null
  echo?: { delay?: number; feedback?: number; mix?: number }
  bassboost?: number | null
  slowmode?: boolean | null
  nightcore?: boolean | null
  vaporwave?: boolean | null
  _8d?: boolean | null
  [filter: string]: unknown
}
export interface PlayerTrackUpdate {
  encoded?: string | null
  identifier?: string
  userData?: Record<string, unknown>
  audioTrackId?: string
}
/** PATCH fields pass through unchanged, including server extensions.
 * @example await player.updatePlayer({ paused: true, position: 15000 })
 */
export interface PlayerUpdate {
  voice?: VoiceInfo
  track?: PlayerTrackUpdate
  nextTrack?: PlayerTrackUpdate | null
  position?: number
  endTime?: number | null
  volume?: number
  paused?: boolean
  filters?: FilterOptions
  fading?: Record<string, unknown>
  crossfade?: Record<string, unknown>
  loudnessNormalizer?: boolean | Record<string, unknown>
  [field: string]: unknown
}
export interface UpdatePlayerOptions {
  guildId: string
  data: PlayerUpdate
  noReplace?: boolean
}
export interface PlayOptions {
  /** Start paused. Default: false. */
  paused?: boolean
  /** Initial position in milliseconds. */
  startTime?: number
  /** false replaces current; true preserves active playback. Omit to use queue behavior. */
  noReplace?: boolean
  /** Sent with the track and assigned to its local userData. */
  userData?: Record<string, unknown>
}
/** Server response from a player route. This is separate from the local Player instance. */
export interface RemotePlayer {
  guildId: string
  track: TrackAPI['track'] | null
  volume: number
  paused: boolean
  state: { time: number; position: number; connected: boolean; ping: number }
  voice: { [Field in keyof VoiceInfo]: VoiceInfo[Field] | null }
  filters: FilterOptions
  [field: string]: unknown
}
export interface SessionUpdate {
  resuming?: boolean
  /** Server session retention in seconds. */
  timeout?: number
}
export interface SessionInfo {
  resuming: boolean
  timeout: number
}
/** NodeLink needs an encoded track. Lavalink lyrics plugins use track.guild_id. */
export interface GetLyricsOptions {
  track: {
    encoded?: string | null
    track?: string | null
    info?: TrackInfo
    guild_id?: string
  }
  skipTrackSource?: boolean
  lang?: string
}
export interface LyricsResponse {
  source?: string
  text?: string
  lines?: Array<{
    text?: string
    line?: string
    timestamp?: number
    startTime?: number
    duration?: number
    [field: string]: unknown
  }>
  [field: string]: unknown
}
/** NodeLink mix input. Resolve identifiers first; addMixer requires encoded. */
export interface MixerOptions {
  identifier?: string
  encoded?: string
  userData?: Record<string, unknown>
  volume?: number
  requester?: unknown
}
export interface Mix {
  id?: string
  mixId?: string
  volume: number
  track?: TrackAPI['track']
  [field: string]: unknown
}
export interface SponsorBlockOptions {
  enabled?: boolean
  categories?: string[]
  actionTypes?: string[]
  skipMarginMs?: number
}
export interface SponsorBlockState extends Required<SponsorBlockOptions> {
  segments: Array<Record<string, unknown>>
  lastSkippedUuid: string | null
}
/** NodeLink stream input. Consume or cancel the Response body returned by loadStream. */
export interface StreamOptions {
  encodedTrack: string
  volume?: number
  position?: number
  filters?: FilterOptions
}
/** Compact v3 JSONL record written by savePlayer. Voice credentials aren't stored here. */
export interface SavedPlayerData {
  g: string
  t: string
  v: string
  u: string | SerializedTrack | null
  ud: Record<string, unknown> | null
  p: number
  ts: number
  q: Array<string | SerializedTrack>
  r: unknown
  vol: number
  pa: boolean
  pl: boolean
  nw: string | null
}
export interface AquaError extends Error {
  statusCode?: number
  statusMessage?: string
  body?: unknown
}
export interface RoutePlannerStatus {
  class:
    | 'RotatingIpRoutePlanner'
    | 'NanoIpRoutePlanner'
    | 'RotatingNanoIpRoutePlanner'
    | 'BalancingIpRoutePlanner'
    | null
  details: {
    ipBlock: { type: 'Inet4Address' | 'Inet6Address'; size: string }
    failingAddresses: Array<{
      failingAddress: string
      failingTimestamp: number
      failingTime: string
    }>
    rotateIndex?: string
    ipIndex?: string
    currentAddress?: string
    currentAddressIndex?: string
    blockIndex?: string
  } | null
}
export interface FilterPresetOptions {
  value?: number
  rate?: number
  pitch?: number
  rotationHz?: number
}
