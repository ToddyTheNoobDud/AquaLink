'use strict'

const { Buffer } = require('node:buffer')
const { Agent: HttpsAgent, request: httpsRequest } = require('node:https')
const { Agent: HttpAgent, request: httpRequest } = require('node:http')
const http2 = require('node:http2')
const { createBrotliDecompress, createUnzip } = require('node:zlib')

const privateData = new WeakMap()

const BASE64_REGEX = /^[A-Za-z0-9+/=_-]+$/
const JSON_TYPE_REGEX = /application\/json/
const COMPRESSION_REGEX = /^(br|gzip|deflate)$/

const MAX_RESPONSE_SIZE = 10485760
const API_VERSION = 'v4'
const EMPTY_STRING = ''
const UTF8_ENCODING = 'utf8'
const JSON_CONTENT_TYPE = 'application/json'
const HTTP2_THRESHOLD = 1024

const ERRORS = Object.freeze({
  NO_SESSION: new Error('Session ID required'),
  INVALID_TRACK: new Error('Invalid encoded track format'),
  INVALID_TRACKS: new Error('One or more tracks have invalid format'),
  RESPONSE_TOO_LARGE: new Error('Response too large'),
  RESPONSE_ABORTED: new Error('Response aborted')
})

const _isValidBase64 = (str) => {
  if (typeof str !== 'string' || !str) return false
  const len = str.length
  return (len % 4 === 0 || (len % 4 !== 1 && /[-_]/.test(str))) && BASE64_REGEX.test(str)
}

const _fastBool = (b) => !!b

class Rest {
  constructor(aqua, node) {
    this.aqua = aqua
    this.node = node
    this.sessionId = node.sessionId
    this.timeout = node.timeout || 15000

    const protocol = node.ssl ? 'https:' : 'http:'
    const host = node.host.includes(':') && !node.host.startsWith('[') ? `[${node.host}]` : node.host
    this.baseUrl = `${protocol}//${host}:${node.port}`
    this._apiBase = `/${API_VERSION}`
    this._sessionPath = this.sessionId ? `${this._apiBase}/sessions/${this.sessionId}` : null

    this._endpoints = Object.freeze({
      loadtracks: `${this._apiBase}/loadtracks?identifier=`,
      decodetrack: `${this._apiBase}/decodetrack?encodedTrack=`,
      decodetracks: `${this._apiBase}/decodetracks`,
      stats: `${this._apiBase}/stats`,
      info: `${this._apiBase}/info`,
      version: `${this._apiBase}/version`,
      routeplanner: Object.freeze({
        status: `${this._apiBase}/routeplanner/status`,
        freeAddress: `${this._apiBase}/routeplanner/free/address`,
        freeAll: `${this._apiBase}/routeplanner/free/all`
      }),
      lyrics: `${this._apiBase}/lyrics`
    })

    this.defaultHeaders = Object.freeze({
      Authorization: String(node.auth || node.password || EMPTY_STRING),
      Accept: 'application/json, */*;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': `Aqualink/${aqua?.version || '1.0'} (Node.js ${process.version})`
    })
    this._headerPool = []
    this._setupAgent(node)
    this.useHttp2 = !!(aqua?.options?.useHttp2)
    this._h2 = null

    privateData.set(this, {
      cleanupCallbacks: new Set()
    })
  }

  _setupAgent(node) {
    const agentOpts = {
      keepAlive: true,
      maxSockets: node.maxSockets || 128,
      maxFreeSockets: node.maxFreeSockets || 64,
      freeSocketTimeout: node.freeSocketTimeout || 15000,
      keepAliveMsecs: node.keepAliveMsecs || 500,
      scheduling: 'lifo',
      timeout: this.timeout
    }

    if (node.ssl) {
      agentOpts.maxCachedSessions = node.maxCachedSessions || 200
      if (node.rejectUnauthorized !== undefined) agentOpts.rejectUnauthorized = node.rejectUnauthorized
      if (node.ca) agentOpts.ca = node.ca
      if (node.cert) agentOpts.cert = node.cert
      if (node.key) agentOpts.key = node.key
      if (node.passphrase) agentOpts.passphrase = node.passphrase
    }

    this.agent = new (node.ssl ? HttpsAgent : HttpAgent)(agentOpts)
    this.request = node.ssl ? httpsRequest : httpRequest
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId
    this._sessionPath = sessionId ? `${this._apiBase}/sessions/${sessionId}` : null
  }

  _getSessionPath() {
    if (!this._sessionPath) {
      if (!this.sessionId) throw ERRORS.NO_SESSION
      this._sessionPath = `${this._apiBase}/sessions/${this.sessionId}`
    }
    return this._sessionPath
  }

  _buildHeaders(hasPayload, payloadLength) {
    if (!hasPayload) return this.defaultHeaders

    let headers = this._headerPool.pop()
    if (!headers) {
      headers = {}
    }

    for (const key in headers) {
      delete headers[key]
    }

    headers.Authorization = this.defaultHeaders.Authorization
    headers.Accept = this.defaultHeaders.Accept
    headers['Accept-Encoding'] = this.defaultHeaders['Accept-Encoding']
    headers['User-Agent'] = this.defaultHeaders['User-Agent']
    headers['Content-Type'] = JSON_CONTENT_TYPE
    headers['Content-Length'] = payloadLength

    return headers
  }

  _returnHeadersToPool(headers) {
    if (headers !== this.defaultHeaders && this._headerPool.length < 10) {
      this._headerPool.push(headers)
    }
  }

  async makeRequest(method, endpoint, body) {
    const url = `${this.baseUrl}${endpoint}`
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    const payloadLength = payload ? Buffer.byteLength(payload, UTF8_ENCODING) : 0
    const headers = this._buildHeaders(!!payload, payloadLength)

    const useHttp2 = this.useHttp2 && payloadLength >= HTTP2_THRESHOLD

    try {
      return useHttp2
        ? await this._makeHttp2Request(method, endpoint, headers, payload)
        : await this._makeHttp1Request(method, url, headers, payload)
    } finally {

      this._returnHeadersToPool(headers)
    }
  }

  _makeHttp1Request(method, url, headers, payload) {
    return new Promise((resolve, reject) => {
      let req, timeoutId, resolved = false
      const chunks = []
      let totalSize = 0

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }

        chunks.length = 0
      }

      const complete = (isSuccess, value) => {
        if (resolved) return
        resolved = true
        cleanup()
        if (req && !isSuccess) req.destroy()
        isSuccess ? resolve(value) : reject(value)
      }

      req = this.request(url, { method, headers, agent: this.agent, timeout: this.timeout }, (res) => {
        cleanup()

        const status = res.statusCode
        if (status === 204) return res.resume(), complete(true, null)

        const contentLength = res.headers['content-length']
        if (contentLength === '0') return res.resume(), complete(true, null)
        if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) return complete(false, ERRORS.RESPONSE_TOO_LARGE)

        const encoding = (res.headers['content-encoding'] || EMPTY_STRING).split(',')[0].trim()
        let stream = res

        if (COMPRESSION_REGEX.test(encoding)) {
          const decompressor = encoding === 'br' ? createBrotliDecompress() : createUnzip()
          decompressor.once('error', err => complete(false, err))
          res.pipe(decompressor)
          stream = decompressor
        }

        res.once('aborted', () => complete(false, ERRORS.RESPONSE_ABORTED))
        res.once('error', err => complete(false, err))

        stream.on('data', chunk => {
          totalSize += chunk.length
          if (totalSize > MAX_RESPONSE_SIZE) return complete(false, ERRORS.RESPONSE_TOO_LARGE)
          chunks.push(chunk)
        })

        stream.once('end', () => {
          if (totalSize === 0) return complete(true, null)

          const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalSize)
          const text = buffer.toString(UTF8_ENCODING)

          let result = text
          const contentType = res.headers['content-type'] || EMPTY_STRING
          if (JSON_TYPE_REGEX.test(contentType)) {
            try {
              result = JSON.parse(text)
            } catch (err) {
              return complete(false, new Error(`JSON parse error: ${err.message}`))
            }
          }

          if (status >= 400) {
            const error = new Error(`HTTP ${status} ${method} ${url}`)
            error.statusCode = status
            error.statusMessage = res.statusMessage
            error.headers = res.headers
            error.body = result
            error.url = url
            return complete(false, error)
          }

          complete(true, result)
        })
      })

      req.once('error', err => complete(false, err))
      req.once('socket', socket => {
        socket.setNoDelay(true)
        socket.setKeepAlive(true, 500)
        if (socket.unref) socket.unref()
      })

      timeoutId = setTimeout(() => complete(false, new Error(`Request timeout: ${this.timeout}ms`)), this.timeout)
      payload ? req.end(payload) : req.end()
    })
  }

  async _makeHttp2Request(method, path, headers, payload) {

    if (!this._h2 || this._h2.closed || this._h2.destroyed) {
      this._h2 = http2.connect(this.baseUrl)
      this._h2.setTimeout(this.timeout, () => this._h2.close())
      this._h2.once('error', () => {
        this._h2 = null
      })
      this._h2.once('close', () => {
        this._h2 = null
      })
      if (this._h2.socket?.unref) this._h2.socket.unref()
    }

    return new Promise((resolve, reject) => {
      let req, timeoutId, resolved = false
      const chunks = []
      let totalSize = 0

      const complete = (isSuccess, value) => {
        if (resolved) return
        resolved = true
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }

        chunks.length = 0
        if (req && !isSuccess) req.close(http2.constants.NGHTTP2_CANCEL)
        isSuccess ? resolve(value) : reject(value)
      }

      const h = { ...headers, ':method': method, ':path': path }
      req = this._h2.request(h)

      req.once('response', respHeaders => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }

        const status = respHeaders[':status'] || 0
        const cl = respHeaders['content-length']
        if (status === 204 || cl === '0') return req.resume(), complete(true, null)
        if (cl && parseInt(cl, 10) > MAX_RESPONSE_SIZE) return req.resume(), complete(false, ERRORS.RESPONSE_TOO_LARGE)

        const enc = (respHeaders['content-encoding'] || EMPTY_STRING).split(',')[0].trim()
        const decompressor = COMPRESSION_REGEX.test(enc) ? (enc === 'br' ? createBrotliDecompress() : createUnzip()) : null
        const stream = decompressor ? req.pipe(decompressor) : req

        if (decompressor) decompressor.once('error', err => complete(false, err))
        req.once('error', err => complete(false, err))

        stream.on('data', chunk => {
          totalSize += chunk.length
          if (totalSize > MAX_RESPONSE_SIZE) return complete(false, ERRORS.RESPONSE_TOO_LARGE)
          chunks.push(chunk)
        })

        stream.once('end', () => {
          if (totalSize === 0) return complete(true, null)

          const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalSize)
          const text = buffer.toString(UTF8_ENCODING)

          let result
          try {
            result = JSON.parse(text)
          } catch (err) {
            return complete(false, new Error(`JSON parse error: ${err.message}`))
          }

          if (status >= 400) {
            const error = new Error(`HTTP ${status} ${method} ${this.baseUrl}${path}`)
            error.statusCode = status
            error.headers = respHeaders
            error.body = result
            error.url = this.baseUrl + path
            return complete(false, error)
          }

          complete(true, result)
        })
      })

      timeoutId = setTimeout(() => complete(false, new Error(`Request timeout: ${this.timeout}ms`)), this.timeout)
      payload ? req.end(payload) : req.end()
    })
  }

  async updatePlayer({ guildId, data, noReplace = false }) {
    const query = noReplace ? '?noReplace=true' : '?noReplace=false'
    return this.makeRequest('PATCH', `${this._getSessionPath()}/players/${guildId}${query}`, data)
  }

  async getPlayer(guildId) {
    return this.makeRequest('GET', `${this._getSessionPath()}/players/${guildId}`)
  }

  async getPlayers() {
    return this.makeRequest('GET', `${this._getSessionPath()}/players`)
  }

  async destroyPlayer(guildId) {
    return this.makeRequest('DELETE', `${this._getSessionPath()}/players/${guildId}`)
  }

  async loadTracks(identifier) {
    return this.makeRequest('GET', `${this._endpoints.loadtracks}${encodeURIComponent(identifier)}`)
  }

  async decodeTrack(encodedTrack) {
    if (!_isValidBase64(encodedTrack)) throw ERRORS.INVALID_TRACK
    return this.makeRequest('GET', `${this._endpoints.decodetrack}${encodeURIComponent(encodedTrack)}`)
  }

  async decodeTracks(encodedTracks) {
    if (!Array.isArray(encodedTracks) || encodedTracks.length === 0) throw ERRORS.INVALID_TRACKS
    for (const track of encodedTracks) {
      if (!_isValidBase64(track)) throw ERRORS.INVALID_TRACKS
    }
    return this.makeRequest('POST', this._endpoints.decodetracks, encodedTracks)
  }

  async getStats() {
    return this.makeRequest('GET', this._endpoints.stats)
  }

  async getInfo() {
    return this.makeRequest('GET', this._endpoints.info)
  }

  async getVersion() {
    return this.makeRequest('GET', this._endpoints.version)
  }

  async getRoutePlannerStatus() {
    return this.makeRequest('GET', this._endpoints.routeplanner.status)
  }

  async freeRoutePlannerAddress(address) {
    return this.makeRequest('POST', this._endpoints.routeplanner.freeAddress, { address })
  }

  async freeAllRoutePlannerAddresses() {
    return this.makeRequest('POST', this._endpoints.routeplanner.freeAll)
  }

  async getLyrics({ track, skipTrackSource = false }) {
    const guildId = track?.guild_id ?? track?.guildId
    const encoded = track?.encoded
    const hasEncoded = typeof encoded === 'string' && encoded.length > 0 && _isValidBase64(encoded)
    const title = track?.info?.title

    if (!track || (!guildId && !hasEncoded && !title)) {
      this.aqua?.emit?.('error', '[Aqua/Lyrics] Invalid track object')
      return null
    }

    const skipParam = _fastBool(skipTrackSource)

    if (guildId) {
      try {
        const lyrics = await this.makeRequest('GET', `${this._getSessionPath()}/players/${guildId}/track/lyrics?skipTrackSource=${skipParam}`)
        if (this._isValidLyrics(lyrics)) return lyrics
      } catch {}
    }

    if (hasEncoded) {
      try {
        const lyrics = await this.makeRequest('GET', `${this._endpoints.lyrics}?track=${encodeURIComponent(encoded)}&skipTrackSource=${skipParam}`)
        if (this._isValidLyrics(lyrics)) return lyrics
      } catch {}
    }

    if (title) {
      const author = track?.info?.author
      const query = author ? `${title} ${author}` : title
      try {
        const lyrics = await this.makeRequest('GET', `${this._endpoints.lyrics}/search?query=${encodeURIComponent(query)}`)
        if (this._isValidLyrics(lyrics)) return lyrics
      } catch {}
    }

    return null
  }

  _isValidLyrics(response) {
    if (!response) return false
    const type = typeof response
    if (type === 'string') return response.length > 0
    if (type === 'object') return Array.isArray(response) ? response.length > 0 : Object.keys(response).length > 0
    return false
  }

  async subscribeLiveLyrics(guildId, skipTrackSource = false) {
    try {
      const result = await this.makeRequest('POST', `${this._getSessionPath()}/players/${guildId}/lyrics/subscribe?skipTrackSource=${_fastBool(skipTrackSource)}`)
      return result === null
    } catch {
      return false
    }
  }

  async unsubscribeLiveLyrics(guildId) {
    try {
      const result = await this.makeRequest('DELETE', `${this._getSessionPath()}/players/${guildId}/lyrics/subscribe`)
      return result === null
    } catch {
      return false
    }
  }

  destroy() {
    const privateInfo = privateData.get(this)

    if (privateInfo?.cleanupCallbacks) {
      for (const callback of privateInfo.cleanupCallbacks) {
        try { callback() } catch {}
      }
      privateInfo.cleanupCallbacks.clear()
    }

    if (this.agent) {
      this.agent.destroy()
      this.agent = null
    }

    if (this._h2) {
      try { this._h2.close() } catch {}
      this._h2 = null
    }

    if (this._headerPool) {
      this._headerPool.length = 0
      this._headerPool = null
    }

    this.aqua = null
    this.node = null
    this.request = null
    this.defaultHeaders = null
    this._endpoints = null

    privateData.delete(this)
  }
}

module.exports = Rest
