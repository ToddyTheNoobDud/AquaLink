import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import Node from '../nodes/Node.ts'
import Player from '../player/Player.ts'
import type { AquaEventMap } from '../shared/Events.ts'
import createLogger from '../shared/Logger.ts'
import Track from '../shared/Track.ts'
import type {
  AquaOptions,
  LoadResult,
  NodeOptions,
  PlayerOptions,
  ResolveOptions,
  ResolveResponse,
  SavedPlayerData,
  TrackData,
  VoicePacket,
  VoiceUpdatePayload
} from '../types/shared.ts'

export type { ConnectionOptions } from '../types/shared.ts'

/** Keeps the node and player registries. Supply options.send for Discord voice delivery.
 * @example const aqua = new Aqua(client, nodes, { send: packet => sendToGuildShard(packet) })
 * @example await aqua.init(botId)
 */
export default class AquaManager extends EventEmitter<AquaEventMap> {
  /** Nodes by configured name. nodeMap is an alias for this same Map. */
  public nodesMap = new Map<string, Node>()
  /** Players by guild ID. A destroyed entry stays here until its cleanup settles. */
  public players = new Map<string, Player>()
  public clientId: string | null = null
  public initiated = false
  public version = '4.0.0'
  public logger: NonNullable<AquaOptions['logger']>
  private initializing: Promise<this> | null = null
  private destruction: Promise<void> | null = null
  private destroyed = false

  constructor(
    public client: unknown,
    public nodes: NodeOptions[],
    public options: AquaOptions = {}
  ) {
    super()
    if (!client) {
      throw new Error('Aqua needs a client for the 1st arg.')
    }
    if (!Array.isArray(nodes) || !nodes.length) {
      throw new Error('At least one node is required.')
    }
    const names = nodes.map((node) => node.name ?? node.host)
    if (new Set(names).size !== names.length) {
      throw new Error('Node names must be unique.')
    }
    this.logger = options.logger ?? createLogger(options.logging?.level)
  }

  get nodeMap() {
    return this.nodesMap
  }

  get defaultSearchPlatform() {
    return this.options.defaultSearchPlatform ?? 'ytsearch'
  }

  get loadBalancer() {
    return this.options.loadBalancer ?? 'leastLoad'
  }

  get persistTracks() {
    return this.options.persistTracks ?? 'uri'
  }

  /** Snapshot of usable nodes, ordered by load or shuffled when loadBalancer is random. */
  get leastUsedNodes() {
    const nodes = Array.from(this.nodesMap.values()).filter(
      (node) => node.isUsable
    )
    if (this.loadBalancer === 'random') {
      for (let index = nodes.length - 1; index > 0; index--) {
        const other = Math.floor(Math.random() * (index + 1))
        const node = nodes[index] as Node
        nodes[index] = nodes[other] as Node
        nodes[other] = node
      }
      return nodes
    }
    return nodes.sort(
      (first, second) => this.nodeLoad(first) - this.nodeLoad(second)
    )
  }

  protected nodeLoad(node: Node) {
    const cpu = node.stats.cpu
    if (!cpu) {
      return node.players.size
    }

    if ('lavalinkLoad' in cpu) {
      return cpu.lavalinkLoad
    }

    return cpu.processLoad ?? cpu.nodelinkLoad ?? 0
  }

  /** Find a usable node by name, or choose one using loadBalancer. Returns null if none are ready.
   * @example const rest = aqua.getNode('main')?.rest
   */
  getNode(name?: string) {
    if (name) {
      const node = this.nodesMap.get(name)
      return node?.isUsable ? node : null
    }
    return this.leastUsedNodes[0] ?? null
  }

  /** Send through options.send. Rejects if your bot hasn't provided that adapter. */
  async send(payload: VoiceUpdatePayload) {
    if (!this.options.send) {
      throw new Error('Provide options.send to forward Discord voice packets.')
    }
    await this.options.send(payload)
  }

  /** Forward original gateway voice packets here. Other users' voice states are ignored.
   * A bot kick destroys its player; normal moves update the channel and voice credentials.
   * @example await aqua.updateVoiceState({ t: 'VOICE_STATE_UPDATE', d: voiceState })
   */
  async updateVoiceState(packet: VoicePacket) {
    const guildId = packet.d.guild_id
    if (!guildId) {
      return
    }
    const player = this.players.get(guildId)
    if (!player || player.destroyed) {
      return
    }
    if (packet.t === 'VOICE_STATE_UPDATE') {
      if (packet.d.user_id === this.clientId) {
        await player.connection.setStateUpdate(packet.d)
      }
    } else if (packet.t === 'VOICE_SERVER_UPDATE') {
      await player.connection.setServerUpdate(packet.d)
    }
  }

  /** Create and join a guild player. Resolves after the voice PATCH succeeds.
   * Returns an existing active player unchanged; waits for a destroyed one's cleanup first.
   * @example const player = await aqua.createConnection({ guildId, voiceChannel })
   */
  async createConnection(options: PlayerOptions): Promise<Player> {
    const existing = this.players.get(options.guildId)
    if (existing) {
      if (existing.destroyed) {
        await existing.destroy()
        return this.createConnection(options)
      }
      return existing
    }
    const node = this.getNode()
    if (!node) {
      throw new Error('No connected node with a ready session is available.')
    }
    const PlayerClass = this.options.structures?.Player ?? Player
    const player = new PlayerClass(this, node, options)
    this.players.set(options.guildId, player)
    node.players.add(player)
    try {
      this.emit('playerCreate', player)
      await player.connect(options)
      return player
    } catch (error) {
      await player.destroy({ skipRemote: true })
      throw error
    }
  }

  /** Start configured sockets once the bot ID is known. Repeated calls share initialization.
   * Resolving this promise doesn't mean the nodes are ready; listen for nodeReady.
   * @example await aqua.init(client.user.id)
   */
  init(clientId: string): Promise<this> {
    if (!clientId) {
      return Promise.reject(
        new Error('clientId is required to start aqualink.')
      )
    }
    if (this.destroyed) {
      return Promise.reject(new Error('Aqua is destroyed.'))
    }
    if (this.initiated) {
      return Promise.resolve(this)
    }
    if (this.initializing) {
      return this.initializing
    }
    this.clientId = clientId
    this.initializing = (async () => {
      try {
        await this.createNode()
        if (this.destroyed) {
          throw new Error('Aqua was destroyed during initialization.')
        }
        this.initiated = true
        this.logger.info(
          { nodes: this.nodesMap.size },
          'Aqualink initiation was a success, nodes were created.'
        )
        return this
      } catch (error) {
        for (const node of this.nodesMap.values()) {
          node.destroy()
        }
        throw error
      } finally {
        this.initializing = null
      }
    })()
    return this.initializing
  }

  /** With no argument, starts configured nodes. With config, adds one node at runtime.
   * Skips names already in the registry. Wait for nodeReady before using the new session.
   * @example await aqua.createNode({ name: 'extra', host: 'localhost', password: 'secret' })
   */
  async createNode(options?: NodeOptions) {
    if (this.destroyed) {
      throw new Error('Aqua is destroyed.')
    }
    const NodeClass = this.options.structures?.Node ?? Node
    for (const config of options ? [options] : this.nodes) {
      const name = config.name ?? config.host
      if (this.nodesMap.has(name)) {
        continue
      }
      const node = new NodeClass(this, config)
      this.nodesMap.set(name, node)
      try {
        this.emit('nodeCreate', node)
        this.logger.debug(
          { node: name },
          'CreateNode recived, now trying to connect.'
        )
        await node.connect()
      } catch (error) {
        node.destroy()
        throw error
      }
    }
    return this
  }

  protected wrapTrack(data: TrackData, requester?: unknown, node?: Node) {
    const TrackClass = this.options.structures?.Track ?? Track
    return new TrackClass(data, requester, node)
  }

  /** Load tracks from a query, URL or playlist. Object input returns a ResolveResponse.
   * Object input rejects transport/selection failures; a server load error lives in exception.
   * Positional input returns Track[], or undefined when selection/loading fails.
   * @example const { tracks, exception } = await aqua.resolve({ query: 'artist song' })
   * @example const tracks = await aqua.resolve('artist song', 'scsearch')
   */
  resolve(options: ResolveOptions): Promise<ResolveResponse>
  resolve(
    query: string,
    source?: string,
    node?: Node
  ): Promise<Track[] | undefined>
  async resolve(
    queryOrOptions: string | ResolveOptions,
    source?: string,
    suppliedNode?: Node
  ): Promise<ResolveResponse | Track[] | undefined> {
    const usesOptionsObject = typeof queryOrOptions !== 'string'
    const options = usesOptionsObject
      ? queryOrOptions
      : { query: queryOrOptions, source }
    if (!options.query) {
      throw new TypeError('A query is required.')
    }
    const requestedNode = options.nodes ?? suppliedNode
    let node: Node | null | undefined

    if (typeof requestedNode === 'string') {
      node = this.nodesMap.get(requestedNode)
    } else if (Array.isArray(requestedNode)) {
      node = requestedNode.find((candidate) => candidate.connected)
    } else {
      node = requestedNode ?? this.getNode()
    }

    if (!node) {
      if (usesOptionsObject) {
        throw new Error('No connected node is available.')
      }
      return undefined
    }
    const result = await node.rest.loadTracks(
      options.query,
      options.source ?? this.defaultSearchPlatform
    )
    if (!result) {
      if (usesOptionsObject) {
        throw new Error('Track loading failed.')
      }
      return undefined
    }
    const response = this.constructResponse(result, options.requester, node)
    return usesOptionsObject ? response : response.tracks
  }

  /** Wrap a server load result using structures.Track. Preserves playlist and plugin metadata. */
  public constructResponse(
    result: LoadResult,
    requester?: unknown,
    node?: Node
  ): ResolveResponse {
    const response: ResolveResponse = {
      loadType: result.loadType,
      exception: null,
      playlistInfo: null,
      pluginInfo: result.pluginInfo ?? {},
      tracks: []
    }
    switch (result.loadType) {
      case 'track':
        response.pluginInfo = result.data.pluginInfo ?? response.pluginInfo
        response.tracks = [this.wrapTrack(result.data, requester, node)]
        break
      case 'search':
        response.tracks = result.data.map((data) =>
          this.wrapTrack(data, requester, node)
        )
        break
      case 'playlist':
        response.playlistInfo = {
          thumbnail:
            (result.data.pluginInfo?.artworkUrl as string) ??
            result.data.tracks[0]?.info.artworkUrl ??
            null,
          ...result.data.info
        }
        response.pluginInfo = result.data.pluginInfo ?? response.pluginInfo
        response.tracks = result.data.tracks.map((data) =>
          this.wrapTrack(data, requester, node)
        )
        for (const track of response.tracks) {
          track.playlist = response.playlistInfo
        }
        break
      case 'error':
        response.exception = result.data
        break
    }
    return response
  }

  /** Recreate remote playback from this player's state and complete voice credentials.
   * autoResume calls this when an earlier server session wasn't resumed; bots can call it too.
   * @example await aqua.restorePlayer(player)
   */
  async restorePlayer(player: Player) {
    const voice = player.connection.getVoiceInfo()
    if (
      !voice.endpoint ||
      !voice.sessionId ||
      !voice.token ||
      !voice.channelId
    ) {
      throw new Error(
        'Complete Discord voice credentials are needed for restoration.'
      )
    }
    await player.updatePlayer({
      voice: {
        endpoint: voice.endpoint,
        token: voice.token,
        sessionId: voice.sessionId,
        channelId: voice.channelId
      },
      ...(player.current?.encoded
        ? {
            track: {
              encoded: player.current.encoded,
              userData: player.current.userData ?? undefined
            },
            position: player.position
          }
        : {}),
      volume: player.volume,
      paused: player.paused,
      filters: player.filters.toJSON()
    })
    player.connected = true
    this.emit('playerReconnected', player, { node: player.node })
  }

  /** Write v3 JSONL records to disk. Default path: ./AquaPlayers.jsonl.
   * Includes current and up to maxQueueSave waiting tracks. Save before destroying players.
   * Aqua doesn't add voice credentials; bot-provided metadata must be safe to serialize.
   * @example await aqua.savePlayer('./players.jsonl')
   */
  async savePlayer(filePath = './AquaPlayers.jsonl') {
    const serialize = (track: Track) =>
      this.persistTracks === 'full' ? track.toJSON() : track.uri
    const nodeSessions = Object.fromEntries(
      Array.from(this.nodesMap.values())
        .filter((node) => node.sessionId)
        .map((node) => [node.name, node.sessionId])
    )
    const lines = [
      JSON.stringify({ type: 'node_sessions', data: nodeSessions })
    ]
    for (const player of this.players.values()) {
      if (!player.guildId || !player.voiceChannel || player.destroyed) {
        continue
      }
      const record: SavedPlayerData = {
        g: player.guildId,
        t: player.textChannel ?? '',
        v: player.voiceChannel,
        u: player.current ? serialize(player.current) : null,
        ud: player.current?.userData ?? null,
        p: player.position,
        ts: Date.now(),
        q: (player.hasQueue
          ? player.queue.toArray().slice(0, this.options.maxQueueSave ?? 10)
          : []
        )
          .map(serialize)
          .filter((track): track is string | TrackData => track !== null),
        r: player.current?.toJSON().requester ?? null,
        vol: player.volume,
        pa: player.paused,
        pl: player.playing,
        nw: null
      }
      lines.push(JSON.stringify(record))
    }
    const temporary = `${filePath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${lines.join('\n')}\n`, { flag: 'wx' })
      await rename(temporary, filePath)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  /** Read saved JSONL, rejoin channels and restore playback. Existing guild players are skipped.
   * Requires a ready node and working gateway forwarding. Saved session headers are ignored.
   * @example await aqua.loadPlayers('./players.jsonl')
   */
  async loadPlayers(filePath = './AquaPlayers.jsonl') {
    const content = await readFile(filePath, 'utf8')
    const saved: unknown[] = content
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
    for (const record of saved as SavedPlayerData[]) {
      if (record && 'type' in record && record.type === 'node_sessions') {
        continue
      }
      if (
        !record ||
        typeof record.g !== 'string' ||
        typeof record.v !== 'string' ||
        !Array.isArray(record.q)
      ) {
        throw new TypeError('Invalid saved player.')
      }
      if (this.players.has(record.g)) {
        continue
      }
      const player = await this.createConnection({
        guildId: record.g,
        voiceChannel: record.v,
        textChannel: record.t,
        defaultVolume: record.vol
      })
      const restore = async (value: string | TrackData) =>
        typeof value === 'string'
          ? (
              await this.resolve({
                query: value,
                requester: record.r,
                nodes: player.node
              })
            ).tracks[0]
          : this.wrapTrack(value, record.r, player.node)
      try {
        const current = record.u ? await restore(record.u) : null
        for (const entry of record.q.slice(
          0,
          this.options.maxTracksRestore ?? 20
        )) {
          const track = await restore(entry)
          if (track) {
            player.queue.add(track)
          }
        }
        if (current) {
          current.userData = record.ud
          if (record.pl) {
            await player.playNext(current, {
              paused: record.pa,
              startTime: record.p
            })
          } else {
            player.current = current
            player.position = record.p
            player.paused = record.pa
          }
        }
      } catch (error) {
        await player.destroy()
        throw error
      }
    }
  }

  /** Destroy players, close nodes and remove listeners. This Aqua instance cannot be restarted.
   * Cleanup continues after individual failures, then rejects with their AggregateError.
   * @example await aqua.destroy()
   */
  async destroy() {
    if (this.destruction) {
      return this.destruction
    }
    this.destroyed = true
    this.destruction = (async () => {
      await this.initializing?.catch(() => {})
      const results = await Promise.allSettled(
        Array.from(this.players.values(), (player) => player.destroy())
      )
      for (const node of this.nodesMap.values()) {
        node.destroy()
      }
      this.initiated = false
      this.removeAllListeners()
      const errors = results.filter(
        (result) => result.status === 'rejected'
      ) as PromiseRejectedResult[]
      if (errors.length) {
        throw new AggregateError(
          errors.map((result) => result.reason),
          'Aqua cleanup failed.'
        )
      }
    })()
    return this.destruction
  }
}
