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
  /** The frame stats of the node. null if the node has no players or when retrieved via /v4/stats */
  frameStats: {
    /** The amount of frames sent to Discord */
    sent: number
    /** The amount of frames that were nulled */
    nulled: number
    /** The difference between sent frames and the expected amount of frames */
    deficit: number
  }
}

export interface StatsNodelink extends Omit<StatsLavalink, 'cpu'> {
  cpu: Omit<StatsLavalink['cpu'], 'lavalinkLoad'> & {
    nodelinkLoad: number
  }

  detailedStats: {
    api: {
      requests: Record<string, number>
      errors: Record<string, unknown>
    }
    sources: Record<string, number>
    playback: {
      events: Record<string, number>
    }
  }
}
