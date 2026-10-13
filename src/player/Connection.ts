import type AquaManager from '../aqua/Aqua.ts'
import type { ConnectionOptions } from '../aqua/Aqua.ts'
import type { VoiceServerUpdate, VoiceStateUpdate } from '../types/shared.ts'
import type Player from './Player.ts'

export default class Connection {
  public aqua: AquaManager
  public player: Player
  public endpoint: string | null = null
  public guildId: string | undefined
  public token: string | undefined
  public sessionId: string | undefined
  public connected = false

  private pending: ReturnType<typeof Promise.withResolvers<void>> | null = null
  private updating = false

  constructor(aqua: AquaManager, player: Player) {
    this.aqua = aqua
    this.player = player
  }

  public getVoiceInfo() {
    return {
      endpoint: this.endpoint,
      guildId: this.guildId,
      token: this.token,
      sessionId: this.sessionId,
      channelId: this.player.voiceChannel
    }
  }

  public async joinVoice(options: ConnectionOptions) {
    if (this.connected) {
      return this
    }
    if (this.pending) {
      await this.pending.promise
      return this
    }
    this.guildId = options.guildId
    const pending = Promise.withResolvers<void>()
    this.pending = pending
    const timeout = setTimeout(() => {
      pending.reject(
        new Error('Discord voice connection timed out after 15 seconds.')
      )
    }, 15000)

    try {
      await Promise.all([
        this.aqua.send({
          op: 4,
          d: {
            guild_id: options.guildId,
            channel_id: options.voiceChannel,
            self_deaf: options.deaf ?? true,
            self_mute: options.mute ?? false
          }
        }),
        pending.promise
      ])
      return this
    } finally {
      clearTimeout(timeout)
      this.pending = null
    }
  }

  /** Retains the draft method name so existing callers keep working. */
  public async setSeverUpdate(data: VoiceServerUpdate) {
    this.endpoint = data.endpoint
    this.token = data.token
    this.guildId = data.guild_id
    await this.updateVoice()
  }

  public async setStateUpdate(data: VoiceStateUpdate) {
    this.sessionId = data.session_id
    if (data.channel_id === null) {
      this.connected = false
      this.sessionId = undefined
      this.player.voiceChannel = undefined
      this.player.playing = false
      this.player.current = null
      this.pending?.reject(
        new Error('The bot left voice before the connection completed.')
      )
      return
    }
    this.player.voiceChannel = data.channel_id
    await this.updateVoice()
  }

  private async updateVoice() {
    const { endpoint, token, sessionId, guildId } = this
    const channelId = this.player.voiceChannel
    if (this.connected || this.updating || !this.pending) {
      return
    }
    if (!endpoint || !token || !sessionId || !guildId || !channelId) {
      return
    }
    const pending = this.pending

    this.updating = true
    try {
      const response = await this.player.node.rest.updatePlayers(guildId, {
        voice: { endpoint, token, sessionId, channelId }
      })
      if (response === undefined) {
        throw new Error('The node rejected the Discord voice update.')
      }
      if (this.pending !== pending) {
        return
      }
      this.connected = true
      pending.resolve()
    } catch (error) {
      pending.reject(error)
    } finally {
      this.updating = false
    }
  }
}
