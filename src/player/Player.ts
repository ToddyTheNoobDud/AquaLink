import EventEmitter from 'node:events'
import type AquaManager from '../aqua/Aqua.ts'
import type { ConnectionOptions } from '../aqua/Aqua.ts'
import type Node from '../nodes/Node.ts'
import type Track from '../shared/Track.ts'
import Connection from './Connection.ts'
import Queue from './Queue.ts'

/**
 * A guild's playback state, queue and voice connection on one node.
 * Aqua creates/registers it. Playing the next track is still manual.
 *
 * @example
 * ```ts
 * const player = await aqua.createConnection(connectionOptions)
 * const tracks = await aqua.resolve('slayr eyesight', 'ytsearch')
 * if (tracks?.[0]) {
 *   await player.play(tracks[0]) // current doesn't need to go through the queue
 * }
 * ```
 */
export default class Player extends EventEmitter {
  /** The Aqua instance owning this player. */
  public aqua: AquaManager
  /** Assigned node; Aqua lookups don't change it. */
  public node: Node
  /** Joins Discord voice and holds its credentials. */
  public connection: Connection
  /** Set by connect; undefined on a freshly constructed player. */
  public guildId: string | undefined
  /** Set by connect/voice states; cleared when the bot leaves voice. */
  public voiceChannel: string | undefined
  /** Text channel ID for your bot's messages; Aqua sends none itself. */
  public textChannel: string | undefined
  /** Local playback flag; set before the track PATCH and rolled back on failure. */
  public playing = false
  /** Lazy setting read from Aqua at creation. */
  public lazyLoad: boolean

  private queueInstance: Queue | undefined
  private currentTrack: Track | null = null
  private connecting: Promise<Connection> | null = null
  private starting: Promise<this> | null = null

  /**
   * Creates local state. Registration, voice joining and playback happen separately.
   *
   * @param aqua - Owning manager.
   * @param node - Connected node with a sessionId. Defaults to aqua.getNode().
   * @throws If no node is ready.
   * @example
   * ```ts
   * const player = new Player(aqua, node)
   * // Normally use aqua.createConnection(connectionOptions), which also registers it.
   * ```
   */
  constructor(aqua: AquaManager, node: Node | null = aqua.getNode()) {
    super()
    if (!node?.connected || !node.sessionId) {
      throw new Error(
        'A connected node with a ready session is required to create a player.'
      )
    }
    this.aqua = aqua
    this.node = node

    this.lazyLoad = this.aqua.options?.lazyloadPlayer === true
    if (!this.lazyLoad) {
      this.queueInstance = new Queue()
    }
    this.connection = new Connection(aqua, this)
  }

  /**
   * Gets or creates the queue and reuses it on later reads.
   * Even queue.size creates it in lazy mode. Use hasQueue to check without allocating.
   * You can assign your own Queue; assigning undefined drops it until the next read.
   *
   * @example
   * ```ts
   * player.queue.add(track) // creates the queue if it doesn't exist yet
   * ```
   */
  public get queue(): Queue {
    this.queueInstance ??= new Queue()
    return this.queueInstance
  }

  /**
   * Replaces/drops the waiting queue. Leaves current and playback alone.
   * @example
   * ```ts
   * player.queue = new Queue()
   * ```
   */
  public set queue(queue: Queue | undefined) {
    this.queueInstance = queue
  }

  /**
   * Checks for an existing Queue without creating one. Empty queues are kept too.
   *
   * @example
   * ```ts
   * const waiting = player.hasQueue ? player.queue.size : 0
   * console.log(waiting)
   * ```
   */
  public get hasQueue() {
    return this.queueInstance !== undefined
  }

  /**
   * The track being started/played, or null while idle. Reads the same Track
   * reference without creating a Queue. Setting it only changes local state.
   *
   * @example
   * ```ts
   * console.log(player.current?.info.title)
   * ```
   */
  public get current(): Track | null {
    return this.currentTrack
  }

  /**
   * Sets the local reference. Use play(track) to send the playback request.
   * @example
   * ```ts
   * player.current = null // local state only
   * ```
   */
  public set current(track: Track | null) {
    this.currentTrack = track
  }

  /**
   * Saves guild/channel IDs and waits for the node to accept voice data.
   * Register the player in Aqua first so updateVoiceState can find it.
   *
   * @param options - Guild/channel IDs and deaf/mute flags.
   * @returns This player. Reuses an already connected Connection.
   * @throws On a missing adapter, timeout or failed join.
   * @example
   * ```ts
   * await player.connect({ guildId: '123', voiceChannel: '456', textChannel: '789' })
   * ```
   */
  public async connect(options: ConnectionOptions) {
    this.guildId = options.guildId
    this.voiceChannel = options.voiceChannel
    this.textChannel = options.textChannel
    this.connecting = this.connection.joinVoice(options)
    await this.connecting
    return this
  }

  /**
   * Starts track directly when idle; queues it if playback is starting/playing or
   * tracks are already waiting. Without track, plays the first queued item.
   * Concurrent calls share the start request; new tracks still join the queue.
   * No tracks means no queue allocation. Queued tracks leave only after REST succeeds.
   * Failed starts clear current/playing: queued tracks stay put; retry direct ones
   * with play(track). TrackEnd resets state; playing the next track is manual.
   *
   * @returns This player after the start request, or unchanged if there's nothing to do.
   * It doesn't wait for the track to finish.
   * @param track - Optional track to start or queue behind existing work.
   * @throws If connecting fails, voice isn't connected or the node rejects playback.
   * @example
   * ```ts
   * await player.play(track) // current only, no queue allocation when lazy
   * // player.queue.add(nextTrack); await player.play() also keeps working
   * console.log(player.current?.info.title)
   * ```
   */
  public play(track?: Track): Promise<this> {
    if (track && (this.starting || this.playing || this.queueInstance?.size)) {
      this.queue.add(track)
      track = undefined
    }
    if (this.starting) {
      return this.starting
    }
    this.starting = this.startTrack(track).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /**
   * Sends the track PATCH and rolls back current/playing on failure.
   * play shares its promise between concurrent calls.
   * @example Calling play() twice at once still sends one start request.
   */
  private async startTrack(track?: Track) {
    await this.connecting
    if (!this.connection.connected || !this.guildId) {
      throw new Error('Connect the player to voice before playing a track.')
    }
    if (this.playing) {
      return this
    }
    const queue = this.queueInstance
    const nextTrack = track ?? queue?.at(0)
    if (!nextTrack) {
      return this
    }

    this.current = nextTrack
    this.playing = true
    try {
      const response = await this.node.rest.updatePlayers(this.guildId, {
        track: { encoded: nextTrack.encoded }
      })
      if (response === undefined) {
        throw new Error('The node rejected the track update.')
      }
      if (!track) {
        queue?.dequeue()
      }
      return this
    } catch (error) {
      this.current = null
      this.playing = false
      throw error
    }
  }
}
