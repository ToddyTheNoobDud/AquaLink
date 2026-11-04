import type Aqua from '../aqua/Aqua.ts'
import type { PlayerEventPayload } from '../shared/Events.ts'
import Track from '../shared/Track.ts'
import type Player from './Player.ts'

// Protocol names differ from the v3 public listener names. These aren't handlers.
const legacyNames: Record<string, string> = Object.freeze({
  LyricsLineEvent: 'lyricsLine',
  LyricsFoundEvent: 'lyricsFound',
  LyricsNotFoundEvent: 'lyricsNotFound',
  VolumeChangedEvent: 'volumeChanged',
  FiltersChangedEvent: 'filtersChanged',
  SeekEvent: 'seek',
  PlayerCreatedEvent: 'playerCreated',
  PlayerConnectedEvent: 'playerConnected',
  PlayerDisconnectedEvent: 'playerDisconnected',
  PlayerDestroyedEvent: 'playerDestroy',
  PlayerMigratedEvent: 'playerMigrated',
  PauseEvent: 'pauseEvent',
  MixStartedEvent: 'mixStarted',
  MixEndedEvent: 'mixEnded',
  PlayerReconnectingEvent: 'PlayerReconnectingEvent'
})

/** Runs a handler, then emits the original payload on Player, even if the handler throws.
 * Override methods from bot code through options.structures.PlayerEvents.
 * @example class Events extends PlayerEvents {
 *   override async handleCustomEvent(payload: PlayerEventPayload) { console.log(payload.type) }
 * }
 */
export default class PlayerEvents {
  constructor(
    public aqua: Aqua,
    public player: Player
  ) {}
  /** Override for event types without a built-in handler. Raw emission still happens afterwards. */
  public async handleCustomEvent(_payload: PlayerEventPayload): Promise<void> {}
  /** Dispatch known types through the switch. Override the individual methods to keep routing. */
  public async handleEvents(payload: PlayerEventPayload) {
    if (this.player.destroyed) {
      return
    }
    try {
      switch (payload.type) {
        case 'TrackStartEvent':
          await this.trackStart(payload)
          break
        case 'TrackEndEvent':
          await this.trackEnd(payload)
          break
        case 'TrackExceptionEvent':
          await this.trackError(payload)
          break
        case 'TrackStuckEvent':
          await this.trackStuck(payload)
          break
        case 'WebSocketClosedEvent':
          await this.socketClosed(payload)
          break
        case 'TrackChangeEvent':
          await this.trackChange(payload)
          break
        default:
          if (Object.hasOwn(legacyNames, payload.type)) {
            await this.serverEvent(payload)
          } else {
            await this.handleCustomEvent(payload)
          }
      }
    } finally {
      this.player.emit('event', payload)
      this.player.emit(payload.type, payload)
    }
  }

  /** v3 aliases go to Player(track, ...) and Aqua(player, track, ...). */
  protected emit(name: string, track: Track | null, ...details: unknown[]) {
    this.player.emit(name, track, ...details)
    this.aqua.emit(name, this.player, track, ...details)
  }

  protected eventTrack(payload: PlayerEventPayload) {
    if (this.player.current?.encoded === payload.track?.encoded) {
      return this.player.current
    }
    if (!payload.track) {
      return this.player.current
    }
    const TrackClass = this.aqua.options?.structures?.Track ?? Track
    return new TrackClass(payload.track, undefined, this.player.node)
  }

  /** Set current/playing and emit trackStart with the Track wrapper. */
  public async trackStart(payload: PlayerEventPayload) {
    const track = this.eventTrack(payload)
    if (track) {
      this.player.current = track
    }
    this.player.playing = true
    this.player.timestamp = Date.now()
    this.emit('trackStart', track)
  }

  /** finished/loadFailed/stopped advance; replaced belongs to the newer play request.
   * The trackEnd alias is emitted before state cleanup; raw TrackEndEvent is emitted afterwards.
   * cleanup clears state without advancing. Only finished applies looping.
   * Override this method to own queue progression entirely.
   */
  public async trackEnd(payload: PlayerEventPayload) {
    const player = this.player
    const track = this.eventTrack(payload)
    this.emit('trackEnd', track, payload.reason)
    if (
      !player.current ||
      payload.track?.encoded !== player.current.encoded ||
      payload.reason === 'replaced'
    ) {
      return
    }
    if (
      payload.reason !== 'finished' &&
      payload.reason !== 'loadFailed' &&
      payload.reason !== 'stopped' &&
      payload.reason !== 'cleanup'
    ) {
      return
    }
    player.previous = player.current
    player.current = null
    player.playing = false
    player.paused = false
    player.position = 0
    if (payload.reason === 'cleanup') {
      return
    }
    await player.waitForPlayback()
    if (player.destroyed || player.playing || player.current) {
      return
    }
    if (player.loop === 1 && track && payload.reason === 'finished') {
      await player.playNext(track)
      return
    }
    if (player.loop === 2 && track && payload.reason === 'finished') {
      player.queue.add(track)
    }
    if (player.hasQueue && player.queue.size) {
      await player.playNext()
    } else if (player.isAutoplayEnabled) {
      await player.autoplay()
    }
    if (!player.destroyed && !player.playing && !player.current) {
      player.emit('queueEnd')
      this.aqua.emit('queueEnd', player)
      if (player.leaveOnEnd) {
        await player.destroy()
      }
    }
  }

  /** Emit trackError with the track and server exception. Doesn't advance the queue. */
  public async trackError(payload: PlayerEventPayload) {
    this.emit('trackError', this.eventTrack(payload), payload.exception)
  }

  /** Emit trackStuck with the track and threshold in ms. Recovery belongs to the bot. */
  public async trackStuck(payload: PlayerEventPayload) {
    this.emit('trackStuck', this.eventTrack(payload), payload.thresholdMs)
  }

  /** Mark voice disconnected and forward socketClosed. Doesn't automatically rejoin. */
  public async socketClosed(payload: PlayerEventPayload) {
    this.player.connected = false
    this.player.emit('socketClosed', payload)
    this.aqua.emit('socketClosed', this.player, payload)
  }

  /** Mirror a server track change into previous/current and emit trackChange. */
  public async trackChange(payload: PlayerEventPayload) {
    const track = this.eventTrack(payload)
    this.player.previous = this.player.current
    this.player.current = track
    this.emit('trackChange', track, payload)
  }

  /** NodeLink notification aliases. Reconnecting notifications don't trigger a hidden rejoin. */
  public async serverEvent(payload: PlayerEventPayload) {
    if (
      payload.type === 'VolumeChangedEvent' &&
      typeof payload.volume === 'number'
    ) {
      this.player.volume = payload.volume
    }
    if (payload.type === 'PauseEvent' && typeof payload.paused === 'boolean') {
      this.player.paused = payload.paused
    }
    if (payload.type === 'SeekEvent' && typeof payload.position === 'number') {
      this.player.position = payload.position
    }
    const name = legacyNames[payload.type]
    if (!name) {
      return
    }
    if (payload.type.startsWith('Player') || payload.type === 'PauseEvent') {
      this.player.emit(name, payload)
      this.aqua.emit(name, this.player, payload)
    } else {
      this.emit(name, this.eventTrack(payload), payload)
    }
  }
}
