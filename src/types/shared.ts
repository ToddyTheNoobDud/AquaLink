/**
 * shared modules for all, e.g: config, nodes, etc.
 */
import type { Level } from 'pino'

export interface AquaOptions {
  logging: {
    level: Level
  }
  nodeConfigs: {
    /** if the node goes down, keep retrying infinitely until it reconnects */
    infiniteReconnects: boolean
    /** Disabled when infiniteReconnects is true. If the node goes down, how much tries
     *  to reconnect to a node until it stops.
     */
    maxRetries: number
  }
}

export interface NodeOptions {
  /** name of the node. */
  name: string
  /** check if the node is secure, defaults to false. */
  ssl: boolean
  /** password of the node */
  password: string
  /** the host of the node. */
  host: string
  /** port of the host you want to connect */
  port: number
}
