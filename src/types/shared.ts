/**
 * shared modules for all, e.g: config, nodes, etc.
 */
import type { Level } from 'pino'

export interface AquaOptions {
  /** Sends a Discord gateway voice update through the consumer's Discord client. */
  send?: (payload: VoiceUpdatePayload) => void | Promise<void>
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

export interface VoiceUpdatePayload {
  op: 4
  d: {
    guild_id: string
    channel_id: string | null
    self_deaf: boolean
    self_mute: boolean
  }
}

export interface VoiceStateUpdate {
  guild_id?: string
  user_id: string
  session_id: string
  channel_id: string | null
}

export interface VoiceServerUpdate {
  guild_id: string
  token: string
  endpoint: string | null
}

export type VoicePacket =
  | { t: 'VOICE_STATE_UPDATE'; d: VoiceStateUpdate }
  | { t: 'VOICE_SERVER_UPDATE'; d: VoiceServerUpdate }

export interface VoiceInfo {
  token: string
  endpoint: string
  sessionId: string
  channelId: string
}

export interface PlayerUpdate {
  voice?: VoiceInfo
  track?: { encoded: string | null }
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

export interface TrackAPI {
  track: {
    encoded: string
    info: {
      identifier: string
      isSeekable: boolean
      author: string
      length: number
      isStream: boolean
      position: number
      title: string
      uri: string
      artworkUrl: string
      isrc: string
      sourceName: string
    }
  }
}

export type LoadResult =
  | {
      loadType: 'search'
      data: TrackAPI['track'][]
    }
  | {
      loadType: 'track' | 'playlist' | 'empty' | 'error'
      data: unknown
    }
