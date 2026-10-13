/**
 * /v4/info from a Lavalink server. Describes the server build and available features.
 * getInfo can also return NodeLink info, so check the shape before using JVM fields.
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
  /** Server version details; not Aqua's package version. */
  version: {
    /** Full version string, including pre-release/build parts if present. */
    semver: string
    major: number
    minor: number
    patch: number
    /** Pre-release label, or null for a release without one. */
    preRelease: string | null
    /** Build metadata, or null if absent. */
    build: string | null
  }
  /** Server build timestamp, in milliseconds since Unix epoch. */
  buildTime: number
  /** Git revision used to build the server. */
  git: {
    branch: string
    commit: string
    /** Git commit timestamp, in milliseconds since Unix epoch. */
    commitTime: number
  }
  /** Java runtime version reported by Lavalink. */
  jvm: string
  /** Lavaplayer version used by the server. */
  lavaplayer: string
  /** Enabled source names. This doesn't guarantee a particular track will load. */
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
 * NodeLink's info shape: replaces the JVM/Lavaplayer fields with Node/voice details.
 * The shared version/source/filter/plugin fields come from LavalinkInfo.
 * These are types for the response, not a runtime validator.
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
  /** Node.js runtime version reported by NodeLink. */
  node: string
  /** Voice implementation name and version used by this server. */
  voice: {
    name: string
    version: string
  }
  /** Server's NodeLink marker; narrow the union before accessing it. */
  isNodelink: boolean
}
