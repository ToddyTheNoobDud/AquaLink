/**
 * Shared v4 WebSocket route. Node adds the leading /.
 * Frozen to prevent changes at runtime.
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
 * Shared REST paths with a leading / for Rest.makeRequest.
 * Only /version skips the v4 prefix.
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
