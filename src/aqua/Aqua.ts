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
 * Where the player should join and where your bot handles text commands.
 * These are Discord IDs, so keep them as strings. Deaf defaults to true,
 * mute defaults to false when Connection sends the voice update.
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
 * Here is where most of the stuff starts: nodes, players and your Discord adapter.
 * Creating Aqua doesn't connect anything yet; call init with the bot's user ID.
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
  /** Logging, retry settings and the adapter used to send Discord voice updates. */
  public options?: AquaOptions
  /** the clientId from init. */
  public clientId: string | null = null
  /** logging system, uses pino internally. */
  public logger: Logger
  /** init finished creating nodes; this doesn't mean their sessions are ready. */
  public initiated: boolean
  /** current registered players in aqua */
  public players: Map<string, Player>

  /**
   * Keeps your client/config and creates the logger and maps. No sockets yet.
   *
   * @param client - Your Discord client. Aqua stores it without assuming a library.
   * @param nodes - Node configs; init currently supports one node per Aqua.
   * @param options - Logging/retry settings and options.send for voice connections.
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
   * Gets an existing player for a guild. Doesn't create one if it's missing.
   *
   * @param guildid - The Discord guild ID.
   * @returns The same player stored in the map, or null if there's none.
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
   * Gets the first connected node that already has a sessionId.
   * Map insertion order decides which one comes first; no load balancing here.
   * This lookup doesn't change the node assigned to an existing player.
   *
   * @returns A ready node, or null while none is ready.
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
   * Sends a gateway payload through your options.send adapter, thats it.
   * The adapter needs to send it to the shard responsible for this guild.
   *
   * @param data - The outgoing Discord opcode 4 payload.
   * @throws If options.send is missing, or if your adapter throws/rejects.
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
   * Receives the two Discord voice packets and routes them to the guild's player.
   * Feed both packet types here. They can arrive in either order.
   * Voice states from other users and packets without a registered player are ignored.
   *
   * @param packet - A VOICE_STATE_UPDATE or VOICE_SERVER_UPDATE gateway packet.
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
   * Gets the guild's player, or creates one and waits for its voice connection.
   * An existing player is returned as-is, even if it's still connecting.
   * Changing options here doesn't move an existing player to another channel.
   *
   * @param options - Guild, voice/text channel IDs and optional deaf/mute settings.
   * @returns The registered player, rather than its Connection object.
   * @throws If a new player cannot connect; see createPlayer for the requirements.
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
   * Picks a ready node, registers the player, then joins Discord voice.
   * Registration happens first so incoming voice packets can find the player.
   * If joining fails, the new player is removed from the map and the error is rethrown.
   * An existing player is returned straight away; it isn't created or connected again.
   *
   * @param options - The Discord guild/channel IDs used by this player.
   * @returns The player; a new one waits for the node to accept its voice data.
   * @throws If no node is ready, options.send is missing, or voice joining fails/times out.
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
   * Starts Aqua with the bot's user ID and creates the configured node.
   * This starts the WebSocket connection, but doesn't wait for the ready payload.
   * Use getNode() to check whether a node has a usable session before creating players.
   *
   * @example
   * ```ts
   * await aqua.init(client.id) // call this once your Discord client is ready
   * ```
   *
   * @param clientId - The bot's Discord user ID, used in the WebSocket User-Id header.
   * @returns This Aqua instance, so you can keep using the same one.
   * @throws If the ID is empty or more than one node is configured.
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
   * Creates/registers nodes from this.nodes and starts their sockets.
   * Usually init calls this for you. Calling it again replaces map entries
   * with new Node instances; it doesn't clean up the old ones.
   *
   * @returns This Aqua instance; socket readiness still happens later.
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
   * Turns search payloads into Track instances for resolve.
   * Other load types aren't converted yet, so they return undefined.
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
   * Searches on the first configured node and wraps search results as Tracks.
   * This currently handles loadType='search' only; other results return undefined.
   * The _node argument isn't used yet, and this doesn't use getNode() for selection.
   *
   * @param query - What you want to search for.
   * @param source - Search prefix without the colon, for example ytsearch or scsearch.
   * @param _node - Reserved argument; passing a node doesn't select it right now.
   * @returns A Track array, or undefined if the node is offline, loading fails,
   * or the response isn't a supported search result. An empty search array stays [].
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
