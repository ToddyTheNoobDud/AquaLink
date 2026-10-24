import { EventEmitter } from 'node:events'
import type Aqua from '../aqua/Aqua.ts'
import type Node from '../nodes/Node.ts'
import type { PlayerEventMap, PlayerEventPayload } from '../shared/Events.ts'
import type Track from '../shared/Track.ts'
import type {
  ConnectionOptions,
  LoopMode,
  LoopModeName,
  PlayerOptions,
  PlayerUpdate,
  PlayOptions,
  QueueLike
} from '../types/shared.ts'
import Connection from './Connection.ts'
import Filters from './Filters.ts'
import PlayerEvents from './PlayerEvents.ts'
import Queue from './Queue.ts'

export const LOOP_MODES = Object.freeze({
  NONE: 0,
  TRACK: 1,
  QUEUE: 2
} as const)

/** One guild's playback. Queue, connection, filters and event processing are replaceable.
 * @example const player = await aqua.createConnection({ guildId, voiceChannel })
 * @example await player.play(track)
 */
export default class Player extends EventEmitter<PlayerEventMap> {
  static readonly LOOP_MODES = LOOP_MODES
  public aqua: Aqua
  public node: Node
  public connection: Connection
  public events: PlayerEvents
  public guildId: string | undefined
  public voiceChannel: string | undefined
  public textChannel: string | undefined
  public playing = false
  public paused = false
  public destroyed = false
  public volume = 100
  public loop: LoopMode = 0
  public position = 0
  public timestamp = 0
  public ping = 0
  public deaf = true
  public mute = false
  private currentTrack: Track | null = null
  public previous: Track | null = null
  /** Bot-owned message reference, available during destroy events and released afterwards.
   * AquaLink never edits or deletes the message.
   */
  public nowPlayingMessage: unknown = null
  public isAutoplayEnabled = false
  public lazyLoad: boolean
  public leaveOnEnd: boolean
  private storedQueue: QueueLike | undefined
  private queueEnabled = true
  private storedFilters: Filters | undefined
  private voiceConnectionPromise: Promise<Connection> | null = null

  // Playback operations run in order; concurrent play() calls share starting.
  private playbackPromise: Promise<unknown> | null = null
  private starting: Promise<this> | null = null
  private destruction: Promise<this> | null = null

  private pendingUpdates = new Set<Promise<unknown>>()

  constructor(
    aqua: Aqua,
    node: Node | null = aqua.getNode(),
    options?: PlayerOptions
  ) {
    super()
    if (!node?.connected || !node.sessionId) {
      throw new Error(
        'A connected node with a ready session is required to create a player.'
      )
    }
    this.aqua = aqua
    this.node = node
    this.guildId = options?.guildId
    this.voiceChannel = options?.voiceChannel
    this.textChannel = options?.textChannel
    this.volume = options?.defaultVolume ?? 100
    this.deaf = options?.deaf ?? true
    this.mute = options?.mute ?? false
    this.lazyLoad = aqua.options?.lazyloadPlayer === true
    this.leaveOnEnd = aqua.options?.leaveOnEnd === true
    const queue =
      options?.queue === undefined ? aqua.options?.queue : options.queue
    this.queueEnabled = queue !== false && queue !== null
    if (queue && typeof queue !== 'function') {
      this.storedQueue = queue
    }
    if (this.queueEnabled && !this.lazyLoad && !this.storedQueue) {
      this.storedQueue = this.createQueue()
    }
    const ConnectionClass = aqua.options?.structures?.Connection ?? Connection
    const EventsClass = aqua.options?.structures?.PlayerEvents ?? PlayerEvents
    this.connection = new ConnectionClass(aqua, this)
    this.events = new EventsClass(aqua, this)
    if (options?.loop !== undefined) {
      this.setLoop(options.loop)
    }
  }

  get nodes() {
    return this.node
  }

  set nodes(node: Node) {
    this.node = node
  }

  get connected() {
    return this.connection.connected
  }

  set connected(value: boolean) {
    this.connection.connected = value
  }

  /** Local current track; queue holds only the tracks waiting after it. */
  get current() {
    return this.currentTrack
  }

  set current(track: Track | null) {
    this.currentTrack = track
  }

  /** Whether waiting storage already exists. Reading this doesn't allocate it. */
  get hasQueue() {
    return this.storedQueue !== undefined
  }

  /** Reading queue allocates it in lazy mode. Disabled queues throw instead of silently enabling.
   * @example if (player.hasQueue) console.log(player.queue.size)
   */
  get queue(): QueueLike {
    if (!this.queueEnabled) {
      throw new Error('This player has its queue disabled.')
    }
    if (!this.storedQueue) {
      this.storedQueue = this.createQueue()
    }
    return this.storedQueue
  }

  set queue(queue: QueueLike | undefined | null | false) {
    this.queueEnabled = queue !== false && queue !== null
    this.storedQueue = queue || undefined
  }

  protected createQueue(): QueueLike {
    const configured = this.aqua.options?.queue
    if (typeof configured === 'function') {
      return configured(this)
    }
    const QueueClass = this.aqua.options?.structures?.Queue ?? Queue
    return new QueueClass()
  }

  /** Created on first access, using structures.Filters when supplied. */
  get filters() {
    const FiltersClass = this.aqua.options?.structures?.Filters ?? Filters
    if (!this.storedFilters) {
      this.storedFilters = new FiltersClass(this)
    }
    return this.storedFilters
  }

  set filters(filters: Filters) {
    this.storedFilters = filters
  }

  /** Forward a server event to this player's PlayerEvents instance. */
  handleEvents(payload: PlayerEventPayload) {
    return this.events.handleEvents(payload)
  }

  /** Join using the supplied or stored channel IDs. play() waits for the same voice operation.
   * @example await player.connect({ guildId, voiceChannel, deaf: true })
   */
  async connect(options?: ConnectionOptions) {
    if (this.destroyed) {
      throw new Error('Player is destroyed.')
    }
    const guildId = options?.guildId ?? this.guildId
    const voiceChannel = options?.voiceChannel ?? this.voiceChannel
    if (!guildId || !voiceChannel) {
      throw new Error('guildId and voiceChannel are required.')
    }
    this.guildId = guildId
    this.textChannel = options?.textChannel ?? this.textChannel
    this.deaf = options?.deaf ?? this.deaf
    this.mute = options?.mute ?? this.mute
    this.voiceConnectionPromise = this.connection.joinVoice({
      ...options,
      guildId,
      voiceChannel,
      deaf: this.deaf,
      mute: this.mute
    })
    await this.voiceConnectionPromise
    return this
  }

  /** Serializes track changes so late responses can't clear a newer track. */
  protected runPlayback(operation: () => Promise<this>): Promise<this> {
    const previousPlayback = this.playbackPromise
    const playback = previousPlayback
      ? previousPlayback.catch(() => {}).then(operation)
      : operation()
    this.playbackPromise = playback
    playback
      .finally(() => {
        if (this.playbackPromise === playback) {
          this.playbackPromise = null
        }
      })
      .catch(() => {})
    return playback
  }

  /** Wait for the current play/stop/skip operation. Used before event-driven queue progression. */
  async waitForPlayback() {
    await this.playbackPromise
  }

  /** Start the supplied track or first waiting item without appending it to the queue.
   * The default trackEnd handler uses this for progression and looping.
   * @example await player.playNext()
   */
  playNext(track?: Track, options: PlayOptions = {}) {
    return this.runPlayback(() => this.startTrack(track, options))
  }

  /** When idle, starts directly. Otherwise adds to the waiting queue.
   * noReplace:false replaces current and leaves waiting tracks alone.
   * With queue:false, explicit tracks replace current unless noReplace is true.
   * @example await player.play(track, { startTime: 30000, userData: { requesterId } })
   */
  play(track?: Track | null, options: PlayOptions = {}): Promise<this> {
    if (track && options.userData) {
      track.userData = options.userData
    }
    if (this.destroyed) {
      return Promise.reject(new Error('Player is destroyed.'))
    }
    if (
      track &&
      options.noReplace !== false &&
      this.queueEnabled &&
      (this.starting || this.playing || this.storedQueue?.size)
    ) {
      this.queue.add(track)
      track = undefined
    }
    if (this.starting) {
      return this.starting
    }
    const requestedTrack = track ?? undefined
    const starting = this.runPlayback(() =>
      this.startTrack(requestedTrack, options)
    )
    this.starting = starting
    starting
      .finally(() => {
        if (this.starting === starting) {
          this.starting = null
        }
      })
      .catch(() => {})
    return starting
  }

  protected async startTrack(track?: Track, options: PlayOptions = {}) {
    if (this.voiceConnectionPromise) {
      await this.voiceConnectionPromise
    }
    if (this.destroyed) {
      throw new Error('Player is destroyed.')
    }
    if (!this.connected || !this.guildId) {
      throw new Error('Connect the player to voice before playing a track.')
    }
    if (this.playing && (!track || options.noReplace === true)) {
      return this
    }
    const queue = this.storedQueue
    let next = track ?? queue?.at(0)
    if (!next) {
      return this
    }
    if (!next.encoded) {
      next = (await next.resolve(this.aqua)) ?? undefined
    }
    if (!next?.encoded) {
      throw new Error('Failed to resolve track.')
    }
    if (this.destroyed || !this.connected || !this.guildId) {
      throw new Error(
        'The player left voice or was destroyed while preparing playback.'
      )
    }
    const previous = this.current
    this.current = next
    this.playing = true
    const userData = options.userData ?? next.userData
    const data: PlayerUpdate = {
      track: { encoded: next.encoded, ...(userData ? { userData } : {}) },
      paused: options.paused ?? false
    }
    if (this.volume !== 100) {
      data.volume = this.volume
    }
    if (options.startTime !== undefined) {
      data.position = options.startTime
    }
    try {
      await this.updatePlayer(data, options.noReplace ?? this.queueEnabled)
      if (this.destroyed) {
        return this
      }
      if (!track && queue?.at(0) === next) {
        queue.dequeue()
      }
      if (this.current === next) {
        this.paused = options.paused ?? false
        this.position = options.startTime ?? 0
      }
      return this
    } catch (error) {
      if (this.current === next) {
        this.current = previous
        this.playing = previous !== null
      }
      throw error
    }
  }

  /** Stop current and keep waiting tracks. An idle player is left alone.
   * @example await player.stop()
   */
  stop() {
    return this.runPlayback(() => this.stopTrack())
  }

  protected async stopTrack() {
    if (this.destroyed) {
      throw new Error('Player is destroyed.')
    }
    if (!this.current) {
      return this
    }
    if (!this.connected || !this.guildId) {
      throw new Error('Connect the player before stopping.')
    }
    const current = this.current
    await this.updatePlayer({
      track: { encoded: null }
    })
    if (this.current === current) {
      this.current = null
      this.playing = false
      this.paused = false
      this.position = 0
    }
    return this
  }

  /** Stop current and start the next waiting track. An empty/disabled queue leaves current alone.
   * @example await player.skip()
   */
  skip() {
    return this.runPlayback(async () => {
      const queue = this.storedQueue
      if (!queue?.size) {
        return this
      }
      await this.stopTrack()
      return this.startTrack()
    })
  }

  /** Set paused locally and send one update. Rejects if the node doesn't accept it.
   * @example await player.pause(false)
   */
  async pause(paused: boolean) {
    if (typeof paused !== 'boolean') {
      throw new TypeError('paused must be a boolean.')
    }
    this.paused = paused
    await this.updatePlayer({ paused })
    return this
  }

  /** Seek in milliseconds, clamped to zero and the current track's length for non-streams.
   * With no current track, this does nothing.
   * @example await player.seek(30000)
   */
  async seek(position: number) {
    if (!Number.isFinite(position)) {
      throw new TypeError('position must be a finite number.')
    }
    if (!this.current) {
      return this
    }
    this.position = Math.max(
      0,
      this.current.isStream ? position : Math.min(position, this.current.length)
    )
    await this.updatePlayer({ position: this.position })
    return this
  }

  /** Set local volume and send it to the node. Finite values are clamped to 0..1000.
   * @example await player.setVolume(80)
   */
  async setVolume(volume: number) {
    if (!Number.isFinite(volume)) {
      throw new TypeError('volume must be a finite number.')
    }
    this.volume = Math.max(0, Math.min(1000, volume))
    await this.updatePlayer({ volume: this.volume })
    return this
  }

  /** Choose local queue progression: none/0, track/1 or queue/2. Sends no request.
   * @example player.setLoop('track')
   */
  setLoop(mode: LoopMode | LoopModeName) {
    const parsed =
      typeof mode === 'string' ? { none: 0, track: 1, queue: 2 }[mode] : mode
    if (parsed !== 0 && parsed !== 1 && parsed !== 2) {
      throw new TypeError('Loop must be none, track, queue, 0, 1 or 2.')
    }
    this.loop = parsed
    return this
  }

  /** Leave Discord voice and clear current. Keeps this player and its waiting queue reusable.
   * A manual kick takes a different path and destroys the player.
   * @example await player.disconnect()
   */
  async disconnect() {
    if (!this.guildId) {
      return this
    }
    // Clear our join first so its gateway echo isn't treated as a manual kick.
    await this.connection.destroy()
    await this.aqua.send({
      op: 4,
      d: {
        guild_id: this.guildId,
        channel_id: null,
        self_deaf: this.deaf,
        self_mute: this.mute
      }
    })
    this.voiceChannel = undefined
    this.playing = false
    this.paused = false
    this.current = null
    return this
  }

  /** Shuffle existing waiting storage when it provides shuffle(). Doesn't allocate a lazy queue.
   * @example player.shuffle()
   */
  shuffle() {
    this.storedQueue?.shuffle?.()
    return this
  }

  /** Seek current back to zero. Does nothing if there is no current track. */
  replay() {
    return this.seek(0)
  }

  /** Send raw player fields, including server extensions. Returns the REST response.
   * Rejects when makeRequest reports failure. Raw updates don't mirror all fields locally;
   * use the control methods when you want their local-state changes too.
   * @example await player.updatePlayer({ crossfade: { enabled: true, duration: 5000 } })
   */
  async updatePlayer(data: PlayerUpdate, noReplace = false) {
    if (this.destroyed || !this.guildId) {
      throw new Error('A registered, active player is required.')
    }
    const request = this.node.rest.updatePlayer({
      guildId: this.guildId,
      data,
      noReplace
    })
    this.pendingUpdates.add(request)
    try {
      const response = await request
      if (response === undefined) {
        throw new Error('The node rejected the player update.')
      }
      return response
    } finally {
      this.pendingUpdates.delete(request)
    }
  }

  /** Log an operation failure and emit playerError on Aqua. */
  reportError(error: unknown) {
    this.aqua.logger.error(
      { err: error, guildId: this.guildId },
      'Player operation failed, sadly.'
    )
    this.aqua.emit('playerError', this, error)
  }

  /** Send a Discord voice update using this player's IDs and mute/deaf defaults. */
  send(data: Partial<import('../types/shared.ts').VoiceUpdatePayload['d']>) {
    if (!this.guildId) {
      throw new Error('guildId is required.')
    }
    return this.aqua.send({
      op: 4,
      d: {
        guild_id: this.guildId,
        channel_id: this.voiceChannel ?? null,
        self_deaf: this.deaf,
        self_mute: this.mute,
        ...data
      }
    })
  }

  /** Enable the bot's options.autoplay callback. Enabling without a callback throws.
   * @example player.setAutoplay(true)
   */
  setAutoplay(enabled: boolean) {
    if (enabled && !this.aqua.options?.autoplay) {
      throw new Error(
        'Supply options.autoplay from your bot before enabling autoplay.'
      )
    }
    this.isAutoplayEnabled = enabled
    return this
  }

  /** Ask the bot's callback for one track and play it if the player is still idle. */
  async autoplay() {
    const track = await this.aqua.options?.autoplay?.(this)
    if (track && !this.destroyed && !this.playing) {
      await this.play(track)
    }
    return this
  }

  /** Idempotent. Local references are released even when remote cleanup fails.
   * A new connection for this guild waits for the remote cleanup to finish.
   * Await the returned promise; queued Track objects may still be shared elsewhere.
   * skipRemote is for local teardown when the remote session is already unavailable.
   * @example await player.destroy()
   */
  destroy(options: { skipRemote?: boolean } = {}) {
    if (this.destruction) {
      return this.destruction
    }
    this.destroyed = true
    const voiceCleanup = this.connection.destroy()
    this.storedFilters = undefined
    this.storedQueue?.clear()
    this.storedQueue = undefined
    this.current = null
    this.previous = null
    this.playing = false
    this.paused = false
    this.node.players?.delete(this)
    this.destruction = (async () => {
      try {
        await this.playbackPromise?.catch(() => {})
        // A late PATCH must finish before DELETE, or it could recreate the player.
        await Promise.allSettled(this.pendingUpdates)
        await voiceCleanup
        if (!options.skipRemote && this.guildId) {
          const results = await Promise.allSettled([
            this.voiceChannel ? this.send({ channel_id: null }) : undefined,
            this.node.rest.destroyPlayer(this.guildId).then((response) => {
              if (response === undefined) {
                throw new Error('The node rejected player destruction.')
              }
            })
          ])
          const failures = results.filter(
            (result) => result.status === 'rejected'
          )
          if (failures.length) {
            throw new AggregateError(
              failures.map(
                (result) => (result as PromiseRejectedResult).reason
              ),
              'Player cleanup failed.'
            )
          }
        }
        return this
      } finally {
        if (this.guildId && this.aqua.players?.get(this.guildId) === this) {
          this.aqua.players.delete(this.guildId)
        }
      }
    })()
    this.emit('destroy')
    this.aqua.emit('playerDestroy', this)
    this.nowPlayingMessage = null
    this.removeAllListeners()
    return this.destruction
  }
}
