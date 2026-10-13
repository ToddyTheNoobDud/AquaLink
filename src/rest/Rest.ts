/** Rest class which is one instance per node. */

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

export default class Rest {
  /** the Aqua manager instance */
  public aqua: AquaManager
  /** the connected nodes (probaly.) */
  public nodes: Node

  constructor(aqua: AquaManager, nodes: Node) {
    this.aqua = aqua
    this.nodes = nodes
  }

  /** Gets the Node instance sessionId, returns undefined if it does not have a value */
  getSessionId() {
    if (this.nodes.sessionId) {
      return this.nodes.sessionId
    } else {
      return undefined // basic js stuff: undefined means a value should be here but its not, null would mean its actually meant to be null.
    }
  }

  /**
   * Centralized requests for fetching the NL/LL endpoints, every request passes here.
   *
   * @param url obrigatory URL to fetch
   * @param method method in HTTP, defaults to GET
   * @returns Promise<Response>, the response of the fetched url.
   * undefined if the request failed, null for responses with status 204.
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

  async getVersion() {
    const res = await this.makeRequest(RoutesForRest.VersionRoute)
    return res
  }

  async getInfo(): Promise<NodelinkInfo | LavalinkInfo | null | undefined> {
    const res = await this.makeRequest(RoutesForRest.InfoRoute)
    return res as NodelinkInfo | LavalinkInfo | null | undefined
  }

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
