import type Aqua from '../aqua/Aqua.ts'
import type Node from '../nodes/Node.ts'
import type {
  LavalinkInfo,
  NodelinkInfo
} from '../types/Rest/endpoints/info.ts'
import type { NodeStats } from '../types/Rest/endpoints/stats.ts'
import type {
  GetLyricsOptions,
  HttpMethod,
  LoadResult,
  LyricsResponse,
  Mix,
  MixerOptions,
  RemotePlayer,
  RoutePlannerStatus,
  SessionInfo,
  SessionUpdate,
  SponsorBlockOptions,
  SponsorBlockState,
  StreamOptions,
  TrackAPI,
  TrackData,
  TrackInfo,
  UpdatePlayerOptions
} from '../types/shared.ts'

/** Native fetch, one instance per node. makeRequest reads JSON/text; request returns Response.
 * Endpoint helpers use makeRequest unless they return a stream or metrics response.
 * Server-specific routes require that feature or plugin on the node.
 * @example await node.rest.makeRequest('/v4/sessions/id', 'PATCH', { resuming: true })
 */
export default class Rest {
  public timeout: number
  private controller = new AbortController()

  constructor(
    public aqua: Aqua,
    public nodes: Node
  ) {
    this.timeout = aqua.options?.restTimeout ?? 15000
  }

  get node() {
    return this.nodes
  }

  get sessionId() {
    return this.nodes.sessionId
  }

  get baseUrl() {
    return `${this.nodes.ssl ? 'https' : 'http'}://${this.nodes.host}:${this.nodes.port}`
  }

  /** Return Response without buffering it; timeout covers response headers.
   * The caller owns body consumption/cancellation; destroy also aborts active streams.
   * @example const response = await rest.request('/v4/trackstream?encodedTrack=...')
   */
  async request(
    path: string,
    method: HttpMethod = 'GET',
    body?: unknown,
    headers?: Record<string, string>
  ) {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new TypeError('Use a node-relative path starting with /.')
    }
    const requestHeaders = new Headers(headers)
    if (!requestHeaders.has('Authorization')) {
      requestHeaders.set('Authorization', this.nodes.password)
    }
    if (body !== undefined) {
      requestHeaders.set('Content-Type', 'application/json')
    }
    const deadline = new AbortController()
    const timer = setTimeout(
      () => deadline.abort(new Error('Node request timed out.')),
      this.timeout
    )
    timer.unref?.()
    let response: Response
    try {
      response = await fetch(this.baseUrl + path, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([this.controller.signal, deadline.signal])
      })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      const text = await response.text()
      let responseBody: unknown = text
      try {
        responseBody = JSON.parse(text)
      } catch {}
      throw Object.assign(
        new Error(
          `Node request failed: ${response.status} ${response.statusText}`
        ),
        {
          statusCode: response.status,
          statusMessage: response.statusText,
          headers: Object.fromEntries(response.headers),
          body: responseBody
        }
      )
    }
    return response
  }

  /** Read JSON/text. 204 returns null; request/parsing failures are logged and return undefined.
   * T describes the expected body; it doesn't validate JSON at runtime.
   * @example const info = await rest.makeRequest<NodeInfo>('/v4/info')
   */
  public async makeRequest<T = unknown>(
    path: string,
    method: HttpMethod = 'GET',
    body?: unknown
  ): Promise<T | null | undefined> {
    try {
      const response = await this.request(path, method, body)
      if (response.status === 204) {
        return null
      }
      if (response.headers.get('content-type')?.includes('json')) {
        return (await response.json()) as T
      }
      return (await response.text()) as T
    } catch (error) {
      this.aqua.logger.error({ err: error, path }, 'Node request failed.')
      return undefined
    }
  }

  /** Session paths require ready. Discord's voice session is a different ID. */
  playerPath(guildId?: string) {
    if (!this.sessionId) {
      throw new Error('Wait for node ready before using player routes.')
    }
    const path = `/v4/sessions/${encodeURIComponent(this.sessionId)}/players`
    if (guildId === undefined) {
      return path
    }

    return `${path}/${encodeURIComponent(guildId)}`
  }

  /** Read the server version as text, or undefined on failure. */
  getVersion() {
    return this.makeRequest<string>('/version')
  }

  /** Read server build/features. Narrow isNodelink before accessing NodeLink-only fields.
   * @example const info = await node.rest.getInfo()
   */
  getInfo() {
    return this.makeRequest<LavalinkInfo | NodelinkInfo>('/v4/info')
  }

  /** Read server stats. This doesn't overwrite node.stats from the WebSocket. */
  getStats() {
    return this.makeRequest<NodeStats>('/v4/stats')
  }

  /** Read remote players in this node session, without constructing local Player objects. */
  getPlayers() {
    return this.makeRequest<RemotePlayer[]>(this.playerPath())
  }

  /** Read one remote player. A ready session ID is required. */
  getPlayer(guildId: string) {
    return this.makeRequest<RemotePlayer>(this.playerPath(guildId))
  }

  /** Delete remote playback. Use player.destroy() to clean local state and leave Discord too. */
  destroyPlayer(guildId: string) {
    return this.makeRequest(this.playerPath(guildId), 'DELETE')
  }

  /** PATCH remote fields without mirroring local Player state. Default noReplace: false.
   * @example await rest.updatePlayer({ guildId, data: { paused: true } })
   */
  updatePlayer({ guildId, data, noReplace = false }: UpdatePlayerOptions) {
    return this.makeRequest<RemotePlayer>(
      `${this.playerPath(guildId)}?noReplace=${noReplace}`,
      'PATCH',
      data
    )
  }

  /** Configure server resuming for this ready session. timeout uses seconds.
   * @example await rest.updateSession({ resuming: true, timeout: 60 })
   */
  updateSession(options: SessionUpdate) {
    if (!this.sessionId) {
      throw new Error('Wait for node ready before updating its session.')
    }
    return this.makeRequest<SessionInfo>(
      `/v4/sessions/${encodeURIComponent(this.sessionId)}`,
      'PATCH',
      options
    )
  }

  /** Return the raw load result. Omit source to send identifiers as-is; explicit prefixes/URLs pass through.
   * Empty query/source returns undefined without sending a request.
   * @example const result = await rest.loadTracks('artist song', 'ytsearch')
   */
  loadTracks(query: string, source?: string) {
    if (!query || source === '') {
      return Promise.resolve(undefined)
    }
    const identifier =
      source && !/^[a-z][a-z\d+.-]*:/i.test(query)
        ? `${source}:${query}`
        : query
    return this.makeRequest<LoadResult>(
      `/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`
    )
  }

  /** Decode one encoded track on the server. Doesn't create a Track wrapper. */
  decodeTrack(encodedTrack: string) {
    return this.makeRequest<TrackAPI['track']>(
      `/v4/decodetrack?encodedTrack=${encodeURIComponent(encodedTrack)}`
    )
  }

  /** Decode an array of encoded tracks in one request. */
  decodeTracks(tracks: string[]) {
    return this.makeRequest<TrackAPI['track'][]>(
      '/v4/decodetracks',
      'POST',
      tracks
    )
  }

  /** Encode metadata using the server's /v4/encodetrack extension. */
  encodeTrack(track: TrackInfo) {
    return this.makeRequest<string>(
      `/v4/encodetrack?track=${encodeURIComponent(JSON.stringify(track))}`
    )
  }

  /** Send payloads to /v4/encodedtracks. Availability/response shape depend on the server. */
  encodeTracks(tracks: TrackData[]) {
    return this.makeRequest<unknown>('/v4/encodedtracks', 'POST', tracks)
  }

  /** Read the node's routeplanner state, if it exposes that API. */
  getRoutePlannerStatus() {
    return this.makeRequest<RoutePlannerStatus>('/v4/routeplanner/status')
  }

  /** Unmark one failed routeplanner IP address. */
  freeRoutePlannerAddress(address: string) {
    return this.makeRequest('/v4/routeplanner/free/address', 'POST', {
      address
    })
  }

  /** Unmark all failed routeplanner addresses. */
  freeAllRoutePlannerAddresses() {
    return this.makeRequest('/v4/routeplanner/free/all', 'POST')
  }

  /** NodeLink lyrics for an encoded track, with an optional language code. */
  getLoadLyrics(encodedTrack: string, lang?: string) {
    let path = `/v4/loadlyrics?encodedTrack=${encodeURIComponent(encodedTrack)}`
    if (lang) {
      path += `&lang=${encodeURIComponent(lang)}`
    }
    return this.makeRequest<LyricsResponse>(path)
  }

  /** Choose NodeLink or Lavalink-plugin lyrics after checking server info.
   * NodeLink needs track.encoded; the player-plugin route needs track.guild_id.
   * @example const lyrics = await rest.getLyrics({ track: { encoded, guild_id: guildId } })
   */
  async getLyrics({ track, skipTrackSource = false, lang }: GetLyricsOptions) {
    if (!this.nodes.info && !this.nodes.isNodelink) {
      const info = await this.getInfo()
      if (!info) {
        throw new Error('Fetch node info before choosing a lyrics API.')
      }
      this.nodes.info = info
      this.nodes.isNodelink = 'isNodelink' in info && info.isNodelink === true
    }
    if (this.nodes.isNodelink) {
      const encoded = track.encoded ?? track.track
      if (!encoded) {
        throw new Error('An encoded track is required for NodeLink lyrics.')
      }
      return this.getLoadLyrics(encoded, lang)
    }
    if (!track.guild_id) {
      throw new Error('A guild ID is required for player lyrics.')
    }
    return this.makeRequest<LyricsResponse>(
      `${this.playerPath(track.guild_id)}/track/lyrics?skipTrackSource=${skipTrackSource}`
    )
  }

  /** Subscribe the current player to server/plugin lyric events. Requires server support. */
  subscribeLiveLyrics(guildId: string, skipTrackSource = false) {
    return this.makeRequest(
      `${this.playerPath(guildId)}/lyrics/subscribe?skipTrackSource=${skipTrackSource}`,
      'POST'
    )
  }

  /** Stop the player's server/plugin lyric subscription. */
  unsubscribeLiveLyrics(guildId: string) {
    return this.makeRequest(
      `${this.playerPath(guildId)}/lyrics/subscribe`,
      'DELETE'
    )
  }

  /** Add a NodeLink mix. Resolve its track first; options.encoded is required.
   * @example const mix = await rest.addMixer(guildId, { encoded, volume: 50 })
   */
  addMixer(guildId: string, options: MixerOptions) {
    if (!options.encoded) {
      throw new Error('Resolve mixer identifiers to an encoded track first.')
    }
    return this.makeRequest<Mix>(`${this.playerPath(guildId)}/mix`, 'POST', {
      track: {
        encoded: options.encoded,
        ...(options.userData ? { userData: options.userData } : {})
      },
      volume: options.volume
    })
  }

  /** Read NodeLink mixes, accepting either a raw array or a { mixes } response. */
  async getActiveMixer(guildId: string) {
    const result = await this.makeRequest<Mix[] | { mixes: Mix[] }>(
      `${this.playerPath(guildId)}/mix`
    )
    return Array.isArray(result) ? result : result?.mixes
  }

  /** Change one NodeLink mix's volume by ID. */
  updateMixerVolume(guildId: string, mix: string, volume: number) {
    return this.makeRequest(
      `${this.playerPath(guildId)}/mix/${encodeURIComponent(mix)}`,
      'PATCH',
      { volume }
    )
  }

  /** Remove one NodeLink mix by ID. */
  removeMixer(guildId: string, mix: string) {
    return this.makeRequest(
      `${this.playerPath(guildId)}/mix/${encodeURIComponent(mix)}`,
      'DELETE'
    )
  }

  /** Read the player's server-side SponsorBlock configuration and segments. */
  getSponsorBlock(guildId: string) {
    return this.makeRequest<SponsorBlockState>(
      `${this.playerPath(guildId)}/sponsorblock`
    )
  }

  /** PATCH the player's SponsorBlock options on servers exposing this route. */
  updateSponsorBlock(guildId: string, data: SponsorBlockOptions) {
    return this.makeRequest<SponsorBlockState>(
      `${this.playerPath(guildId)}/sponsorblock`,
      'PATCH',
      data
    )
  }

  /** Ask the server to refresh SponsorBlock for this player. */
  refreshSponsorBlock(guildId: string) {
    return this.makeRequest<SponsorBlockState>(
      `${this.playerPath(guildId)}/sponsorblock`,
      'POST'
    )
  }

  /** Clear this player's server-side SponsorBlock state. */
  clearSponsorBlock(guildId: string) {
    return this.makeRequest(
      `${this.playerPath(guildId)}/sponsorblock`,
      'DELETE'
    )
  }

  /** Read the NodeLink connection/cluster response. */
  getConnection() {
    return this.makeRequest<Record<string, unknown>>('/v4/connection')
  }

  /** Read NodeLink worker information. The response is left unnormalized. */
  getWorkers() {
    return this.makeRequest<unknown>('/v4/workers')
  }

  /** Send a NodeLink worker action. Fields and accepted code values depend on the server. */
  patchWorker(data: {
    code: string
    id?: number
    clusterId?: number
    pid?: number
  }) {
    return this.makeRequest('/v4/workers', 'PATCH', data)
  }

  /** Update server-side YouTube credentials. Treat the supplied values as secrets. */
  updateYoutubeConfig(data: { refreshToken?: string; visitorData?: string }) {
    return this.makeRequest('/v4/youtube/config', 'PATCH', data)
  }

  /** Submit a refresh token to NodeLink's YouTube OAuth route. */
  youtubeOAuth(refreshToken: string) {
    return this.makeRequest<Record<string, unknown>>(
      '/v4/youtube/oauth',
      'POST',
      { refreshToken }
    )
  }

  /** Load chapter metadata for an encoded track on NodeLink. */
  loadChapters(encodedTrack: string) {
    return this.makeRequest<Record<string, unknown>>(
      `/v4/loadchapters?encodedTrack=${encodeURIComponent(encodedTrack)}`
    )
  }

  /** Load NodeLink track meaning metadata. Default language: en. */
  loadMeaning(encodedTrack: string, lang = 'en') {
    return this.makeRequest<Record<string, unknown>>(
      `/v4/meaning?encodedTrack=${encodeURIComponent(encodedTrack)}&lang=${encodeURIComponent(lang)}`
    )
  }

  /** Return a NodeLink track stream as Response. Consume or cancel response.body.
   * @example const response = await rest.trackStream(encoded)
   */
  trackStream(encodedTrack: string, itag?: number) {
    return this.request(
      `/v4/trackstream?encodedTrack=${encodeURIComponent(encodedTrack)}${itag === undefined ? '' : `&itag=${itag}`}`
    )
  }

  /** POST a NodeLink stream request and return Response without reading its body. */
  loadStream(options: StreamOptions) {
    return this.request('/v4/loadstream', 'POST', options)
  }

  /** Return the metrics Response. Optionally override the usual Authorization header. */
  getMetrics(authorization?: string) {
    return this.request(
      '/v4/metrics',
      'GET',
      undefined,
      authorization ? { Authorization: authorization } : undefined
    )
  }

  /** Aborts outstanding requests. A destroyed Rest instance cannot be reused. */
  destroy() {
    this.controller.abort(new Error('REST client destroyed.'))
  }
}
