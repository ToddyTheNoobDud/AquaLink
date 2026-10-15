/**
 * Lavalink's /v4/info: server build and available features.
 * Check getInfo's result for Lavalink fields before reading JVM details.
 *
 * @example
 * ```ts
 * const info = await node.rest.getInfo()
 * if (info && 'jvm' in info) {
 *   const lavalink: LavalinkInfo = info
 *   console.log(lavalink.version.semver, lavalink.jvm)
 * }
 * ```
 */
export interface LavalinkInfo {
  /** Server version, separate from Aqua's version. */
  version: {
    /** Full version, including pre-release/build labels. */
    semver: string
    major: number
    minor: number
    patch: number
    /** Pre-release label, or null. */
    preRelease: string | null
    /** Build metadata, or null. */
    build: string | null
  }
  /** Build time, in milliseconds since Unix epoch. */
  buildTime: number
  /** Git revision used to build the server. */
  git: {
    branch: string
    commit: string
    /** Commit time, in milliseconds since Unix epoch. */
    commitTime: number
  }
  /** Java runtime version reported by Lavalink. */
  jvm: string
  /** Lavaplayer version used by the server. */
  lavaplayer: string
  /** Enabled sources. Individual track loads can still fail. */
  sourceManagers: string[]
  /** Filter names supported by this server. */
  filters: string[]
  /** Installed server plugins and their versions. */
  plugins: {
    name: string
    version: string
  }[]
}

/**
 * NodeLink info with Node/voice details in place of JVM/Lavaplayer fields.
 * Inherits version, sources, filters and plugins from LavalinkInfo. No runtime validation.
 *
 * @example
 * ```ts
 * const info = await node.rest.getInfo()
 * if (info && 'isNodelink' in info && info.isNodelink) {
 *   const nodelink: NodelinkInfo = info
 *   console.log(nodelink.node, nodelink.voice.version)
 * }
 * ```
 */
export interface NodelinkInfo extends Omit<LavalinkInfo, 'jvm' | 'lavaplayer'> {
  /** Node.js runtime version. */
  node: string
  /** Server's voice implementation name/version. */
  voice: {
    name: string
    version: string
  }
  /** NodeLink marker. Narrow the info union before reading it. */
  isNodelink: boolean
}
