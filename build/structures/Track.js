'use strict'

const YT_ID_REGEX = /(?:[?&]v=|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/

const _h = {
  str: (v, d = '') => typeof v === 'string' ? v : d,
  num: (v, d = 0) => Number.isFinite(v) ? v : d
}

class Track {
  constructor(data = {}, requester = null, node = null) {
    const info = data.info || {}

    this.track = data.track || data.encoded || null
    this.identifier = _h.str(info.identifier)
    this.isSeekable = Boolean(info.isSeekable)
    this.author = _h.str(info.author)
    this.position = _h.num(info.position)
    this.duration = _h.num(info.length)
    this.isStream = Boolean(info.isStream)
    this.title = _h.str(info.title)
    this.uri = _h.str(info.uri)
    this.sourceName = _h.str(info.sourceName)
    this.artworkUrl = _h.str(info.artworkUrl)

    this.playlist = data.playlist || null
    this.node = node || data.node || null
    this.nodes = data.nodes || null
    this.requester = requester || null
    this._infoCache = null
  }

  get info() {
    return this._infoCache ||= Object.freeze({
      identifier: this.identifier,
      isSeekable: this.isSeekable,
      position: this.position,
      author: this.author,
      length: this.duration,
      isStream: this.isStream,
      title: this.title,
      uri: this.uri,
      sourceName: this.sourceName,
      artworkUrl: this.artworkUrl || this._computeArtwork()
    })
  }

  get length() {
    return this.duration
  }

  get thumbnail() {
    return this.artworkUrl || this._computeArtwork()
  }

  async resolve(aqua, opts = {}) {
    if (typeof this.track === 'string' && this.track) return this
    if (!aqua?.resolve) return null

    const platform = opts.platform || aqua?.options?.defaultSearchPlatform || 'ytsearch'
    const node = opts.node || this.node || this.nodes

    let query = this.uri
    if (!query) {
      if (this.title) {
        query = this.author ? `${this.author} - ${this.title}`.trim() : this.title.trim()
      } else if (this.identifier && this.sourceName?.toLowerCase().includes('youtube')) {
        query = this.identifier
      }
    }
    if (!query) return null

    const payload = { query, source: platform, requester: this.requester }
    if (node) payload.node = node

    let result
    try {
      result = await aqua.resolve(payload)
    } catch {
      return null
    }

    const found = result?.tracks?.[0]
    if (!found) return null

    const fi = found.info || {}

    this.track = typeof found.track === 'string' ? found.track : (found.encoded || this.track)
    this.identifier = fi.identifier ?? this.identifier
    this.title = fi.title ?? this.title
    this.author = fi.author ?? this.author
    this.uri = fi.uri ?? this.uri
    this.sourceName = fi.sourceName ?? this.sourceName
    this.artworkUrl = fi.artworkUrl ?? this.artworkUrl
    this.isSeekable = fi.isSeekable ?? this.isSeekable
    this.isStream = fi.isStream ?? this.isStream
    this.position = _h.num(fi.position, this.position)
    this.duration = _h.num(fi.length, this.duration)
    this.playlist = found.playlist ?? this.playlist
    this._infoCache = null

    return this
  }

  isValid() {
    return Boolean(
      (typeof this.track === 'string' && this.track) ||
      (typeof this.uri === 'string' && this.uri)
    )
  }

  dispose() {
    this._infoCache = this.requester = this.node = this.nodes = this.playlist = this.track = null
    this.identifier = this.author = this.title = this.uri = this.sourceName = this.artworkUrl = ''
  }

  _computeArtwork() {
    const id = this.identifier || (this.uri && YT_ID_REGEX.exec(this.uri)?.[1])
    return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null
  }
}

module.exports = Track