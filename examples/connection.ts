import { Connection, type ConnectionOptions } from '../src/index.ts'

export class BotConnection extends Connection {
  override async joinVoice(options: ConnectionOptions) {
    // Await the normal handshake before running your extra work.
    const connection = await super.joinVoice(options)
    this.aqua.logger.info(
      { guildId: options.guildId, channelId: options.voiceChannel },
      'Voice is connected'
    )
    return connection
  }
}
