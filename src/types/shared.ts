/**
 * shared modules for all, e.g: config, nodes, etc.
 */

export interface AquaOptions {
  none: string
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
