import EventEmitter from 'node:events'
import type AquaManager from '../aqua/Aqua.ts'
import Rest from '../rest/Rest.ts'
import type { PlayerEventPayload } from '../shared/Events.ts'
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

/**
 * Fields read by the WebSocket handler. Extra fields stay unknown; JSON isn't validated.
 * @example A ready payload is { op: 'ready', sessionId: 'node-session' }.
 */
interface WebsocketPayload {
  /** Server operation, for example ready, stats or event. */
  op?: string
  /** Node session carried by ready. */
  sessionId?: string
  /** Guild related to a player update/event, when present. */
  guildId?: string
  /** Event name, for example TrackEndEvent. */
  type?: string
  /** Matches end events to the local current track. */
  track?: { encoded: string }
  /** CPU loads; absent in some NodeLink payloads. */
  cpu?: { nodelinkLoad?: number; lavalinkLoad?: number }
  /** Extra server/plugin fields with unknown shapes. */
  [field: string]: unknown
}

/**
 * A Lavalink/NodeLink server with its WebSocket, REST and retries.
 * Aqua creates/registers it. Guild events reach PlayerEvents; unknown ops are logged only.
 *
 * @example
 * ```ts
 * const node = aqua.getNode()
 * if (node) console.log(node.name, node.isNodelink)
 * ```
 */
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
  /** Whether this server uses TLS. */
  public ssl: boolean
  /** the configured port */
  public port: number
  /** the configured password */
  public password: string
  /** Node session from ready, initially null. Separate from the Discord voice session. */
  public sessionId: string | null
  /** Local connection flag. Player REST routes also need sessionId. */
  public connected: boolean
  /** the rest instance */
  public rest: Rest
  /** Latest server stats without op. Starts as {}. */
  public stats: StatsNodelink | StatsLavalink | object
  /** Detected via /v4/info; initially false, before the server type is known. */
  public isNodelink: boolean
  /** current websocket in the Node. */
  public websocket: WebSocket | null = null

  /**
   * Stores config and creates REST. connect opens the socket.
   * Reads retry settings from aqua.options.nodeConfigs.
   *
   * @param aqua - Manager supplying the logger and bot ID.
   * @param nodeOptions - Server address, password, name and TLS flag.
   * @param _options - Unused; configure retries on Aqua.
   * @example
   * ```ts
   * const node = new Node(aqua, nodeOptions)
   * ```
   */
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
   * Starts the socket using this node's password and Aqua's clientId, set by init.
   * Sends a stored Session-Id if present; the server decides whether resuming works.
   * Doesn't wait for open/ready.
   *
   * @returns New WebSocket, or undefined with a log if already connected.
   * @throws On socket construction errors. Async socket errors happen later.
   * @example
   * ```ts
   * await node.connect() // starts connecting; this isn't a readiness promise
   * ```
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
      this.handleWebsocketMessages(message as MessageEvent<string>).catch(
        (error: unknown) => {
          this.aqua.logger.error(
            { err: error },
            'Failed to handle a node message.'
          )
        }
      )
    })

    websocket.addEventListener('open', (open) => {
      this.handleWebsocketOpen(open)
    })

    websocket.addEventListener('close', (close) => {
      this.handleWebsocketClose(close, websocket)
    })

    this.websocket = websocket
    return websocket
  }

  /**
   * Reads ready/session and stats; forwards guild events to their assigned Player.
   * playerUpdate and unknown ops are logged only.
   * @throws On invalid JSON or a throwing handler/listener; the socket callback logs it.
   * @example Incoming { op: 'ready', sessionId: 'node-session' } stores the session ID.
   */
  private async handleWebsocketMessages(message: MessageEvent<string>) {
    const parsed = JSON.parse(message.data) as WebsocketPayload

    switch (parsed.op) {
      case 'ready': {
        this.aqua.logger.info(`Node is ready: ${this.name}`)
        this.sessionId = parsed.sessionId ?? null
        this.connected = this.sessionId !== null

        break
      }
      case 'stats':
        this.aqua.logger.debug('got an stats')

        if ('op' in parsed) {
          delete parsed.op
        }

        if (parsed.cpu && 'nodelinkLoad' in parsed.cpu) {
          delete parsed.cpu.lavalinkLoad
        }

        this.stats = parsed

        break
      case 'playerUpdate':
        this.aqua.logger.info('i got a playerUpdate')
        break
      case 'event':
      case 'events': {
        const emitted = this.emitEventToPlayer(parsed)

        if (emitted === null) {
          return this.aqua.logger.info(
            `event not emitted because of a error. event: ${parsed.type}`
          )
        }

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
      }
      default:
        // we let pino build the parsed stuff, because JS do the work before logging.
        this.aqua.logger.debug(
          { node: this.name, op: parsed.op, payload: parsed },
          `Unknown message/event/op recived, you can extend this so you can use it if you want to.`
        )
    }
  }

  private emitEventToPlayer(payload: WebsocketPayload) {
    if (
      typeof payload.type !== 'string' ||
      typeof payload.guildId !== 'string'
    ) {
      this.aqua.logger.error('A player event needs a string type and guildId.')
      return null
    }
    const player = this.aqua.get(payload.guildId)
    if (!player) {
      this.aqua.logger.error('no player found to emit any event sadly.')
      return null
    }

    if (player.node !== this) {
      return null
    }

    player.handleEvents(payload as PlayerEventPayload)
  }

  /**
   * Fetches info to detect NodeLink, resets retries and marks connected.
   * Checks the socket before/after fetching so late results can't revive an old socket.
   * @example A WebSocket open event calls this; a delayed response from an old socket is ignored.
   */
  private async handleWebsocketOpen(open: Event): Promise<void> {
    const socket = open.currentTarget as WebSocket | null
    if (
      socket?.readyState !== WEBSOCKET_STATES.Established ||
      socket !== this.websocket
    ) {
      return
    }

    try {
      const info = await this.rest.getInfo()

      // we check again, because an late info response can come even after a socket was closed
      if (
        socket.readyState !== WEBSOCKET_STATES.Established ||
        socket !== this.websocket
      ) {
        return
      }
      if (info) {
        this.isNodelink = 'isNodelink' in info && info.isNodelink === true
      }

      this.reconnectRetries = 0

      this.connected = true

      this.aqua.logger.info(
        `Aqualink has connected to the node: ${this.name}, isNodelink: ${this.isNodelink}`
      )
    } catch (error) {
      if (this.websocket === socket) {
        this.connected = false
        this.reconnectRetries = 0
      }
      this.aqua.logger.error(
        `there was an error during info fetching (node connect): ${error}`
      )
    }
  }

  /**
   * Marks disconnected, logs the close and schedules backoff.
   * Keeps sessionId for the next connection's Session-Id header.
   * @example Closing a socket triggers this automatically; users don't call it directly.
   */
  private handleWebsocketClose(close: CloseEvent, websocket: WebSocket) {
    this.connected = false

    // bigger than 0 means an reconnection is happening
    if (this.reconnectRetries > 0) {
      this.aqua.logger.info('Reconnection in progress')
    }

    if (close.code === 1006 && this.reconnectRetries === 0) {
      this.aqua.logger.info(
        '1006 close clode, probaly the node got force-killed.'
      )
    }

    this.manageBackoff(websocket)
  }

  /**
   * Retries a closed socket when settings allow it. Starts at 5s, grows with
   * the retry count and caps at 420s. Successful open/info handling resets the count.
   * maxRetries=0 disables finite retries; infiniteReconnects ignores the limit.
   * @example With maxRetries=3 and no successful reconnect, delays are 5s, 5s, 12.5s.
   */
  private manageBackoff(websocket: WebSocket) {
    if (
      websocket.readyState === WEBSOCKET_STATES.Established ||
      this.connected
    ) {
      return this.aqua.logger.info(
        'WEBSOCKET is already connected, why a backoff would happen?'
      )
    }

    let time = BASE_BACKOFF

    const backoff = () => {
      if (this.reconnectRetries >= 2) {
        time = Math.min(
          BASE_BACKOFF * (this.reconnectRetries + 0.5),
          MAX_BACKOFF
        )
      }
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
