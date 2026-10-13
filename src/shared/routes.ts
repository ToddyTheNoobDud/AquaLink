/**
 * Shared v4 WebSocket route, without a leading / because Node adds it.
 * Frozen so code can't accidentally change it at runtime.
 * @example
 * ```ts
 * const url = `ws://127.0.0.1:2333/${RoutesForWebsocket.WebsocketV4Route}`
 * console.log(url)
 * ```
 */
export const RoutesForWebsocket = Object.freeze({
  WebsocketV4Route: 'v4/websocket'
})

/**
 * Shared REST paths. These have a leading / for Rest.makeRequest.
 * /version has no v4 prefix; the other routes here do.
 * @example
 * ```ts
 * const info = await node.rest.makeRequest(RoutesForRest.InfoRoute)
 * console.log(info)
 * ```
 */
export const RoutesForRest = Object.freeze({
  VersionRoute: '/version',
  InfoRoute: '/v4/info',
  LoadTracksRoute: '/v4/loadtracks'
})

/* 

specific routes for both lavalink and nodelink, since lavalink will have plugin endpoints
and nodelink will have its own endpoints too.

export const RoutesForRestLavalink = Object.freeze({})

export const RoutesForRestNodelink = Object.freeze({}) 
 */
