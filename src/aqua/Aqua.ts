import { EventEmitter } from 'node:events'
import pino, { type Logger } from 'pino'
import Node from '../nodes/Node.ts'
import type { AquaOptions, NodeOptions } from '../types/shared.ts'

/**
 * Here is what happens most of the stuff. For example, getting the configured
 * Node, userId, password, etc.
 */
export default class AquaManager extends EventEmitter {
  /** the client instance from your discord lib */
  public client: undefined
  /** Array of the configured nodes. */
  public nodes: NodeOptions[]
  /** Maps of the node, for get/identificatio/set usage */
  public nodesMap: Map<string, Node>
  /** Options (soon) */
  public options?: AquaOptions
  /** the clientId from init. */
  public clientId: string | null = null
  /** logging system, uses pino internally. */
  public logger: Logger
  /** check if the aqua instance has started. */
  public initiated: boolean

  // biome-ignore lint/suspicious/noExplicitAny: I don't know what client the user will use, so let it be any,
  constructor(client: any, nodes: NodeOptions[], options?: AquaOptions) {
    super()
    if (!client) throw new Error('Aqua needs a client for the 1st arg.')
    if (!Array.isArray(nodes) || !nodes.length)
      throw new Error('Aqua needs the nodes for the 2nd args.')

    this.client = client
    this.nodes = nodes
    if (options) this.options = options
    // id is key for finding the node, then the value is the node array
    this.nodesMap = new Map<string, Node>()

    this.clientId = null
    this.initiated = false
    this.logger = pino({
      level: this.options?.logging.level,
      transport: { target: 'pino-pretty' }
    })
  }

  /**
   * Starts aqualink, connects to the node, thats it.
   *
   * @example```ts
   * client.on('clientReady', () => {
   *    await client.aqua.init(client.id)
   * })
   * ```
   *
   * @param clientId - the clientId from your discord client. SHOULD be used on the 'ready' event.
   */
  public async init(clientId: string) {
    if (!clientId) {
      throw new Error(
        'clientId is required to start aqualink, please pass one.'
      )
    }

    this.clientId = clientId

    if (!this.nodes) {
      throw new Error(`For now, aqualink can't start without a node(s).`)
    }

    // for now i'll be limiting for 1 node only, i'll add multiple nodes later;

    if (this.nodes.length === 1) {
      await this.createNode()
    } else
      throw new Error('For now, aqualink is limited to 1 node per-instance.')

    this.logger.info(
      `Aqualink initiation was a sucess, in total, ${this.nodes.length} nodes were created.`
    )

    this.initiated = true
    return this
  }

  /**
   * Creates a new Node instance.
   *
   * @param aqua - this instance for aqua.
   * @param nodes - the configured nodes on aqua manager.
   */
  public async createNode() {
    // https://biomejs.dev/linter/rules/no-for-each/javascript/#description

    for (const nodeOptions of this.nodes) {
      const node = new Node(this, nodeOptions)
      if (!node.connected) await node.connect()
      this.logger.debug('CreateNode recived, now trying to connect.')
    }

    return this
  }
}

const client = 'mockclient'

const nodes = [
  {
    name: 'toddynlmao',
    host: '127.0.0.1',
    password: 'manialwaysforgettoupdatethisongithub',
    port: 50166,
    ssl: false
  }
]

const node = new AquaManager(client, nodes, {
  logging: {
    level: 'debug'
  }
})

node.init('1202232935311495209')
