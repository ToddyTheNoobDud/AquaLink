import EventEmitter from 'node:events'
import type AquaManager from '../aqua/Aqua.ts'
import type { ConnectionOptions } from '../aqua/Aqua.ts'
import type Node from '../nodes/Node.ts'
import type Track from '../shared/Track.ts'
import Connection from './Connection.ts'
import Queue from './Queue.ts'

export default class Player extends EventEmitter {
  public queue: Queue
  public aqua: AquaManager
  public node: Node
  public connection: Connection
  public guildId: string | undefined
  public voiceChannel: string | undefined
  public textChannel: string | undefined
  public current: Track | null = null
  public playing = false

  private connecting: Promise<Connection> | null = null
  private starting: Promise<this> | null = null

  constructor(aqua: AquaManager) {
    super()
    const node = aqua.nodesMap.get(aqua.nodes[0]?.name ?? '')
    if (!node?.connected || !node.sessionId) {
      throw new Error(
        'A connected node with a ready session is required to create a player.'
      )
    }
    this.aqua = aqua
    this.node = node
    this.queue = new Queue()
    this.connection = new Connection(aqua, this)
  }

  /** Joins voice and waits until the node accepts the Discord voice credentials. */
  public async connect(options: ConnectionOptions) {
    this.guildId = options.guildId
    this.voiceChannel = options.voiceChannel
    this.textChannel = options.textChannel
    this.connecting = this.connection.joinVoice(options)
    await this.connecting
    return this
  }

  /** Concurrent play calls share one request instead of consuming two tracks. */
  public play(): Promise<this> {
    if (this.starting) {
      return this.starting
    }
    this.starting = this.startTrack().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startTrack() {
    await this.connecting
    if (!this.connection.connected || !this.guildId) {
      throw new Error('Connect the player to voice before playing a track.')
    }
    if (this.playing) {
      return this
    }
    const track = this.queue.at(0)
    if (!track) {
      return this
    }

    this.current = track
    this.playing = true
    try {
      const response = await this.node.rest.updatePlayers(this.guildId, {
        track: { encoded: track.encoded }
      })
      if (response === undefined) {
        throw new Error('The node rejected the track update.')
      }
      this.queue.dequeue()
      return this
    } catch (error) {
      this.current = null
      this.playing = false
      throw error
    }
  }
}
