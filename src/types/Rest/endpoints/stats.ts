/**
 * Lavalink stats without op. Time is in milliseconds, memory in bytes.
 * frameStats still needs a null case in this type. Node.stats starts as {},
 * so check the payload before treating it as StatsLavalink.
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
  /** Players connected to the node. */
  players: number
  /** Players playing a track. */
  playingPlayers: number
  /** Node uptime in milliseconds. */
  uptime: number
  /** Node memory stats, in bytes. */
  memory: {
    /** Free bytes. */
    free: number
    /** Used bytes. */
    used: number
    /** Allocated bytes. */
    allocated: number
    /** Reservable bytes. */
    reservable: number
  }
  /** Node CPU stats. */
  cpu: {
    /** Core count. */
    cores: number
    /** System load. */
    systemLoad: number
    /** Lavalink load. */
    lavalinkLoad: number
  }
  /** Frame counts; null isn't typed yet. */
  frameStats: {
    /** Frames sent to Discord. */
    sent: number
    /** Nulled frames. */
    nulled: number
    /** Difference between sent and expected frames. */
    deficit: number
  }
}

/**
 * NodeLink stats with cpu.nodelinkLoad and named request/source/event counters.
 * This draft requires memory, frameStats and cpu. Variants omitting them still
 * need their own types.
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
  /** NodeLink CPU stats, using nodelinkLoad. */
  cpu: Omit<StatsLavalink['cpu'], 'lavalinkLoad'> & {
    /** NodeLink load. */
    nodelinkLoad: number
  }

  /** Extra counters reported by the NodeLink server. */
  detailedStats: {
    /** Server API counters and error data. */
    api: {
      /** Counts by route. Missing keys return undefined; use ?? 0 for a zero fallback. */
      requests: Record<string, number>
      /** Error entries; value shapes aren't typed yet. */
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
