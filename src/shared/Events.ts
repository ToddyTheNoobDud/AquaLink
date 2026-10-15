// https://lavalink.dev/api/index.html
// and
// https://nodelink.js.org/docs/differences#websocket-events
// same as the routes files, will follow one object for events that are in both NL and LL,
// and specific events for both.

/**
 * Reserved player event names. Empty for now, with no handlers or event forwarding.
 * @example
 * ```ts
 * console.log(Object.keys(PlayerEvents)) // [] for now
 * ```
 */
export const PlayerEvents = Object.freeze({})

/**
 * Reserved WebSocket event names. Empty for now, like PlayerEvents.
 * @example
 * ```ts
 * console.log(Object.keys(WebsocketEvents)) // [] for now
 * ```
 */
export const WebsocketEvents = Object.freeze({})
