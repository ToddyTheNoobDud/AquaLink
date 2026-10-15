// https://www.npmjs.com/package/undici-types, its already native (read desc if you want to)
import type { RequestInit } from 'undici-types'
import type AquaManager from '../aqua/Aqua.ts'
import type Node from '../nodes/Node.ts'
import { RoutesForRest } from '../shared/routes.ts'
import type {
  LavalinkInfo,
  NodelinkInfo
} from '../types/Rest/endpoints/info.ts'
import type { LoadResult, PlayerUpdate } from '../types/shared.ts'

/**
 * One REST instance per node, using its host, password and session.
 * Uses fetch and returns the parsed body.
 *
 * @example
 * ```ts
 * const info = await node.rest.getInfo()
 * if (info) console.log(info.version.semver)
 * ```
 */
export default class Rest {
  /** the Aqua manager instance */
  public aqua: AquaManager
  /** The single node this REST instance belongs to. */
  public nodes: Node

  /**
   * Stores the manager/node for later requests. Node creates this as node.rest.
   *
   * @param aqua - Manager used for logging.
   * @param nodes - Node supplying host, password and sessionId.
   * @example
   * ```ts
   * const rest = new Rest(aqua, node)
   * ```
   */
  constructor(aqua: AquaManager, nodes: Node) {
    this.aqua = aqua
    this.nodes = nodes
  }

  /**
   * Gets the node session from ready. The Discord voice session is a separate ID.
   *
   * @returns sessionId, or undefined before it arrives.
   * @example
   * ```ts
   * const sessionId = node.rest.getSessionId()
   * if (sessionId) console.log('REST player routes can use this session now')
   * ```
   */
  getSessionId() {
    if (this.nodes.sessionId) {
      return this.nodes.sessionId
    } else {
      return undefined // basic js stuff: undefined means a value should be here but its not, null would mean its actually meant to be null.
    }
  }

  /**
   * Sends an authenticated request. Reads text/plain as text, everything else as JSON.
   * HTTP, fetch and parsing failures return undefined instead of rejecting.
   *
   * @param url - Path starting with /, including query params. Full URLs aren't accepted.
   * @param method - Defaults to GET.
   * @param body - Optional JSON body; sets Content-Type too.
   * @returns Parsed body, null for 204, undefined on failure. JSON can also return null.
   * The result is unknown; narrow it before reading fields.
   * @example
   * ```ts
   * const result = await node.rest.makeRequest('/v4/info')
   * if (typeof result === 'object' && result !== null && 'version' in result) {
   *   console.log(result.version)
   * }
   * ```
   */
  public async makeRequest(
    url: string,
    method?: RequestInit['method'],
    body?: object
  ): Promise<unknown> {
    try {
      if (!url) {
        this.aqua.logger.error('You used makeRequest without a URL.')
        return undefined
      }

      const secureServer = this.nodes.ssl ? `https` : `http`
      const serverHost = `${secureServer}://${this.nodes.host}:${this.nodes.port}`

      const fetchUrl = serverHost + url
      const headers: Record<string, string> = {
        Authorization: this.nodes.password
      }
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json'
      }

      const response = await fetch(fetchUrl, {
        method: method ? method : 'GET',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      })

      // https://www.freecodecamp.org/news/when-to-use-asyncawait-vs-promises-in-javascript/#heading-practical-examples-promises-vs-asyncawait
      // i will use async/await code here because i find it more readable than using .then/.catch
      // and both also returns a Promise so we good.

      if (!response.ok) {
        return undefined
      }

      if (response.status === 204) {
        return null
      }

      if (response.headers.get('content-type')?.includes('text/plain')) {
        return await response.text()
      } else {
        return await response.json()
      }
    } catch (error) {
      this.aqua.logger.error(`Fetch just got a error: ${error}, in url: ${url}`)
      return undefined
    }
  }

  /**
   * Fetches the version text from /version.
   *
   * @returns makeRequest's result, still typed unknown. Check for a string before use.
   * @example
   * ```ts
   * const version = await node.rest.getVersion()
   * if (typeof version === 'string') console.log(version)
   * ```
   */
  async getVersion() {
    const res = await this.makeRequest(RoutesForRest.VersionRoute)
    return res
  }

  /**
   * Fetches /v4/info: server version, sources, filters and plugins.
   * The response is typed but isn't validated at runtime.
   *
   * @returns Lavalink/NodeLink info, or null/undefined from makeRequest.
   * @example
   * ```ts
   * const info = await node.rest.getInfo()
   * if (info) {
   *   console.log(info.sourceManagers)
   *   const isNodelink = 'isNodelink' in info && info.isNodelink === true
   *   console.log(isNodelink)
   * }
   * ```
   */
  async getInfo(): Promise<NodelinkInfo | LavalinkInfo | null | undefined> {
    const res = await this.makeRequest(RoutesForRest.InfoRoute)
    return res as NodelinkInfo | LavalinkInfo | null | undefined
  }

  /**
   * Fetches raw /v4/loadtracks data using source:query. It encodes query for you.
   * Returns the load result; Aqua.resolve wraps search tracks into Track instances.
   *
   * @param query - Search text, without URL encoding.
   * @param source - Prefix without :, for example ytsearch.
   * @returns LoadResult or null/undefined. Empty query/source returns undefined.
   * Only search data is fully typed so far.
   * @example
   * ```ts
   * const result = await node.rest.loadTracks('slayr eyesight', 'ytsearch')
   * if (result?.loadType === 'search') console.log(result.data[0]?.info.title)
   * ```
   */
  async loadTracks(
    query: string,
    source: string
  ): Promise<LoadResult | null | undefined> {
    if (!source || !query) {
      return undefined
    }
    const res = await this.makeRequest(
      `${RoutesForRest.LoadTracksRoute}?identifier=${source}:${encodeURIComponent(query)}`
    )
    return res as LoadResult | null | undefined
  }

  /**
   * PATCHes one guild's player with this node's sessionId and noReplace=true,
   * so a new track won't replace one already playing. Local Player state stays unchanged.
   *
   * @param guildId - Discord guild ID.
   * @param data - Voice credentials and/or encoded track.
   * @returns makeRequest's result. Missing guildId/sessionId returns undefined without a request.
   * @example
   * ```ts
   * const result = await node.rest.updatePlayers('123', {
   *   track: { encoded: track.encoded }
   * })
   * if (result === undefined) console.log('the player update failed')
   * ```
   */
  public async updatePlayers(guildId: string, data?: PlayerUpdate) {
    if (!guildId) {
      return undefined
    }

    const sessionId = this.getSessionId()

    if (sessionId === undefined) {
      return undefined
    }

    const url = `/v4/sessions/${sessionId}/players/${guildId}?noReplace=true`
    const res = await this.makeRequest(url, 'PATCH', data)
    return res
  }
}
