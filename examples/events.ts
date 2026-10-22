import { type PlayerEventPayload, PlayerEvents } from '../src/index.ts'

// This checkout imports the source module. For a packaged bot, augment the
// module exporting PlayerEventMap from the package you use.
declare module '../src/shared/Events.ts' {
  interface PlayerEventMap {
    announcement: [message: string]
  }
}

export class BotEvents extends PlayerEvents {
  override async trackStart(payload: PlayerEventPayload) {
    // Keep state updates and the normal trackStart listeners.
    await super.trackStart(payload)
    this.aqua.logger.info(
      { guildId: this.player.guildId },
      'The bot received trackStart'
    )
  }

  override async handleCustomEvent(payload: PlayerEventPayload) {
    // AnnouncementEvent is an example event your server/plugin could send.
    if (
      payload.type === 'AnnouncementEvent' &&
      typeof payload.message === 'string'
    ) {
      this.player.emit('announcement', payload.message)
    }
  }
}
