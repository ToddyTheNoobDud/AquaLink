import { EventEmitter } from 'node:events'
import pino, { type Logger } from 'pino'
import Node from '../nodes/Node.ts'
import Player from '../player/Player.ts'
import Track from '../shared/Track.ts'
import type {
  AquaOptions,
  LoadResult,
  NodeOptions,
  VoicePacket,
  VoiceUpdatePayload
} from '../types/shared.ts'

/**
 * Guild and channel IDs for joining voice. Keep Discord IDs as strings.
 * Connection sends deaf=true and mute=false unless you override them.
 *
 * @example
 * ```ts
 * const options: ConnectionOptions = {
 *   guildId: '123', voiceChannel: '456', textChannel: '789', deaf: true
 * }
 * const player = await aqua.createConnection(options)
 * ```
 */
export type ConnectionOptions = {
  /** The Discord server this player belongs to. */
  guildId: string
  /** The voice channel the bot should join. */
  voiceChannel: string
  /** Your bot's text channel; Aqua doesn't send messages here itself. */
  textChannel: string
  /** Self-deafen the bot when joining. Defaults to true. */
  deaf?: boolean
  /** Self-mute the bot when joining. Defaults to false. */
  mute?: boolean
}

/**
 * Manages nodes, players and your Discord adapter.
 * Call init with the bot's user ID to start connecting.
 *
 * @example
 * ```ts
 * const aqua = new AquaManager(client, [nodeOptions], aquaOptions)
 * await aqua.init(client.id)
 * ```
 */
export default class AquaManager extends EventEmitter {
  /** the client instance from your discord lib */
  public client: unknown
  /** Array of the configured nodes. */
  public nodes: NodeOptions[]
  /** the nodes as a Map */
  public nodesMap: Map<string, Node>
  /** Logger/retry settings and your Discord voice adapter. */
  public options?: AquaOptions
  /** the clientId from init. */
  public clientId: string | null = null
  /** logging system, uses pino internally. */
  public logger: Logger
  /** init finished creating nodes. Check getNode() for a ready session. */
  public initiated: boolean
  /** current registered players in aqua */
  public players: Map<string, Player>

  /**
   * Stores your client/config and creates the logger/maps. Sockets start in init.
   *
   * @param client - Your client, from any Discord library.
   * @param nodes - Node configs; init supports one node per Aqua for now.
   * @param options - Logger/retry settings and options.send for voice.
   * @example
   * ```ts
   * const aqua = new AquaManager(client, [nodeOptions], aquaOptions)
   * ```
   */
  constructor(client: unknown, nodes: NodeOptions[], options?: AquaOptions) {
    super()

    if (!client) {
      throw new Error('Aqua needs a client for the 1st arg.')
    }
    if (!Array.isArray(nodes) || !nodes.length) {
      throw new Error('Aqua needs the nodes for the 2nd args.')
    }

    this.client = client
    this.nodes = nodes

    this.nodesMap = new Map()
    this.players = new Map()

    if (options) {
      this.options = options
    }

    this.clientId = null
    this.initiated = false
    this.logger = pino({
      level: this.options?.logging.level,
      transport: { target: 'pino-pretty' }
    })
  }

  /**
   * Looks up a guild's existing player.
   *
   * @param guildid - Discord guild ID.
   * @returns The stored player, or null if none exists.
   * @example
   * ```ts
   * const player = aqua.get('123')
   * console.log(player?.queue.size)
   * ```
   */
  public get(guildid: string) {
    const player = this.players.get(guildid)
    if (!player) {
      return null
    }
    return player
  }

  /**
   * Gets the first connected node with a sessionId, in map insertion order.
   * Doesn't balance load or change existing players' assigned nodes.
   *
   * @returns A ready node, or null.
   * @example
   * ```ts
   * const node = aqua.getNode()
   * if (node) console.log(node.name, node.sessionId)
   * ```
   */
  public getNode(): Node | null {
    for (const node of this.nodesMap.values()) {
      if (node.connected && node.sessionId) {
        return node
      }
    }
    return null
  }

  /**
   * Sends through options.send. Your adapter must pick the guild's shard.
   *
   * @param data - Outgoing Discord opcode 4 payload.
   * @throws If options.send is missing or fails.
   * @example
   * ```ts
   * await aqua.send({
   *   op: 4,
   *   d: { guild_id: '123', channel_id: '456', self_deaf: true, self_mute: false }
   * })
   * ```
   */
  public async send(data: VoiceUpdatePayload) {
    if (!this.options?.send) {
      throw new Error(
        'Configure options.send to connect a player to Discord voice.'
      )
    }
    await this.options.send(data)
  }

  /**
   * Routes both Discord voice packet types to the guild's player, in either order.
   * Ignores other users' voice states and packets without a guild/registered player.
   *
   * @param packet - VOICE_STATE_UPDATE or VOICE_SERVER_UPDATE gateway packet.
   * @example
   * ```ts
   * await aqua.updateVoiceState({
   *   t: 'VOICE_STATE_UPDATE',
   *   d: { guild_id: '123', user_id: client.id, session_id: 'voice-session', channel_id: '456' }
   * })
   * ```
   */
  public async updateVoiceState(packet: VoicePacket) {
    const guildId = packet.d.guild_id
    if (!guildId) {
      return
    }
    const player = this.players.get(guildId)
    if (!player) {
      return
    }
    switch (packet.t) {
      case 'VOICE_STATE_UPDATE':
        if (packet.d.user_id !== this.clientId) {
          return
        }
        await player.connection.setStateUpdate(packet.d)
        break
      case 'VOICE_SERVER_UPDATE':
        await player.connection.setSeverUpdate(packet.d)
        break
    }
  }

  /**
   * Returns the guild's player as-is, even while it's connecting. If none exists,
   * calls createPlayer and waits for voice. New options don't move an existing player.
   *
   * @param options - Guild/channel IDs and optional deaf/mute flags.
   * @returns The registered Player.
   * @throws If creating/connecting a new player fails; see createPlayer.
   * @example
   * ```ts
   * const player = await aqua.createConnection({
   *   guildId: '123', voiceChannel: '456', textChannel: '789'
   * })
   * ```
   */
  public async createConnection(options: ConnectionOptions) {
    const player = this.players.get(options.guildId)

    if (player) {
      return player
    }

    return await this.createPlayer(options)
  }

  /**
   * Picks a ready node, registers the player so voice packets can find it, then joins.
   * Failed joins remove the new player and rethrow. Existing players return as-is.
   *
   * @param options - Discord guild/channel IDs and deaf/mute flags.
   * @returns Player; new players wait for the node to accept voice data.
   * @throws If no node is ready, options.send is missing, or joining fails/times out.
   * @example
   * ```ts
   * const player = await aqua.createPlayer({
   *   guildId: '123', voiceChannel: '456', textChannel: '789', deaf: true
   * })
   * ```
   */
  public async createPlayer(options: ConnectionOptions) {
    const existing = this.players.get(options.guildId)
    if (existing) {
      return existing
    }
    const player = new Player(this, this.getNode())
    // Register before joining: Discord may send voice packets immediately.
    this.players.set(options.guildId, player)
    try {
      await player.connect(options)
      return player
    } catch (error) {
      this.players.delete(options.guildId)
      throw error
    }
  }

  /**
   * Starts the configured node with the bot's user ID without waiting for WebSocket ready.
   * Check getNode() for a usable session before creating players.
   *
   * @example
   * ```ts
   * await aqua.init(client.id) // call this once your Discord client is ready
   * ```
   *
   * @param clientId - Bot's Discord user ID for the WebSocket User-Id header.
   * @returns This Aqua instance.
   * @throws If the ID is empty or multiple nodes are configured.
   */
  public async init(clientId: string) {
    if (!clientId) {
      throw new Error(
        'clientId is required to start aqualink, please pass one.'
      )
    }

    this.clientId = clientId

    if (!this.nodes) {
      throw new Error(`For now, aqualink can't start without a node(s).`)
    }

    // for now i'll be limiting for 1 node only, i'll add multiple nodes later;

    if (this.nodes.length === 1) {
      await this.createNode()
    } else {
      throw new Error('For now, aqualink is limited to 1 node per-instance.')
    }

    this.logger.info(
      `Aqualink initiation was a sucess, in total, ${this.nodes.length} nodes were created.`
    )

    this.initiated = true
    return this
  }

  /**
   * Creates/registers this.nodes and starts their sockets. init calls this for you.
   * Calling it again replaces map entries without cleaning up old instances.
   *
   * @returns This Aqua instance; doesn't wait for socket readiness.
   * @example
   * ```ts
   * await aqua.init(client.id) // init calls createNode internally
   * ```
   */
  public async createNode() {
    // https://biomejs.dev/linter/rules/no-for-each/javascript/#description

    for (const nodeOptions of this.nodes) {
      const node = new Node(this, nodeOptions)
      this.nodesMap.set(nodeOptions.name, node)
      if (!node.connected) {
        await node.connect()
      }
      this.logger.debug('CreateNode recived, now trying to connect.')
    }

    return this
  }

  /**
   * Wraps search payloads as Tracks for resolve. Other load types return undefined.
   * @example A search response with two payloads becomes an array of two Tracks.
   */
  private handleTrackLoading(res: LoadResult) {
    switch (res.loadType) {
      case 'search': {
        if (!Array.isArray(res.data)) {
          return
        }

        const tracks = res.data.map((trackData) => new Track(trackData))

        return tracks
      }
    }
  }

  /**
   * Searches the first configured node and wraps loadType='search' results as Tracks.
   * Uses its own lookup; _node and getNode() don't affect selection yet.
   *
   * @param query - Search text.
   * @param source - Prefix without :, for example ytsearch or scsearch.
   * @param _node - Unused for now.
   * @returns Track[]; an empty search stays []. Returns undefined if offline,
   * loading fails or the response isn't a search result.
   * @example
   * ```ts
   * const tracks = await aqua.resolve('slayr eyesight', 'ytsearch')
   * const first = tracks?.[0]
   * if (first) console.log(first.info.title)
   * ```
   */
  public async resolve(query: string, source: string, _node?: Node) {
    // i will do auto node select soon.
    const nodes = this.nodesMap.get(this.nodes[0]?.name as string)

    if (!nodes?.connected) {
      return this.logger.error(
        'You cannot resolve a song while the NODE is offline/not connected.'
      )
    }

    const res = await nodes?.rest.loadTracks(query, source)

    if (res) {
      const tracks = this.handleTrackLoading(res as LoadResult)

      return tracks
    }
  }
}
