import EventEmitter from 'node:events'
import { WebSocket } from 'node:http'
import type AquaManager from '../aqua/Aqua.ts'
import Rest from '../rest/Rest.ts'
import { RoutesForWebsocket } from '../shared/routes.ts'
import type { AquaOptions, NodeOptions } from '../types/shared.ts'

// https://bun.sh/reference/bun/Socket/readyState
// ig nodejs also follow that lol?
// https://dev.to/ivanzm123/dont-use-enums-in-typescript-they-are-very-dangerous-57bh
// this was a enum before.
const WEBSOCKET_STATES = {
  Shutdown: -2,
  Detached: -1,
  Closed: 0,
  Established: 1,
  Else: 2
}

export default class Node extends EventEmitter {
  public aqua: AquaManager
  public name: string
  public host: string
  public ssl: boolean
  public port: number
  public password: string
  public sessionId: string | null

  // node related stuff
  public connected: boolean

  public rest: Rest

  constructor(
    aqua: AquaManager,
    nodeOptions: NodeOptions,
    options?: AquaOptions
  ) {
    super()
    this.aqua = aqua
    this.host = nodeOptions.host
    this.ssl = nodeOptions.ssl //?? this.secure = nodeOptions.secure
    this.port = nodeOptions.port
    this.password = nodeOptions.password
    this.name = nodeOptions.name

    this.sessionId = null

    this.rest = new Rest(this.aqua, this)

    this.connected = false
  }

  clientName() {
    return 'Aqualink/4.0.0 (https://github.com/ToddyTheNoobDud/AquaLink'
  }

  /**
   * connects to a given node
   *
   */
  public async connect() {
    if (this.connected) {
      return
    }

    const protocol = this.ssl ? 'wss' : 'ws'
    const websocketUrl = `${protocol}://${this.host}:${this.port}/${RoutesForWebsocket.WebsocketV4Route}`

    const hasSessionId = this.sessionId !== null

    const headers: Record<string, string> = {
      Authorization: `${this.password}`,
      'User-Id': `${this.aqua.clientId}`,
      'Client-Name': this.clientName()
    }

    if (hasSessionId) {
      headers['Session-Id'] = this.sessionId as string
    }

    const websocket = new WebSocket(websocketUrl, {
      headers
    })

    websocket.addEventListener('message', (message) => {
      this.handleWebsocketMessages(message as MessageEvent)
    })

    websocket.addEventListener(
      'open',
      (open) => {
        this.handleWebsocketOpen(open)
      },
      true
    )

    return websocket
  }

  private async handleWebsocketMessages(message: MessageEvent) {
    const parsed = JSON.parse(message.data)

    switch (parsed.op) {
      case 'ready': {
        this.aqua.logger.info(`Node is ready: ${this.name}`)
        this.connected = true
        this.sessionId = parsed.sessionId

        const ver = await this.rest.getVersion()
        console.log(ver)
        break
      }
      case 'stats':
        this.aqua.logger.debug('recived stats')
        break
      case 'events':
                // we let pino build the parsed stuff, because JS do the work before logging.
        this.aqua.logger.debug(
          { node: this.name, type: parsed.type, guildId: parsed.guildId, payload: parsed},
          `recived an event.`
        )
        break
      default:
        // we let pino build the parsed stuff, because JS do the work before logging.
        this.aqua.logger.debug(
          { node: this.name, op: parsed.op, payload: parsed },
          `Unknown message/event/op recived, you can extend this so you can use it if you want to.`
        )
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: The code itself returns any. i think.
  private async handleWebsocketOpen(open: any) {
    if (open.currentTarget.readyState === WEBSOCKET_STATES.Established)
      this.aqua.logger.info(`Aqualink has connected to the node: ${this.name}`)
  }
}
