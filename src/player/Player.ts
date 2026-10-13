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
 *   player.queue.add(tracks[0])
 *   await player.play()
 * }
 * ```
 */
export default class Player extends EventEmitter {
  /** Tracks waiting to play. The current track is removed after its PATCH succeeds. */
  public queue: Queue
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
  /** The track being started/played, or null while idle. */
  public current: Track | null = null
  /** Local playback flag; set before the track PATCH and rolled back on failure. */
  public playing = false

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
    this.queue = new Queue()
    this.connection = new Connection(aqua, this)
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
   * Starts the first queued track after any current connect call finishes.
   * If already playing or the queue is empty, just returns this player.
   * Concurrent calls share one start request, so they don't consume two tracks.
   * The track leaves the queue only after the REST update succeeds; failures keep it.
   * TrackEnd resets local state, but doesn't automatically play the next track yet.
   *
   * @returns This player after the start request; doesn't wait for the track to finish.
   * @throws If voice isn't connected, connecting failed or the node rejects the track.
   * @example
   * ```ts
   * player.queue.add(track)
   * await player.play()
   * console.log(player.current?.info.title)
   * ```
   */
  public play(): Promise<this> {
    if (this.starting) {
      return this.starting
    }
    this.starting = this.startTrack().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /**
   * Does the actual track PATCH and rolls back current/playing on failure.
   * Only play calls this; its shared promise keeps starts from racing.
   * @example Calling play() twice at once still sends one start request.
   */
  private async startTrack() {
    await this.connecting
    if (!this.connection.connected || !this.guildId) {
      throw new Error('Connect the player to voice before playing a track.')
    }
    if (this.playing) {
      return this
    }
    const track = this.queue.at(0)
    if (!track) {
      return this
    }

    this.current = track
    this.playing = true
    try {
      const response = await this.node.rest.updatePlayers(this.guildId, {
        track: { encoded: track.encoded }
      })
      if (response === undefined) {
        throw new Error('The node rejected the track update.')
      }
      this.queue.dequeue()
      return this
    } catch (error) {
      this.current = null
      this.playing = false
      throw error
    }
  }
}
