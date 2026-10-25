import type Node from '../nodes/Node.ts'
import type Player from '../player/Player.ts'
import type { NodeStats } from '../types/Rest/endpoints/stats.ts'
import type {
  FilterOptions,
  LavalinkException,
  RemotePlayer,
  TrackData
} from '../types/shared.ts'
import type Track from './Track.ts'

/** Raw server player event. Extra fields stay unknown until your handler narrows them.
 * Listen on player.on('event', ...) for all types, or player.on('TrackStartEvent', ...) for one.
 */
export interface PlayerEventPayload {
  op?: string
  type: string
  guildId: string
  track?: TrackData
  reason?: string
  exception?: LavalinkException
  thresholdMs?: number
  code?: number
  byRemote?: boolean
  player?: RemotePlayer
  volume?: number
  paused?: boolean
  position?: number
  filters?: FilterOptions
  state?: RemotePlayer['state']
  [field: string]: unknown
}
export const PlayerEventsWebsocket = Object.freeze({
  trackStart: 'TrackStartEvent',
  trackEnd: 'TrackEndEvent',
  trackError: 'TrackExceptionEvent',
  trackStuck: 'TrackStuckEvent',
  socketClosed: 'WebSocketClosedEvent',
  trackChange: 'TrackChangeEvent'
} as const)
export const WebsocketEvents = Object.freeze({
  ready: 'ready',
  stats: 'stats',
  playerUpdate: 'playerUpdate',
  event: 'event'
} as const)
/** Listener-name constants. A retained name doesn't enable its old v3 behavior.
 * Raw protocol event names are also emitted on Player.
 */
export const AqualinkEvents = Object.freeze({
  TrackStart: 'trackStart',
  TrackEnd: 'trackEnd',
  TrackError: 'trackError',
  TrackStuck: 'trackStuck',
  TrackChange: 'trackChange',
  SocketClosed: 'socketClosed',
  LyricsLine: 'lyricsLine',
  LyricsFound: 'lyricsFound',
  LyricsNotFound: 'lyricsNotFound',
  QueueEnd: 'queueEnd',
  PlayerUpdate: 'playerUpdate',
  PlayerMove: 'playerMove',
  PlayerReconnected: 'playerReconnected',
  AutoplayFailed: 'autoplayFailed',
  ReconnectionFailed: 'reconnectionFailed',
  NodeConnect: 'nodeConnect',
  NodeCreate: 'nodeCreate',
  NodeError: 'nodeError',
  NodeDisconnect: 'nodeDisconnect',
  NodeReconnect: 'nodeReconnect',
  NodeDestroy: 'nodeDestroy',
  NodeReady: 'nodeReady',
  NodeCustomOp: 'nodeCustomOp',
  NodeFailover: 'nodeFailover',
  NodeFailoverComplete: 'nodeFailoverComplete',
  PlayerCreate: 'playerCreate',
  PlayerDestroy: 'playerDestroy',
  PlayerDestroyed: 'playerDestroy',
  PlayersRebuilt: 'playersRebuilt',
  PlayerMigrated: 'playerMigrated',
  VolumeChanged: 'volumeChanged',
  FiltersChanged: 'filtersChanged',
  Seek: 'seek',
  PlayerCreated: 'playerCreated',
  PlayerConnected: 'playerConnected',
  PauseEvent: 'pauseEvent',
  PlayerReconnectingEvent: 'PlayerReconnectingEvent',
  PlayerReconnect: 'playerReconnect',
  MixStarted: 'mixStarted',
  MixEnded: 'mixEnded',
  Debug: 'debug',
  Error: 'error'
} as const)

/** Player listener arguments. Augment this interface from your bot for extra event names.
 * Track aliases receive Track wrappers; protocol-name listeners receive raw payloads.
 * @example player.on('trackEnd', (track, reason) => console.log(track?.title, reason))
 */
export interface PlayerEventMap {
  TrackStartEvent: [payload: PlayerEventPayload]
  TrackEndEvent: [payload: PlayerEventPayload]
  TrackExceptionEvent: [payload: PlayerEventPayload]
  TrackStuckEvent: [payload: PlayerEventPayload]
  WebSocketClosedEvent: [payload: PlayerEventPayload]
  TrackChangeEvent: [payload: PlayerEventPayload]
  event: [payload: PlayerEventPayload]
  trackStart: [track: Track | null]
  trackEnd: [track: Track | null, reason?: string]
  trackError: [track: Track | null, error: unknown]
  trackStuck: [track: Track | null, thresholdMs?: number]
  trackChange: [track: Track | null, payload: PlayerEventPayload]
  socketClosed: [payload: PlayerEventPayload]
  playerUpdate: [
    payload: {
      op?: string
      guildId?: string
      state?: RemotePlayer['state']
      [field: string]: unknown
    }
  ]
  playerMove: [oldChannel: string, newChannel: string]
  queueEnd: []
  autoplayFailed: [error: unknown]
  destroy: []
  lyricsLine: [track: Track | null, payload: unknown]
  lyricsFound: [track: Track | null, payload: unknown]
  lyricsNotFound: [track: Track | null, payload: unknown]
}
/** Aqua listener arguments. Track aliases include Player as the first argument.
 * Some v3 names remain for bot-owned extensions; automatic failover/migration isn't implemented.
 * playerMove is (oldChannel, newChannel), without a player argument.
 * @example aqua.on('trackStart', (player, track) => console.log(player.guildId, track?.title))
 */
export interface AquaEventMap {
  nodeReady: [
    node: Node,
    payload: { sessionId?: string; resumed?: boolean; [field: string]: unknown }
  ]
  nodeConnect: [node: Node]
  nodeConnected: [node: Node]
  nodeCreate: [node: Node]
  nodeDestroy: [node: Node]
  nodeDisconnect: [node: Node, close: { code: number; reason: string }]
  nodeError: [node: Node, error: unknown]
  nodeReconnect: [node: Node, info: { attempt: number; delay: number }]
  nodeEvent: [node: Node, payload: Record<string, unknown>]
  nodeCustomOp: [
    node: Node,
    op: string | undefined,
    payload: Record<string, unknown>
  ]
  nodeStats: [node: Node, stats: Partial<NodeStats>]
  nodeFailover: [node: Node]
  nodeFailoverComplete: [node: Node, successful: number, failed: number]
  playerCreate: [player: Player]
  playerDestroy: [player: Player]
  playerUpdate: [player: Player, payload: unknown]
  playerError: [player: Player, error: unknown]
  playerMove: [oldChannel: string, newChannel: string]
  playerMigrated: [oldPlayer: Player, newPlayer: Player, target: Node]
  playerReconnected: [player: Player, info: Record<string, unknown>]
  reconnectionFailed: [player: Player, info: Record<string, unknown>]
  trackStart: [player: Player, track: Track | null]
  trackEnd: [player: Player, track: Track | null, reason?: string]
  trackError: [player: Player, track: Track | null, error: unknown]
  trackStuck: [player: Player, track: Track | null, thresholdMs?: number]
  trackChange: [
    player: Player,
    track: Track | null,
    payload: PlayerEventPayload
  ]
  socketClosed: [player: Player, payload: PlayerEventPayload]
  queueEnd: [player: Player]
  autoplayFailed: [player: Player, error: unknown]
  lyricsLine: [player: Player, track: Track | null, payload: unknown]
  lyricsFound: [player: Player, track: Track | null, payload: unknown]
  lyricsNotFound: [player: Player, track: Track | null, payload: unknown]
}
export type AquaEvents = {
  [Name in keyof AquaEventMap]: (...args: AquaEventMap[Name]) => void
}
export type EventHandler<Value = unknown> = (
  ...args: Value[]
) => void | Promise<void>
