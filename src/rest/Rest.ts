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
 * One REST instance per node, using that node's host, password and session.
 * Requests use fetch; results are parsed bodies, not fetch Response objects.
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
  /** The single node this REST instance belongs to, despite the plural name. */
  public nodes: Node

  /**
   * Stores the manager and node; it doesn't make requests yet.
   * Node already creates one for you as node.rest.
   *
   * @param aqua - The manager used for logging.
   * @param nodes - The node supplying host, authentication and sessionId.
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
   * Gets the Lavalink/NodeLink session from the WebSocket ready payload.
   * This is NOT the Discord voice session used in a voice update.
   *
   * @returns The node's sessionId, or undefined if it hasn't received one yet.
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
   * Every NL/LL REST request goes through here, with the node's password.
   * text/plain is read as text; everything else is parsed as JSON.
   * An HTTP error or a caught fetch/parse error returns undefined instead of rejecting.
   *
   * @param url - Required path starting with /, not a full URL; include query params here.
   * @param method - HTTP method, defaults to GET.
   * @param body - Optional object; serialized to JSON with Content-Type set for you.
   * @returns The parsed response body. null for HTTP 204; undefined on failure.
   * JSON itself can also contain null, so null isn't exclusive to 204.
   * The generic result is unknown; narrow it before reading fields.
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
   * Fetches /version, which normally returns plain version text.
   *
   * @returns The parsed body, or the null/undefined result from makeRequest.
   * Its current TypeScript return is unknown, so check for a string first.
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
   * Fetches /v4/info with the server's version, sources, filters and plugins.
   * The type assertion doesn't validate the remote JSON at runtime.
   *
   * @returns Lavalink or NodeLink info, or null/undefined from makeRequest.
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
   * Fetches raw /v4/loadtracks data using source:query as the identifier.
   * The query is URL-encoded here; don't encode it again before passing it.
   * This returns the server's load result, not an array of Track instances.
   *
   * @param query - Search text sent to the node.
   * @param source - Prefix without :, for example ytsearch.
   * @returns A LoadResult, or null/undefined; empty query/source returns undefined.
   * Only the search branch has a detailed data type for now.
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
   * PATCHes one guild's player using this node's current sessionId.
   * The name is plural, but this isn't a batch update.
   * noReplace=true is always sent, so a new track won't replace one already playing.
   * A successful response is the remote body; this doesn't update local Player state.
   *
   * @param guildId - The Discord server owning the remote player.
   * @param data - Voice credentials and/or encoded track; the supported fields so far.
   * @returns The parsed body, or null/undefined from makeRequest.
   * Missing guildId/sessionId returns undefined without making a request.
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
