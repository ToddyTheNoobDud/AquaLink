// https://lavalink.dev/api/index.html
// and
// https://nodelink.js.org/docs/differences#websocket-events
// same as the routes files, will follow one object for events that are in both NL and LL,
// and specific events for both.

/** Player event fields used for routing. Custom fields keep their original values. */
export type PlayerEventPayload = {
  type: string
  guildId: string
  [field: string]: unknown
}

/**
 * Known player event names. This object doesn't register handlers or rename emissions.
 * @example
 * ```ts
 * console.log(PlayerEventsWebsocket.trackStart) // 'TrackStartEvent'
 * ```
 */
export const PlayerEventsWebsocket = Object.freeze({
  trackStart: 'TrackStartEvent'
})

/**
 * Reserved WebSocket event names. Empty for now.
 * @example
 * ```ts
 * console.log(Object.keys(WebsocketEvents)) // [] for now
 * ```
 */
export const WebsocketEvents = Object.freeze({})
