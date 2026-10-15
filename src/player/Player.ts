import EventEmitter from 'node:events'
import type AquaManager from '../aqua/Aqua.ts'
import type { ConnectionOptions } from '../aqua/Aqua.ts'
import type Node from '../nodes/Node.ts'
import type Track from '../shared/Track.ts'
import Connection from './Connection.ts'
import Queue from './Queue.ts'

/**
 * One guild's playback state, queue and voice connection on a specific node.
 * Aqua normally creates/registers this for you. Queue advancement is still manual.
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
  /** The assigned node; later Aqua lookups don't change this reference. */
  public node: Node
  /** Handles this player's Discord voice credentials and joining. */
  public connection: Connection
  /** Set by connect; undefined on a freshly constructed player. */
  public guildId: string | undefined
  /** Set by connect/voice states; cleared when the bot leaves voice. */
  public voiceChannel: string | undefined
  /** Your bot's text channel ID; Aqua doesn't send messages automatically. */
  public textChannel: string | undefined
  /** Local playback flag; set before the track PATCH and rolled back on failure. */
  public playing = false
  /** Queue allocation mode read from Aqua when this player was created. */
  public lazyLoad: boolean

  private queueInstance: Queue | undefined
  private currentTrack: Track | null = null
  private connecting: Promise<Connection> | null = null
  private starting: Promise<this> | null = null

  /**
   * Creates local state on the supplied node, or uses aqua.getNode() if omitted.
   * Doesn't register the player, join voice or start a track by itself.
   *
   * @param aqua - The manager used for voice updates and node selection.
   * @param node - A connected node with a sessionId; defaults to aqua.getNode().
   * @throws If no usable node is supplied/found.
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
   * Gets the queue, creating it on first access if lazyloadPlayer is enabled.
   * Even reading queue.size creates it; use hasQueue to check without allocating.
   * The same instance is reused. You can replace it with your own Queue instance.
   * Assigning undefined drops it; the next queue access creates a new one.
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
   * Replaces the waiting queue, or drops it when assigned undefined.
   * Doesn't change current or start playback.
   * @example
   * ```ts
   * player.queue = new Queue()
   * ```
   */
  public set queue(queue: Queue | undefined) {
    this.queueInstance = queue
  }

  /**
   * Checks whether a Queue has been created, without creating one just to check.
   * An empty queue still exists once created; it isn't discarded automatically.
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
   * Gets the track being started/played, or null while idle. No Queue is needed.
   * Keeps the same Track reference; setting current doesn't start playback.
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
   * Updates the local current reference. Use play(track) to actually send REST.
   * @example
   * ```ts
   * player.current = null // local state only
   * ```
   */
  public set current(track: Track | null) {
    this.currentTrack = track
  }

  /**
   * Sets the guild/channel IDs and waits for the node to accept Discord voice data.
   * Aqua must have this player registered so updateVoiceState can route packets to it.
   *
   * @param options - The guild, voice/text channel IDs and deaf/mute flags.
   * @returns This player after joining; an existing connected Connection is reused.
   * @throws If joining fails, the adapter is missing or voice packets time out.
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
   * Starts a supplied track directly when idle, without creating a Queue.
   * With no argument, starts the first track from an existing queue.
   * A supplied track joins the queue if playback/start is in progress or tracks
   * are already waiting, so it doesn't jump ahead of them. Concurrent calls share
   * the pending start request; supplied tracks are still added to the waiting queue.
   * An empty player just returns itself without creating a Queue.
   * Queued tracks leave the queue only after REST succeeds; failures keep them.
   * A failed direct start clears current/playing; retry it with play(track).
   * TrackEnd resets local state, but doesn't automatically play the next track yet.
   *
   * @returns This player after the start request; doesn't wait for the track to finish.
   * @param track - Optional Track to start directly or append behind existing work.
   * @throws If voice isn't connected, connecting failed or the node rejects the track.
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
   * Does the actual track PATCH and rolls back current/playing on failure.
   * Only play calls this; its shared promise keeps starts from racing.
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
