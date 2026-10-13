/**
 * Lavalink stats payload after removing the WebSocket op field.
 * Time is in milliseconds and memory is in bytes.
 * frameStats can be null in the protocol, but this draft still requires an object.
 * Node.stats also starts as {}, so check the received shape before treating it as this.
 * @see https://lavalink.dev/api/websocket#stats-op
 *
 * @example
 * ```ts
 * const stats: StatsLavalink = {
 *   players: 1, playingPlayers: 1, uptime: 60000,
 *   memory: { free: 1024, used: 2048, allocated: 4096, reservable: 8192 },
 *   cpu: { cores: 4, systemLoad: 0.2, lavalinkLoad: 0.1 },
 *   frameStats: { sent: 3000, nulled: 0, deficit: 0 }
 * }
 * console.log(stats.memory.used / 1024 / 1024) // bytes to MiB
 * ```
 */
export interface StatsLavalink {
  /** The amount of players connected to the node */
  players: number
  /** The amount of players playing a track */
  playingPlayers: number
  /** The uptime of the node in milliseconds */
  uptime: number
  /** The memory stats of the node */
  memory: {
    /**	The amount of free memory in bytes */
    free: number
    /** The amount of used memory in bytes */
    used: number
    /** The amount of allocated memory in bytes */
    allocated: number
    /** The amount of reservable memory in bytes */
    reservable: number
  }
  /** The cpu stats of the node */
  cpu: {
    /** The amount of cores the node has */
    cores: number
    /** The system load of the node */
    systemLoad: number
    /** The load of Lavalink on the node */
    lavalinkLoad: number
  }
  /** Frame counts. Protocol null still needs to be represented by this type. */
  frameStats: {
    /** The amount of frames sent to Discord */
    sent: number
    /** The amount of frames that were nulled */
    nulled: number
    /** The difference between sent frames and the expected amount of frames */
    deficit: number
  }
}

/**
 * Current NodeLink stats draft: nodelinkLoad replaces cpu.lavalinkLoad.
 * detailedStats keeps request/source/event counters keyed by their names.
 * This still requires inherited memory/frameStats and cpu; payload variants that
 * omit those fields need their own typing instead of assuming they're always there.
 *
 * @example
 * ```ts
 * const stats: StatsNodelink = {
 *   ...lavalinkStats,
 *   cpu: { cores: 4, systemLoad: 0.2, nodelinkLoad: 0.1 },
 *   detailedStats: {
 *     api: { requests: { '/v4/loadtracks': 150 }, errors: {} },
 *     sources: { youtube: 120 },
 *     playback: { events: { TrackStartEvent: 100 } }
 *   }
 * }
 * console.log(stats.detailedStats.api.requests['/v4/loadtracks'] ?? 0)
 * ```
 */
export interface StatsNodelink extends Omit<StatsLavalink, 'cpu'> {
  /** NodeLink CPU stats; use nodelinkLoad, not lavalinkLoad. */
  cpu: Omit<StatsLavalink['cpu'], 'lavalinkLoad'> & {
    /** Load value reported by NodeLink. */
    nodelinkLoad: number
  }

  /** Extra NodeLink counters; not client-side benchmark measurements. */
  detailedStats: {
    /** Server API counters and error data. */
    api: {
      /** Counts by route; an absent key returns undefined, so use ?? 0 if needed. */
      requests: Record<string, number>
      /** Server error entries. Value shapes aren't typed yet. */
      errors: Record<string, unknown>
    }
    /** Counts keyed by source name. */
    sources: Record<string, number>
    /** Server playback event counters. */
    playback: {
      /** Counts keyed by event type, for example TrackStartEvent. */
      events: Record<string, number>
    }
  }
}
