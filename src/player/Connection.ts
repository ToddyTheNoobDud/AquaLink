import type Aqua from '../aqua/Aqua.ts'
import type {
  ConnectionOptions,
  VoiceServerUpdate,
  VoiceStateUpdate
} from '../types/shared.ts'
import type Player from './Player.ts'

/** Collects Discord voice credentials and sends them to the player's node.
 * The bot forwards packets through Aqua.updateVoiceState; either packet order works.
 * Recovery can be requested explicitly through attemptResume.
 */
export default class Connection {
  public aqua: Aqua
  public player: Player
  public endpoint: string | null = null
  public token: string | undefined
  public sessionId: string | undefined
  public guildId: string | undefined
  public connected = false
  private pendingJoin: ReturnType<typeof Promise.withResolvers<void>> | null =
    null
  private voiceRevision = 0
  private connectionGeneration = 0
  private voiceUpdatePromise: Promise<void> | null = null

  constructor(aqua: Aqua, player: Player)
  constructor(player: Player)
  constructor(aquaOrPlayer: Aqua | Player, player?: Player) {
    this.player = player ?? (aquaOrPlayer as Player)
    this.aqua = player ? (aquaOrPlayer as Aqua) : this.player.aqua
    this.guildId = this.player.guildId
  }

  get voiceChannel() {
    return this.player.voiceChannel
  }

  /** Current credentials; some fields are empty before joining. Don't log this object. */
  getVoiceInfo() {
    return {
      endpoint: this.endpoint,
      token: this.token,
      sessionId: this.sessionId,
      guildId: this.guildId,
      channelId: this.player.voiceChannel
    }
  }

  /** A join only finishes after both packets and a successful voice PATCH.
   * @example await player.connection.joinVoice({ guildId, voiceChannel })
   */
  async joinVoice(options: ConnectionOptions) {
    if (this.connected && this.player.voiceChannel === options.voiceChannel) {
      return this
    }
    if (this.pendingJoin) {
      await this.pendingJoin.promise
      return this
    }
    this.reset()
    this.guildId = options.guildId
    this.player.voiceChannel = options.voiceChannel
    const pendingJoin = Promise.withResolvers<void>()
    this.pendingJoin = pendingJoin
    const timeout = setTimeout(
      () =>
        pendingJoin.reject(new Error('Discord voice connection timed out.')),
      this.aqua.options?.voiceTimeout ?? 15000
    )
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
        pendingJoin.promise
      ])
      return this
    } catch (error) {
      this.connected = false
      this.endpoint = null
      this.token = undefined
      this.sessionId = undefined
      this.connectionGeneration++
      throw error
    } finally {
      clearTimeout(timeout)
      if (this.pendingJoin === pendingJoin) {
        this.pendingJoin = null
      }
    }
  }

  /** Accept VOICE_SERVER_UPDATE data. Identical credentials don't send another PATCH. */
  async setServerUpdate(data: VoiceServerUpdate) {
    if (
      this.endpoint === data.endpoint &&
      this.token === data.token &&
      this.guildId === data.guild_id
    ) {
      return
    }
    this.endpoint = data.endpoint
    this.token = data.token
    this.guildId = data.guild_id
    this.connected = false
    this.voiceRevision++
    await this.updateVoice()
  }

  /** Accept the bot's VOICE_STATE_UPDATE data. Moves update the channel; a kick destroys Player. */
  async setStateUpdate(data: VoiceStateUpdate) {
    if (data.channel_id === null) {
      // disconnect() clears our join before its gateway echo reaches this handler.
      const wasInVoice =
        this.sessionId !== undefined || this.pendingJoin !== null
      this.reset(
        new Error('The bot left voice before the connection completed.')
      )
      this.player.voiceChannel = undefined
      this.player.current = null
      this.player.playing = false
      this.player.paused = false
      if (wasInVoice) {
        await this.player.destroy()
      }
      return
    }
    const oldChannel = this.player.voiceChannel
    this.player.deaf = data.self_deaf ?? this.player.deaf
    this.player.mute = data.self_mute ?? this.player.mute
    if (this.sessionId === data.session_id && oldChannel === data.channel_id) {
      return
    }
    this.sessionId = data.session_id
    this.player.voiceChannel = data.channel_id
    this.voiceRevision++
    if (oldChannel && oldChannel !== data.channel_id) {
      this.player.emit('playerMove', oldChannel, data.channel_id)
      this.aqua.emit('playerMove', oldChannel, data.channel_id)
    }
    await this.updateVoice()
  }

  private async updateVoice(): Promise<void> {
    if (this.voiceUpdatePromise) {
      await this.voiceUpdatePromise
      // A complete packet may arrive while an incomplete attempt is finishing.
      if (!this.connected) {
        await this.updateVoice()
      }
      return
    }
    const applyVoiceUpdates = async () => {
      let appliedRevision = -1
      // Repeat if new credentials arrived while the node was receiving the previous ones.
      while (appliedRevision !== this.voiceRevision) {
        appliedRevision = this.voiceRevision
        const connectionGeneration = this.connectionGeneration
        const { endpoint, token, sessionId, guildId } = this
        const channelId = this.player.voiceChannel
        if (
          !endpoint ||
          !token ||
          !sessionId ||
          !guildId ||
          !channelId ||
          this.player.destroyed
        ) {
          return
        }
        await this.player.updatePlayer(
          { voice: { endpoint, token, sessionId, channelId } },
          true
        )
        if (connectionGeneration !== this.connectionGeneration) {
          continue
        }
        if (appliedRevision !== this.voiceRevision) {
          continue
        }
        this.connected = true
        this.pendingJoin?.resolve()
      }
    }
    this.voiceUpdatePromise = applyVoiceUpdates()
    try {
      await this.voiceUpdatePromise
    } catch (error) {
      this.connected = false
      this.pendingJoin?.reject(error)
      if (!this.pendingJoin) {
        throw error
      }
    } finally {
      this.voiceUpdatePromise = null
    }
  }

  /** Resend complete stored credentials. Returns false when they aren't available.
   * This doesn't send a Discord join request and never runs on a timer.
   * @example const connected = await player.connection.attemptResume()
   */
  async attemptResume() {
    const voice = this.getVoiceInfo()
    if (
      !voice.endpoint ||
      !voice.token ||
      !voice.sessionId ||
      !voice.channelId ||
      !this.guildId
    ) {
      return false
    }
    this.connected = false
    this.voiceRevision++
    await this.updateVoice()
    return this.connected
  }

  /** Alias for attemptResume. The legacy force argument has no effect. */
  async resendVoiceUpdate(_force = false) {
    return this.attemptResume()
  }

  private reset(error?: Error) {
    this.connectionGeneration++
    this.voiceRevision++
    this.connected = false
    this.endpoint = null
    this.token = undefined
    this.sessionId = undefined
    if (error) {
      this.pendingJoin?.reject(error)
    }
  }

  /** Clear credentials, cancel a pending join and wait for any voice PATCH to settle.
   * Doesn't leave Discord by itself; Player owns that operation.
   */
  destroy() {
    this.reset(new Error('Voice connection destroyed.'))
    this.pendingJoin = null
    // A voice PATCH already accepted by fetch must settle before remote deletion.
    return (
      this.voiceUpdatePromise?.then(
        () => {},
        () => {}
      ) ?? Promise.resolve()
    )
  }
}
