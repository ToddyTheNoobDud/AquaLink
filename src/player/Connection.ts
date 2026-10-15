import type AquaManager from '../aqua/Aqua.ts'
import type { ConnectionOptions } from '../aqua/Aqua.ts'
import type { VoiceServerUpdate, VoiceStateUpdate } from '../types/shared.ts'
import type Player from './Player.ts'

/**
 * Joins voice and collects both Discord packets. Once complete, sends the voice
 * data through REST and resolves the join after the node accepts it.
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
  /** Player supplying the voice channel and node. */
  public player: Player
  /** Discord voice server hostname, or null while unavailable. */
  public endpoint: string | null = null
  /** Discord guild ID used in the player REST route. */
  public guildId: string | undefined
  /** Discord voice token. Don't log it. */
  public token: string | undefined
  /** Discord voice session; different from player.node.sessionId. */
  public sessionId: string | undefined
  /** The node accepted our voice PATCH. Doesn't track live voice health. */
  public connected = false

  private pending: ReturnType<typeof Promise.withResolvers<void>> | null = null
  private updating = false

  /**
   * Player creates this with its manager. Joining happens later.
   *
   * @param aqua - Owning manager.
   * @param player - Player supplying node/channel IDs.
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
   * Gets a new snapshot of the collected voice fields. Fields can still be
   * null/undefined while packets are missing, so check before using it as VoiceInfo.
   *
   * @returns Endpoint, guild ID, token, voice session ID and channel ID.
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
   * Sends the join payload and waits for voice data plus its REST PATCH.
   * Forward both packet types to aqua.updateVoiceState; missing packets time out in 15s.
   * Shares a pending join. Already connected instances return as-is, without moving channels.
   *
   * @param options - Guild/channel IDs. Deaf defaults to true, mute to false.
   * @returns This Connection after the node accepts voice data.
   * @throws On send/PATCH errors, timeout or the bot leaving during the join.
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
   * Stores VOICE_SERVER_UPDATE and tries to finish joining; a null endpoint keeps waiting.
   * aqua.updateVoiceState routes this for you. setSeverUpdate keeps its old spelling
   * for caller compatibility.
   *
   * @param data - This guild's server update.
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
   * Stores the bot's voice session/channel and tries to finish joining.
   * channel_id=null clears local voice/playback state and rejects a pending join;
   * queued tracks and the remote player stay. Aqua filters guild/user before calling.
   *
   * @param data - The bot's VOICE_STATE_UPDATE for this guild.
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
   * PATCHes complete voice data for the pending join. Expired responses can't
   * resolve a newer join's promise.
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
