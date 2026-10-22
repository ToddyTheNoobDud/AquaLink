/** Server stats; frameStats may be absent or null while idle. */
export interface StatsLavalink {
  players: number
  playingPlayers: number
  /** Time since the server started, in milliseconds. */
  uptime: number
  /** Server memory values in bytes, separate from the bot process's memory. */
  memory: { free: number; used: number; allocated: number; reservable: number }
  cpu: { cores: number; systemLoad: number; lavalinkLoad: number }
  frameStats?: {
    sent: number
    nulled: number
    deficit: number
    expected?: number
  } | null
  [field: string]: unknown
}
/** NodeLink versions report processLoad or nodelinkLoad. Both stay intact. */
export interface StatsNodelink extends Omit<StatsLavalink, 'cpu'> {
  players: number
  playingPlayers: number
  uptime: number
  memory: StatsLavalink['memory']
  frameStats?: StatsLavalink['frameStats']
  cpu: {
    cores: number
    systemLoad: number
    processLoad?: number
    nodelinkLoad?: number
  }
  detailedStats?: {
    api: { requests: Record<string, number>; errors: Record<string, unknown> }
    sources: Record<string, number>
    playback: { events: Record<string, number> }
  }
}
export type NodeStats = StatsLavalink | StatsNodelink
export type LavalinkCpuStats = StatsLavalink['cpu']
export type NodelinkCpuStats = StatsNodelink['cpu']
export type NodeCpuStats = LavalinkCpuStats | NodelinkCpuStats
