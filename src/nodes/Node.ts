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

/**
 * Fields the current WebSocket handler reads. Extra plugin fields stay unknown.
 * This is a draft view of a parsed payload, not validation of incoming JSON.
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
  /** Encoded track used to match an end event to the local current track. */
  track?: { encoded: string }
  /** Stats loads read by the handler; some NodeLink payloads don't include cpu. */
  cpu?: { nodelinkLoad?: number; lavalinkLoad?: number }
  /** Other server/plugin fields, without assuming their shape yet. */
  [field: string]: unknown
}

/**
 * One Lavalink/NodeLink server: WebSocket messages, REST and reconnect attempts.
 * Aqua normally creates/registers it. Custom ops/events are still logged only;
 * public forwarding hooks aren't implemented yet.
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
  /** checks if the configured host is a secure connection or not */
  public ssl: boolean
  /** the configured port */
  public port: number
  /** the configured password */
  public password: string
  /** Node session from ready; null before one arrives. Not a Discord voice session. */
  public sessionId: string | null
  /** Local connection flag; also check sessionId before using player REST routes. */
  public connected: boolean
  /** the rest instance */
  public rest: Rest
  /** Latest stats without op; starts as {} and depends on what the server sends. */
  public stats: StatsNodelink | StatsLavalink | object
  /** Detected from /v4/info; false initially, so false alone isn't proof of Lavalink. */
  public isNodelink: boolean
  /** current websocket in the Node. */
  public websocket: WebSocket | null = null

  /**
   * Stores the server config and creates its REST instance, without opening a socket.
   * Reconnect settings come from aqua.options.nodeConfigs, not the _options argument.
   *
   * @param aqua - The owning manager, supplying logging and the bot's user ID.
   * @param nodeOptions - Host, port, password, name and whether to use TLS.
   * @param _options - Unused draft argument; configure retries on Aqua instead.
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
   * Starts the WebSocket with this node's password and Aqua's bot user ID.
   * Aqua should already have its clientId set, normally by init.
   * Sends Session-Id if there's a stored session; the server decides if it can resume.
   * This method returns after creating the socket, before open/ready messages arrive.
   *
   * @returns The new WebSocket, or undefined after logging that we're already connected.
   * @throws If constructing the WebSocket fails; asynchronous socket errors happen later.
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
      this.handleWebsocketMessages(message as MessageEvent<string>)
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
   * Parses a server message: ready stores the session, stats replaces the snapshot,
   * and a matching TrackEnd clears local playback. playerUpdate is only logged so far.
   * Unknown ops/events are logged rather than forwarded to public listeners.
   * @throws If message.data isn't valid JSON; payload fields aren't schema-validated.
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
        const player = this.aqua.get(parsed.guildId ?? '')
        if (
          player?.node === this &&
          player.current?.encoded === parsed.track?.encoded &&
          parsed.type === 'TrackEndEvent'
        ) {
          player.playing = false
          player.current = null
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

  /**
   * Fetches info to detect NodeLink, then resets retries and marks the socket connected.
   * Checks socket identity/state around the request so a late result can't revive it.
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
   * Marks the node disconnected, logs the close and schedules retries through backoff.
   * The stored sessionId is kept for the next connection's Session-Id header.
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
   * Schedules a retry if the socket is closed and retry settings allow it.
   * Starts at 5 seconds, then grows with the retry count up to 420 seconds.
   * maxRetries=0 disables finite retries; infiniteReconnects ignores that limit.
   * Successful open/info handling resets the retry count.
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
