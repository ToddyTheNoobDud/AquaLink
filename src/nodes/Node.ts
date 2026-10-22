import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import type Aqua from '../aqua/Aqua.ts'
import type Player from '../player/Player.ts'
import Rest from '../rest/Rest.ts'
import type { PlayerEventPayload } from '../shared/Events.ts'
import type {
  LavalinkInfo,
  NodelinkInfo
} from '../types/Rest/endpoints/info.ts'
import type { NodeStats } from '../types/Rest/endpoints/stats.ts'
import type {
  NodeAdditionalOptions,
  NodeOptions,
  RemotePlayer,
  TrackData
} from '../types/shared.ts'

interface WebsocketPayload {
  op?: string
  type?: string
  guildId?: string
  sessionId?: string
  resumed?: boolean
  state?: RemotePlayer['state']
  track?: TrackData
  cpu?: { nodelinkLoad?: number; lavalinkLoad?: number }
  [field: string]: unknown
}

/** One server connection. The ready message makes its session usable.
 * Unknown ops go to nodeCustomOp; protocol events also go to nodeEvent on Aqua.
 * @example aqua.on('nodeReady', node => console.log(node.name, node.sessionId))
 */
export default class Node extends EventEmitter {
  public name: string
  public host: string
  public port: number
  public ssl: boolean
  public password: string
  public sessionId: string | null
  public connected = false
  public isNodelink = false
  public isDestroyed = false
  /** Populated by /v4/info independently of the ready message. May still be null on nodeReady. */
  public info: LavalinkInfo | NodelinkInfo | null = null
  public websocket: WebSocket | null = null
  public rest: Rest
  public stats: Partial<NodeStats> = {}
  public players = new Set<Player>()
  public reconnectRetries = 0
  public reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null
  public infiniteReconnects: boolean
  public maxRetries: number
  public resumeTimeout: number
  public autoResume: boolean
  public reconnectTimeout: number
  public nodeState = 'DISCONNECTED'

  constructor(
    public aqua: Aqua,
    public options: NodeOptions,
    additional: NodeAdditionalOptions = {}
  ) {
    super()
    this.host = options.host
    this.name = options.name ?? options.host
    this.port = Number(options.port ?? 2333)
    this.ssl = options.ssl ?? false
    this.password = options.password ?? options.auth ?? ''
    if (
      !this.host ||
      !this.password ||
      !Number.isInteger(this.port) ||
      this.port < 1 ||
      this.port > 65535
    ) {
      throw new TypeError('Node needs a host, password/auth and a valid port.')
    }
    this.sessionId = options.sessionId ?? null
    this.infiniteReconnects =
      additional.infiniteReconnects ??
      aqua.options?.nodeConfigs?.infiniteReconnects ??
      aqua.options?.infiniteReconnects ??
      false
    this.maxRetries =
      additional.reconnectTries ?? aqua.options?.nodeConfigs?.maxRetries ?? 10
    this.reconnectTimeout = additional.reconnectTimeout ?? 5000
    this.resumeTimeout =
      additional.resumeTimeout ?? aqua.options?.resumeTimeout ?? 60
    this.autoResume = additional.autoResume ?? aqua.options?.autoResume ?? false
    const RestClass = aqua.options?.structures?.Rest ?? Rest
    this.rest = new RestClass(aqua, this)
    this.rest.timeout = additional.timeout ?? this.rest.timeout
  }

  get wsUrl() {
    return `${this.ssl ? 'wss' : 'ws'}://${this.host}:${this.port}/v4/websocket`
  }

  get isUsable() {
    return this.connected && this.sessionId !== null && !this.isDestroyed
  }

  /** Open an authenticated ws socket, or return the current connecting/open socket.
   * Resolves before the handshake/ready message. Use Aqua's nodeReady event for availability.
   * @example await node.connect()
   */
  async connect() {
    if (this.isDestroyed) {
      throw new Error('Node is destroyed.')
    }
    if (this.websocket && this.websocket.readyState < 2) {
      return this.websocket
    }
    if (!this.aqua.clientId) {
      throw new Error('Call aqua.init(clientId) first.')
    }
    if (this.reconnectTimeoutId !== null) {
      clearTimeout(this.reconnectTimeoutId)
      this.reconnectTimeoutId = null
    }
    const headers: Record<string, string> = {
      Authorization: this.password,
      'User-Id': this.aqua.clientId,
      'Client-Name':
        'Aqualink/4.0.0 (https://github.com/ToddyTheNoobDud/AquaLink)'
    }
    if (this.sessionId) {
      headers['Session-Id'] = this.sessionId
    }
    const socket = new WebSocket(this.wsUrl, { headers })
    this.websocket = socket
    this.nodeState = 'CONNECTING'
    socket.on('message', (data) => {
      if (socket !== this.websocket || this.isDestroyed) {
        return
      }
      this.handleWebsocketMessages({ data: data.toString() }).catch((error) =>
        this.reportError(error)
      )
    })
    socket.on('open', () => {
      this.handleWebsocketOpen({ currentTarget: socket }).catch((error) =>
        this.reportError(error)
      )
    })
    socket.on('close', (code, reason) => {
      this.handleWebsocketClose({ code, reason: reason.toString() }, socket)
    })
    socket.on('error', (error) => {
      if (socket === this.websocket && !this.isDestroyed) {
        this.reportError(error)
      }
    })
    return socket
  }

  /** Parse one text frame and route it to state handling, Player or public extension events.
   * Override from a Node subclass to handle extra ops; call super for the built-in ones.
   */
  public async handleWebsocketMessages(message: { data: string }) {
    if (this.isDestroyed) {
      return
    }
    let parsed: WebsocketPayload
    try {
      const data: unknown = JSON.parse(message.data)
      if (
        !data ||
        typeof data !== 'object' ||
        !('op' in data) ||
        typeof data.op !== 'string'
      ) {
        throw new TypeError('Node message needs a string op.')
      }
      parsed = data as WebsocketPayload
    } catch (error) {
      this.reportError(error)
      return
    }
    switch (parsed.op) {
      case 'ready': {
        if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) {
          this.reportError(new TypeError('ready needs a sessionId.'))
          return
        }
        const oldSession = this.sessionId
        this.sessionId = parsed.sessionId
        this.connected = true
        this.nodeState = 'CONNECTED'
        this.reconnectRetries = 0
        if (this.reconnectTimeoutId !== null) {
          clearTimeout(this.reconnectTimeoutId)
          this.reconnectTimeoutId = null
        }
        if (this.autoResume) {
          const session = await this.rest.updateSession({
            resuming: true,
            timeout: this.resumeTimeout
          })
          if (session === undefined) {
            throw new Error('The node rejected session resuming.')
          }
        }
        if (
          this.isDestroyed ||
          !this.connected ||
          this.sessionId !== parsed.sessionId
        ) {
          return
        }
        this.emit('ready', parsed)
        this.aqua.emit('nodeReady', this, parsed)
        if (this.autoResume && oldSession && !parsed.resumed) {
          for (const player of this.players) {
            try {
              await this.aqua.restorePlayer(player)
            } catch (error) {
              this.aqua.emit('reconnectionFailed', player, { error })
              this.reportError(error)
            }
          }
        }
        break
      }
      case 'stats': {
        delete parsed.op
        if (parsed.cpu && 'nodelinkLoad' in parsed.cpu) {
          delete parsed.cpu.lavalinkLoad
        }
        this.stats = parsed as Partial<NodeStats>
        this.emit('stats', this.stats)
        this.aqua.emit('nodeStats', this, this.stats)
        break
      }
      case 'playerUpdate': {
        const player = this.findPlayer(parsed.guildId)
        if (!player || !parsed.state) {
          break
        }
        player.position = parsed.state.position
        player.timestamp = parsed.state.time
        player.ping = parsed.state.ping
        player.connected = parsed.state.connected
        player.emit('playerUpdate', parsed)
        this.aqua.emit('playerUpdate', player, parsed)
        break
      }
      case 'event':
      case 'events':
        this.emit('event', parsed)
        this.aqua.emit('nodeEvent', this, parsed)
        if (
          typeof parsed.type === 'string' &&
          typeof parsed.guildId === 'string'
        ) {
          const player = this.findPlayer(parsed.guildId)
          if (player) {
            await player.handleEvents(parsed as PlayerEventPayload)
          }
        }
        break
      case 'lyricsLine':
      case 'lyricsFound':
      case 'lyricsNotFound': {
        const player = this.findPlayer(parsed.guildId)
        if (player) {
          player.emit(parsed.op, player.current, parsed)
          this.aqua.emit(parsed.op, player, player.current, parsed)
        }
        break
      }
      default:
        this.emit('customOp', parsed.op, parsed)
        this.aqua.emit('nodeCustomOp', this, parsed.op, parsed)
    }
  }

  private findPlayer(guildId?: string) {
    if (!guildId) {
      return null
    }
    const player = this.aqua.players.get(guildId)
    return player?.node === this && !player.destroyed ? player : null
  }

  /** Fetch server info after socket open, then emit nodeConnect. Does not establish readiness. */
  public async handleWebsocketOpen(event: { currentTarget: unknown }) {
    const socket = this.websocket
    if (
      !socket ||
      event.currentTarget !== socket ||
      socket.readyState !== 1 ||
      this.isDestroyed
    ) {
      return
    }
    let info: Awaited<ReturnType<Rest['getInfo']>>
    try {
      info = await this.rest.getInfo()
    } catch (error) {
      if (socket === this.websocket && !this.isDestroyed) {
        this.reportError(error)
      }
      return
    }
    if (
      socket !== this.websocket ||
      socket.readyState !== 1 ||
      this.isDestroyed
    ) {
      return
    }
    if (info) {
      this.info = info
      this.isNodelink = 'isNodelink' in info && info.isNodelink === true
    }
    this.emit('connect')
    this.aqua.emit('nodeConnect', this)
    this.aqua.emit('nodeConnected', this)
  }

  /** Mark the owned socket disconnected and schedule a retry within the configured limit. */
  public handleWebsocketClose(
    event: { code: number; reason: string },
    socket: WebSocket
  ) {
    if (
      this.isDestroyed ||
      (this.websocket !== null && this.websocket !== socket)
    ) {
      return
    }
    this.connected = false
    this.nodeState = 'DISCONNECTED'
    this.emit('disconnect', event)
    this.aqua.emit('nodeDisconnect', this, {
      code: event.code,
      reason: event.reason ?? ''
    })
    this.manageBackoff(socket)
  }

  /** Keep at most one reconnect timer. Delays grow from reconnectTimeout up to seven minutes. */
  public manageBackoff(socket: Pick<WebSocket, 'readyState'>) {
    if (
      this.isDestroyed ||
      this.connected ||
      socket.readyState === 1 ||
      this.reconnectTimeoutId !== null
    ) {
      return
    }
    if (!this.infiniteReconnects && this.reconnectRetries >= this.maxRetries) {
      return
    }
    const delay = Math.min(
      this.reconnectTimeout *
        (this.reconnectRetries >= 2 ? this.reconnectRetries + 0.5 : 1),
      420000
    )
    this.reconnectTimeoutId = setTimeout(async () => {
      this.reconnectTimeoutId = null
      if (this.isDestroyed || this.connected) {
        return
      }
      this.reconnectRetries++
      this.aqua.emit('nodeReconnect', this, {
        attempt: this.reconnectRetries,
        delay
      })
      try {
        await this.connect()
      } catch (error) {
        this.reportError(error)
        this.manageBackoff({ readyState: 3 })
      }
    }, delay)
    this.reconnectTimeoutId.unref?.()
  }

  /** Log and emit nodeError on Aqua. Node's error event is emitted only when it has listeners. */
  reportError(error: unknown) {
    this.aqua.logger.error(
      { err: error, node: this.name },
      'Node operation failed.'
    )
    this.aqua.emit('nodeError', this, error)
    if (this.listenerCount('error')) {
      this.emit('error', error)
    }
  }

  /** Close the socket, cancel retries/requests and remove this node from Aqua.
   * clean=true also starts player cleanup with skipRemote; this method doesn't await it.
   * Use aqua.destroy() when you need to await cleanup for the whole client.
   * @example node.destroy()
   */
  destroy(clean = true) {
    if (this.isDestroyed) {
      return
    }
    this.isDestroyed = true
    this.connected = false
    this.nodeState = 'DESTROYED'
    if (this.reconnectTimeoutId !== null) {
      clearTimeout(this.reconnectTimeoutId)
    }
    this.reconnectTimeoutId = null
    const socket = this.websocket
    this.websocket = null
    socket?.close()
    if (clean) {
      for (const player of this.players) {
        player
          .destroy({ skipRemote: true })
          .catch((error) => this.reportError(error))
      }
    }
    this.players.clear()
    this.rest.destroy()
    this.sessionId = null
    if (this.aqua.nodesMap.get(this.name) === this) {
      this.aqua.nodesMap.delete(this.name)
    }
    this.aqua.emit('nodeDestroy', this)
    this.removeAllListeners()
  }
}
