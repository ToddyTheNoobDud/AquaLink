/**
 * AquaLink's public classes and protocol types. Aqua is also the default export.
 * Await player creation, playback, controls, filter updates and destruction.
 * Replace classes through AquaOptions.structures before creating their instances.
 * Raw gateway data types use the Data suffix here; the v3 Update names wrap { t, d }.
 */
export {
  default,
  default as Aqua,
  default as AquaManager
} from './aqua/Aqua.ts'
export { default as Node } from './nodes/Node.ts'
export { default as Connection } from './player/Connection.ts'
export { default as Filters } from './player/Filters.ts'
export { default as Player, LOOP_MODES } from './player/Player.ts'
export { default as PlayerEvents } from './player/PlayerEvents.ts'
export { default as Queue } from './player/Queue.ts'
export { default as Rest } from './rest/Rest.ts'
export type {
  AquaEventMap,
  AquaEvents,
  EventHandler,
  PlayerEventMap,
  PlayerEventPayload
} from './shared/Events.ts'
export {
  AqualinkEvents,
  PlayerEventsWebsocket,
  WebsocketEvents
} from './shared/Events.ts'
export { default as Track } from './shared/Track.ts'
export type * from './types/Rest/endpoints/info.ts'
export type * from './types/Rest/endpoints/stats.ts'
export type * from './types/shared.ts'
export type {
  VoiceServerUpdate as VoiceServerData,
  VoiceStateUpdate as VoiceStateData
} from './types/shared.ts'
/** v3 gateway-envelope aliases; internal/raw data types use the Data suffix at the package root. */
export type VoiceStateUpdate = Extract<
  import('./types/shared.ts').VoicePacket,
  { t: 'VOICE_STATE_UPDATE' }
>
export type VoiceServerUpdate = Extract<
  import('./types/shared.ts').VoicePacket,
  { t: 'VOICE_SERVER_UPDATE' }
>
