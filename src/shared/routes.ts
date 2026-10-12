/** Nodelink/Lavalink Routes that will not change no matter what. */
export const RoutesForWebsocket = Object.freeze({
  WebsocketV4Route: 'v4/websocket'
})

export const RoutesForRest = Object.freeze({
  VersionRoute: '/version'
})

/* 

specific routes for both lavalink and nodelink, since lavalink will have plugin endpoints
and nodelink will have its own endpoints too.

export const RoutesForRestLavalink = Object.freeze({})

export const RoutesForRestNodelink = Object.freeze({}) 
 */
