import type AquaManager from '../aqua/Aqua.ts'
import type { ConnectionOptions } from '../aqua/Aqua.ts'
import type { VoiceServerUpdate, VoiceStateUpdate } from '../types/shared.ts'
import type Player from './Player.ts'

/**
 * Joins Discord voice and collects the two gateway packets needed by the node.
 * Once all fields arrive, sends them through REST and resolves the pending join.
 *
 * @example
 * ```ts
 * const player = await aqua.createConnection(connectionOptions)
 * console.log(player.connection.connected)
 * ```
 */
export default class Connection {
  /** The manager with your Discord send adapter. */
  public aqua: AquaManager
  /** The player whose voice channel and node this connection uses. */
  public player: Player
  /** Voice server hostname from Discord; null means no usable endpoint yet. */
  public endpoint: string | null = null
  /** Discord guild ID used in the player REST route. */
  public guildId: string | undefined
  /** Discord voice token. Treat this as a credential, don't log it. */
  public token: string | undefined
  /** Discord voice session; different from player.node.sessionId. */
  public sessionId: string | undefined
  /** The node accepted our voice PATCH; not a live voice ping/health check. */
  public connected = false

  private pending: ReturnType<typeof Promise.withResolvers<void>> | null = null
  private updating = false

  /**
   * Stores the manager/player without joining voice. Player creates this for you.
   *
   * @param aqua - The owning Aqua instance.
   * @param player - The player supplying the node and channel IDs.
   * @example
   * ```ts
   * const connection = player.connection // usually use the one Player already created
   * console.log(connection.connected)
   * ```
   */
  constructor(aqua: AquaManager, player: Player) {
    this.aqua = aqua
    this.player = player
  }

  /**
   * Gets a new object with the voice fields collected so far.
   * Some fields can be null/undefined until both Discord packets arrive.
   * This is a local snapshot, not a VoiceInfo guaranteed ready for REST.
   *
   * @returns Endpoint, guild ID, token, voice session ID and current voice channel ID.
   * @example
   * ```ts
   * const voice = player.connection.getVoiceInfo()
   * console.log(voice.channelId) // avoid logging the token
   * ```
   */
  public getVoiceInfo() {
    return {
      endpoint: this.endpoint,
      guildId: this.guildId,
      token: this.token,
      sessionId: this.sessionId,
      channelId: this.player.voiceChannel
    }
  }

  /**
   * Sends the join payload, waits for Discord voice data, then waits for its REST PATCH.
   * Missing voice packets time out after 15 seconds. Keep forwarding both packet types
   * to aqua.updateVoiceState while this promise is pending.
   * An existing pending join is shared; a connected instance returns immediately.
   * This doesn't move an already connected instance to a different channel.
   *
   * @param options - Guild/channel IDs plus deaf (true) and mute (false) defaults.
   * @returns This Connection after the node accepts the voice update.
   * @throws If sending fails, joining times out, the bot leaves or the voice PATCH fails.
   * @example
   * ```ts
   * await player.connection.joinVoice(connectionOptions)
   * ```
   */
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

  /**
   * Stores Discord's VOICE_SERVER_UPDATE and tries to complete the pending join.
   * A null endpoint keeps waiting for usable data. The name really is setSeverUpdate;
   * keeping the draft spelling avoids breaking callers for now.
   * Normally aqua.updateVoiceState routes this packet for you.
   *
   * @param data - Server update data for this player's guild.
   * @example
   * ```ts
   * await aqua.updateVoiceState({
   *   t: 'VOICE_SERVER_UPDATE',
   *   d: { guild_id: '123', token: 'voice-token', endpoint: 'voice.example.invalid' }
   * })
   * ```
   */
  public async setSeverUpdate(data: VoiceServerUpdate) {
    this.endpoint = data.endpoint
    this.token = data.token
    this.guildId = data.guild_id
    await this.updateVoice()
  }

  /**
   * Stores the bot's Discord voice session/channel and tries to complete joining.
   * channel_id=null means the bot left: clears local voice/playback state and rejects
   * a pending join. It doesn't clear queued tracks or delete the remote player.
   * Normally Aqua filters the guild/user before calling this.
   *
   * @param data - The bot's VOICE_STATE_UPDATE data for this guild.
   * @example
   * ```ts
   * await aqua.updateVoiceState({
   *   t: 'VOICE_STATE_UPDATE',
   *   d: { guild_id: '123', user_id: client.id, session_id: 'voice-session', channel_id: '456' }
   * })
   * ```
   */
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

  /**
   * Sends one voice PATCH once the pending join has all required fields.
   * A response from an expired join can't resolve a newer join's promise.
   * @example The second voice packet completes the fields and triggers this internally.
   */
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
