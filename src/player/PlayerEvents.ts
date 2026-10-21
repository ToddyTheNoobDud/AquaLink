import type AquaManager from '../aqua/Aqua.ts'
import type { PlayerEventPayload } from '../shared/Events.ts'
import type Player from './Player.ts'

export default class PlayerEvents {
  public aqua: AquaManager
  public player: Player
  /**
   * Synchronous handlers keyed by the node's event name. Each player has its own map.
   * @example
   * ```ts
   * player.events.handlers.set('CustomEvent', payload => {
   *   console.log(payload)
   * })
   * ```
   */
  public handlers = new Map<string, (payload: PlayerEventPayload) => void>()

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

  public async deleteCustomEvent() {}

  public async handleCustomEvent() { } */

  /** Runs the registered handler, then emits the original payload on the Player. */
  public handleEvents(payload: PlayerEventPayload) {
    const handler = this.handlers.get(payload.type)
    handler?.(payload)
    this.player.emit(payload.type, payload)
  }
}
