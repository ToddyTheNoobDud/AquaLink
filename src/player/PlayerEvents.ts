import type AquaManager from '../aqua/Aqua.ts'
import type { PlayerEventPayload } from '../shared/Events.ts'
import type Player from './Player.ts'

/**
 * Handles one player's node events, then emits the original payload on the Player.
 * Uses a switch for known types; other types go through handleCustomEvent.
 * @example
 * ```ts
 * player.on('TrackEndEvent', payload => {
 *   console.log(payload.reason)
 * })
 * ```
 */
export default class PlayerEvents {
  /** Manager used by this player's event handling. */
  public aqua: AquaManager
  /** The same Player instance that received the event. */
  public player: Player
  /**
   * Stores the manager and player. Player creates this once in its constructor.
   * @example
   * ```ts
   * const events = player.events
   * ```
   */
  constructor(aqua: AquaManager, player: Player) {
    this.aqua = aqua
    this.player = player
  }

/*   get customEvent() {
    return 'todo'
  }

  set customEvent(name: string) {
     this.aqua.logger.info('todo')
  }

  public async deleteCustomEvent() {} */

  /**
   * Hook for types outside TrackStartEvent/TrackEndEvent, including other protocol events.
   * Empty by default. Override it in your subclass; no handler Map is needed.
   * handleEvents currently calls this hook without awaiting its promise.
   * @param payload - The full event, including any custom fields.
   * @example
   * ```ts
   * class CustomEvents extends PlayerEvents {
   *   override async handleCustomEvent(payload: PlayerEventPayload) {
   *     this.aqua.logger.info(`got ${payload.type}`)
   *   }
   * }
   * player.events = new CustomEvents(aqua, player)
   * ```
   */
  public async handleCustomEvent(payload) { } 

  /**
   * TrackStart passes straight to emission. TrackEnd waits for trackEnd's work;
   * other types call handleCustomEvent without waiting for it.
   * Emits once under payload.type, keeping the same payload object.
   * @param payload - Guild event forwarded by Node.
   * @returns Resolves after dispatch and public emission, including next playback if attempted.
   * @throws If trackEnd or a public listener fails. A rejected trackEnd skips emission.
   * Player/Node currently don't return/await this promise through the full chain.
   * @example
   * ```ts
   * await player.events.handleEvents({ type: 'CustomEvent', guildId: '123' })
   * ```
   */
  public async handleEvents(payload: PlayerEventPayload) {
    switch (payload.type) {
      case 'TrackStartEvent':
        break
  
      case 'TrackEndEvent':
        await this.trackEnd(payload)
        break
  
      default:
        this.handleCustomEvent(payload)
    }
  
    this.player.emit(payload.type, payload)
  }

  /**
   * Ignores ends that don't match current's encoded track. A match clears current
   * and playing before checking the queue, without allocating a lazy queue.
   * finished/loadFailed start the next waiting track; other reasons don't advance.
   * stopped/replaced/cleanup still have debug logs and a TODO for extra handling.
   * @throws If starting the next track fails; the queued track stays available.
   * @example A matching finished event leaves the player idle when no tracks are waiting.
   */
  private async trackEnd(payload: any) {
    const player = this.player
    
    if (!player.current || payload.track?.encoded !== player.current.encoded) {
      return
    }
    
    player.current = null
    player.playing = false
    
    const canStartNext =
      payload.reason === 'finished' ||
      payload.reason === 'loadFailed'
    
    if (canStartNext && player.hasQueue && player.queue.size > 0) {
      await player.play()
    }

    if (payload.reason === 'stopped' || payload.reason === 'replaced' || payload.reason === 'cleanup') {
      console.log(payload.reason)
      console.log(payload)
      // todo
    }
  }
}
