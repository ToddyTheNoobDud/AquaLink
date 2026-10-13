import EventEmitter from 'node:events'
import type AquaManager from '../aqua/Aqua.ts'
import Rest from '../rest/Rest.ts'
import { RoutesForWebsocket } from '../shared/routes.ts'
import type {
  StatsLavalink,
  StatsNodelink
} from '../types/Rest/endpoints/stats.ts'
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

// 5 seconds
const BASE_BACKOFF = 5000
// 7 minutes, 420 seconds
const MAX_BACKOFF = 420000

export default class Node extends EventEmitter {
  private infiniteReconnects: boolean
  private maxRetries: number
  private reconnectRetries: number

  /** Aqualink's internal client name (CLIENT/VERSION format) */
  private clientName: string
  /** current aqua instance running */
  public aqua: AquaManager
  /** name of the configured node */
  public name: string
  /** host of the configured node */
  public host: string
  /** checks if the configured host is a secure connection or not */
  public ssl: boolean
  /** the configured port */
  public port: number
  /** the configured password */
  public password: string
  /** the returned sessionId from the ready payload */
  public sessionId: string | null
  /** checks if the current selected node is connected */
  public connected: boolean
  /** the rest instance */
  public rest: Rest
  /** stats object (only proprieties) */
  public stats: StatsNodelink | StatsLavalink | object
  /** check if the current node is running an nodelink connection */
  public isNodelink: boolean
  /** current websocket in the Node. */
  public websocket: WebSocket | null = null

  constructor(
    aqua: AquaManager,
    nodeOptions: NodeOptions,
    _options?: AquaOptions
  ) {
    super()

    this.aqua = aqua
    this.host = nodeOptions.host
    this.ssl = nodeOptions.ssl //?? this.secure = nodeOptions.secure
    this.port = nodeOptions.port
    this.password = nodeOptions.password
    this.name = nodeOptions.name

    this.infiniteReconnects =
      this.aqua.options?.nodeConfigs.infiniteReconnects === true
    this.maxRetries = this.aqua.options?.nodeConfigs.maxRetries ?? 10

    this.reconnectRetries = 0

    this.sessionId = null

    this.rest = new Rest(this.aqua, this)

    this.connected = false

    this.isNodelink = false

    this.clientName =
      'Aqualink/4.0.0 (https://github.com/ToddyTheNoobDud/AquaLink'

    this.websocket = null

    this.stats = {}
  }

  /**
   * connects to a given node
   *
   */
  public async connect() {
    if (this.connected) {
      return this.aqua.logger.error('this node is already connected')
    }

    const protocol = this.ssl ? 'wss' : 'ws'
    const websocketUrl = `${protocol}://${this.host}:${this.port}/${RoutesForWebsocket.WebsocketV4Route}`

    const hasSessionId = this.sessionId !== null

    const headers: Record<string, string> = {
      Authorization: `${this.password}`,
      'User-Id': `${this.aqua.clientId}`,
      'Client-Name': this.clientName
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

    websocket.addEventListener('close', (close) => {
      this.handleWebsocketClose(close, websocket)
    })

    this.websocket = websocket
    return websocket
  }

  private async handleWebsocketMessages(message: MessageEvent) {
    const parsed = JSON.parse(message.data)

    switch (parsed.op) {
      case 'ready': {
        this.aqua.logger.info(`Node is ready: ${this.name}`)
        this.sessionId = parsed.sessionId

        break
      }
      case 'stats':
        this.aqua.logger.debug('got an stats')

        if ('op' in parsed) delete parsed.op

        if ('nodelinkLoad' in parsed.cpu) {
          delete parsed.cpu.lavalinkLoad
        }

        this.stats = parsed

        break
      case 'events':
        // we let pino build the parsed stuff, because JS do the work before logging.
        this.aqua.logger.debug(
          {
            node: this.name,
            type: parsed.type,
            guildId: parsed.guildId,
            payload: parsed
          },
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

  private async handleWebsocketOpen(open: Event): Promise<void> {
    const socket = open.currentTarget as WebSocket | null
    if (
      socket?.readyState !== WEBSOCKET_STATES.Established ||
      open.currentTarget !== this.websocket
    ) {
      return
    }

    try {
      const info = await this.rest.getInfo()

      // we check again, because an late info response can come even after a socket was closed.
      if (
        socket?.readyState !== WEBSOCKET_STATES.Established ||
        open.currentTarget !== this.websocket
      ) {
        return
      }
      if (info)
        this.isNodelink = 'isNodelink' in info && info.isNodelink === true

      this.reconnectRetries = 0

      this.connected = true

      this.aqua.logger.info(
        `Aqualink has connected to the node: ${this.name}, isNodelink: ${this.isNodelink}`
      )
    } catch (error) {
      if (this.websocket === open.currentTarget) {
        this.connected = false
        this.reconnectRetries = 0
      }
      this.aqua.logger.error(
        `there was an error during info fetching (node connect): ${error}`
      )
    }
  }

  private handleWebsocketClose(close: CloseEvent, websocket: WebSocket) {
    this.connected = false

    // bigger than 0 means an reconnection is happening
    if (this.reconnectRetries > 0)
      this.aqua.logger.info('Reconnection in progress')

    if (close.code === 1006 && this.reconnectRetries === 0)
      this.aqua.logger.info(
        '1006 close clode, probaly the node got force-killed.'
      )

    this.manageBackoff(websocket)
  }

  private manageBackoff(websocket: WebSocket) {
    if (websocket.readyState === WEBSOCKET_STATES.Established || this.connected)
      return this.aqua.logger.info(
        'WEBSOCKET is already connected, why a backoff would happen?'
      )

    let time = BASE_BACKOFF

    const backoff = () => {
      if (this.reconnectRetries >= 2)
        time = Math.min(
          BASE_BACKOFF * (this.reconnectRetries + 0.5),
          MAX_BACKOFF
        )
      setTimeout(async () => {
        this.reconnectRetries++

        await this.connect()
      }, time)
    }

    if (this.maxRetries && !this.infiniteReconnects) {
      if (this.reconnectRetries < this.maxRetries) {
        backoff()
      } else if (this.reconnectRetries >= this.maxRetries) {
        this.aqua.logger.info(
          'Max retries reached, in the future, the node will be deleted/destroyed when this happens.'
        )
      }
    }

    if (this.infiniteReconnects) {
      backoff()
    }
  }
}
