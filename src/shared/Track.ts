import type Aqua from '../aqua/Aqua.ts'
import type Node from '../nodes/Node.ts'
import type {
  TrackData,
  TrackInfo,
  TrackResolutionOptions
} from '../types/shared.ts'

const emptyInfo: TrackInfo = {
  identifier: '',
  author: '',
  title: '',
  length: 0,
  position: 0,
  isSeekable: false,
  isStream: false,
  sourceName: '',
  uri: null,
  artworkUrl: null,
  isrc: null
}

/** Keeps the payload references, including plugin data. Flat properties are v3 aliases.
 * @example console.log(track.title, track.info.title) // same value
 */
export default class Track {
  public encoded: string | null
  public info: TrackInfo
  public pluginInfo: Record<string, unknown>
  public userData: Record<string, unknown> | null
  public requester: unknown
  public node: Node | null
  public nodes: Node | null
  public playlist: TrackData['playlist']

  constructor(
    data: TrackData = { info: { ...emptyInfo } },
    requester?: unknown,
    node?: Node
  ) {
    this.encoded = data.encoded ?? data.track ?? null
    this.info = data.info
    this.pluginInfo = data.pluginInfo ?? {}
    this.userData = data.userData ?? null
    this.requester = requester ?? data.requester ?? null
    this.node = node ?? data.node ?? null
    this.nodes = data.nodes ?? this.node
    this.playlist = data.playlist ?? null
  }

  get track() {
    return this.encoded
  }

  set track(value: string | null) {
    this.encoded = value
  }

  get identifier() {
    return this.info.identifier
  }

  set identifier(value: string) {
    this.info.identifier = value
  }

  get author() {
    return this.info.author
  }

  set author(value: string) {
    this.info.author = value
  }

  get title() {
    return this.info.title
  }

  set title(value: string) {
    this.info.title = value
  }

  get duration() {
    return this.info.length
  }

  set duration(value: number) {
    this.info.length = value
  }

  get length() {
    return this.info.length
  }

  get position() {
    return this.info.position
  }

  set position(value: number) {
    this.info.position = value
  }

  get uri() {
    return this.info.uri
  }

  set uri(value: string | null) {
    this.info.uri = value
  }

  get artworkUrl() {
    return this.info.artworkUrl
  }

  set artworkUrl(value: string | null) {
    this.info.artworkUrl = value
  }

  get isrc() {
    return this.info.isrc
  }

  set isrc(value: string | null) {
    this.info.isrc = value
  }

  get sourceName() {
    return this.info.sourceName
  }

  set sourceName(value: string) {
    this.info.sourceName = value
  }

  get isStream() {
    return this.info.isStream
  }

  set isStream(value: boolean) {
    this.info.isStream = value
  }

  get isSeekable() {
    return this.info.isSeekable
  }

  set isSeekable(value: boolean) {
    this.info.isSeekable = value
  }

  get thumbnail() {
    return (
      this.artworkUrl ??
      (this.sourceName.includes('youtube') && this.identifier
        ? `https://i.ytimg.com/vi/${this.identifier}/hqdefault.jpg`
        : null)
    )
  }

  /** Prefer the supplied artwork URL; otherwise use artworkUrl or the YouTube fallback. */
  resolveThumbnail(url?: string) {
    return url ?? this.thumbnail
  }

  /** Whether an encoded value or URI is present. Doesn't check playback availability. */
  isValid() {
    return Boolean(this.encoded || this.uri)
  }

  /** Omit node references and reduce requester objects with an id to an id:username string.
   * info/pluginInfo/userData stay shared; your metadata must be JSON-serializable.
   * @example const saved = JSON.stringify(track)
   */
  toJSON(): TrackData {
    const requester = this.requester
    const tag =
      requester && typeof requester === 'object' && 'id' in requester
        ? `${requester.id}:${'username' in requester ? requester.username : ''}`
        : requester
    return {
      encoded: this.encoded,
      info: this.info,
      pluginInfo: this.pluginInfo,
      userData: this.userData,
      requester: tag
    }
  }

  /** Resolve in place by URI or author/title when encoded is missing. Returns this or null.
   * Already encoded tracks are returned unchanged. Transport failures can reject.
   * @example const resolved = await track.resolve(aqua, { platform: 'scsearch' })
   */
  async resolve(aqua: Aqua, options: TrackResolutionOptions = {}) {
    if (this.encoded) {
      return this
    }
    const query = this.uri || `${this.author} ${this.title}`.trim()
    if (!query) {
      return null
    }
    const result = await aqua.resolve({
      query,
      source: options.platform,
      requester: this.requester,
      nodes: options.node ?? this.node ?? undefined
    })
    const found = result.tracks[0]
    if (!found) {
      return null
    }
    this.encoded = found.encoded
    this.info = found.info
    this.pluginInfo = found.pluginInfo
    return this
  }

  /** Release this wrapper's references. Don't dispose a track still shared by another player. */
  dispose() {
    this.encoded = null
    this.info = { ...emptyInfo }
    this.requester = null
    this.node = null
    this.nodes = null
    this.playlist = null
    this.userData = null
    this.pluginInfo = {}
  }
}
