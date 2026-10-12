/** Rest class which is one instance per node. */

// https://www.npmjs.com/package/undici-types, its already native (read desc if you want to)
import type { RequestInit, Response } from 'undici-types'
import type AquaManager from '../aqua/Aqua.ts'
import type Node from '../nodes/Node.ts'
import { RoutesForRest } from '../shared/routes.ts'

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
    if (this.nodes.sessionId) return this.nodes.sessionId
    else return undefined // basic js stuff: undefined means a value should be here but its not, null would mean its actually meant to be null.
  }

  /**
   * Centralized requests for fetching the NL/LL endpoints, every request passes here.
   *
   * @param url obrigatory URL to fetch
   * @param method method in HTTP, defaults to GET
   * @returns Promise<Response>, the response of the fetched url.
   * null if the request failed, undefined for requests which returns 204.
   */
  public async makeRequest(
    url: string,
    method?: RequestInit
  ): Promise<Response | null | undefined> {
    if (!url) {
      this.aqua.logger.error('You used makeRequest without a URL.')
      return null
    }

    const secureServer = this.nodes.ssl ? `https` : `http`
    const serverHost = `${secureServer}://${this.nodes.host}:${this.nodes.port}`

    const fetchUrl = serverHost + url

    await fetch(fetchUrl, {
      method: method ? 'GET' : method,
      headers: {
        Authorization: `${this.nodes.password}`
      }
    })
      .then(async (response) => {
        if (!response.ok) {
          this.aqua.logger.error(
            `Fetch request failed, with status code: ${response.status}`
          )
          return null
        }

        if (response.status === 204) return undefined

      }).then(data => console.log(data))
      .catch((error: Error) => {
        this.aqua.logger.error(
          `Fetch got a error, cause: ${error.cause}, with the msg: ${error.message}, stack: ${error.stack}, fetch url: ${url}`
        )
        return null
      })
  }

  async getVersion() {
    const res = await this.makeRequest(RoutesForRest.VersionRoute)
    return res
  }
}
