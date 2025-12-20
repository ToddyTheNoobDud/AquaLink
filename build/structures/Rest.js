const { Buffer } = require('buffer')
const { Agent: HttpsAgent, request: httpsRequest } = require('https')
const { Agent: HttpAgent, request: httpRequest } = require('http')
const http2 = require('http2')
const { createBrotliDecompress, createUnzip, brotliDecompressSync, unzipSync } = require('zlib')

const BASE64_LOOKUP = new Uint8Array(256)
for (let i = 65; i <= 90; i++) BASE64_LOOKUP[i] = 1
for (let i = 97; i <= 122; i++) BASE64_LOOKUP[i] = 1
for (let i = 48; i <= 57; i++) BASE64_LOOKUP[i] = 1
BASE64_LOOKUP[43] = BASE64_LOOKUP[47] = BASE64_LOOKUP[61] = BASE64_LOOKUP[95] = BASE64_LOOKUP[45] = 1

const ENCODING_NONE = 0, ENCODING_BR = 1, ENCODING_GZIP = 2, ENCODING_DEFLATE = 3
const MAX_RESPONSE_SIZE = 10485760
const SMALL_RESPONSE_THRESHOLD = 512
const COMPRESSION_MIN_SIZE = 1024
const API_VERSION = 'v4'
const UTF8 = 'utf8'
const JSON_CT = 'application/json'
const HTTP2_THRESHOLD = 1024
const MAX_HEADER_POOL = 10
const H2_TIMEOUT = 60000

const ERRORS = Object.freeze({
  NO_SESSION: new Error('Session ID required'),
  INVALID_TRACK: new Error('Invalid encoded track format'),
  INVALID_TRACKS: new Error('One or more tracks have invalid format'),
  RESPONSE_TOO_LARGE: new Error('Response too large'),
  RESPONSE_ABORTED: new Error('Response aborted')
})

const _functions = {
  isValidBase64(str) {
    if (typeof str !== 'string' || !str) return false
    const len = str.length
    if (len % 4 === 1) return false
    for (let i = 0; i < len; i++) {
      if (!BASE64_LOOKUP[str.charCodeAt(i)]) return false
    }
    return true
  },

  getEncodingType(header) {
    if (!header) return ENCODING_NONE
    const c = header.charCodeAt(0)
    if (c === 98 && header.startsWith('br')) return ENCODING_BR
    if (c === 103 && header.startsWith('gzip')) return ENCODING_GZIP
    if (c === 100 && header.startsWith('deflate')) return ENCODING_DEFLATE
    return ENCODING_NONE
  },

  isJsonContent(ct) {
    return ct && ct.charCodeAt(0) === 97 && ct.includes(JSON_CT)
  },

  parseBody(text, contentType, forceJson) {
    return (forceJson || this.isJsonContent(contentType)) ? JSON.parse(text) : text
  },

  createHttpError(status, method, url, headers, body, statusMessage) {
    const err = new Error(`HTTP ${status} ${method} ${url}`)
    err.statusCode = status
    err.headers = headers
    err.body = body
    err.url = url
    if (statusMessage !== undefined) err.statusMessage = statusMessage
    return err
  },

  createDecompressor(type) {
    return type === ENCODING_BR ? createBrotliDecompress() : createUnzip()
  },

  decompressSync(buf, type) {
    return type === ENCODING_BR ? brotliDecompressSync(buf) : unzipSync(buf)
  }
}

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
      Authorization: String(node.auth || node.password || ''),
      Accept: 'application/json, */*;q=0.5',
      'Accept-Encoding': 'br, gzip, deflate',
      'User-Agent': `Aqualink/${aqua?.version || '1.0'} (Node.js ${process.version})`
    })

    this._headerPool = []
    this._setupAgent(node)
    this.useHttp2 = !!(aqua?.options?.useHttp2)
    this._h2 = null
    this._h2Timer = null
  }

  _setupAgent(node) {
    const opts = {
      keepAlive: true,
      maxSockets: node.maxSockets || 128,
      maxFreeSockets: node.maxFreeSockets || 64,
      freeSocketTimeout: node.freeSocketTimeout || 15000,
      keepAliveMsecs: node.keepAliveMsecs || 500,
      scheduling: 'lifo',
      timeout: this.timeout
    }

    if (node.ssl) {
      opts.maxCachedSessions = node.maxCachedSessions || 200
      if (node.rejectUnauthorized !== undefined) opts.rejectUnauthorized = node.rejectUnauthorized
      if (node.ca) opts.ca = node.ca
      if (node.cert) opts.cert = node.cert
      if (node.key) opts.key = node.key
      if (node.passphrase) opts.passphrase = node.passphrase
    }

    this.agent = new (node.ssl ? HttpsAgent : HttpAgent)(opts)
    this.request = node.ssl ? httpsRequest : httpRequest

    const origCreate = this.agent.createConnection.bind(this.agent)
    this.agent.createConnection = (options, cb) => {
      const socket = origCreate(options, cb)
      socket.setNoDelay(true)
      socket.setKeepAlive(true, 500)
      return socket
    }
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId
  }

  _getSessionPath() {
    if (!this.sessionId) throw ERRORS.NO_SESSION
    return `${this._apiBase}/sessions/${this.sessionId}`
  }

  _buildHeaders(hasPayload, payloadLength) {
    if (!hasPayload) return this.defaultHeaders
    let h = this._headerPool.pop() || Object.create(null)
    h.Authorization = this.defaultHeaders.Authorization
    h.Accept = this.defaultHeaders.Accept
    h['Accept-Encoding'] = this.defaultHeaders['Accept-Encoding']
    h['User-Agent'] = this.defaultHeaders['User-Agent']
    h['Content-Type'] = JSON_CT
    h['Content-Length'] = payloadLength
    return h
  }

  _returnHeaders(h) {
    if (h !== this.defaultHeaders && this._headerPool.length < MAX_HEADER_POOL) {
      h.Authorization = h.Accept = h['Accept-Encoding'] = h['User-Agent'] = h['Content-Type'] = h['Content-Length'] = null
      this._headerPool.push(h)
    }
  }

  async makeRequest(method, endpoint, body) {
    const url = `${this.baseUrl}${endpoint}`
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    const payloadLen = payload ? Buffer.byteLength(payload, UTF8) : 0
    const headers = this._buildHeaders(!!payload, payloadLen)

    try {
      return this.useHttp2 && payloadLen >= HTTP2_THRESHOLD
        ? await this._h2Request(method, endpoint, headers, payload)
        : await this._h1Request(method, url, headers, payload)
    } finally {
      this._returnHeaders(headers)
    }
  }

  _h1Request(method, url, headers, payload) {
    return new Promise((resolve, reject) => {
      let req, timer, done = false, chunks = [], size = 0, prealloc = null

      const finish = (ok, val) => {
        if (done) return
        done = true
        if (timer) { clearTimeout(timer); timer = null }
        chunks = prealloc = null
        if (req && !ok) req.destroy()
        ok ? resolve(val) : reject(val)
      }

      req = this.request(url, { method, headers, agent: this.agent, timeout: this.timeout }, (res) => {
        if (timer) { clearTimeout(timer); timer = null }

        const status = res.statusCode
        const cl = res.headers['content-length']
        const contentType = res.headers['content-type'] || ''

        if (status === 204 || cl === '0') {
          res.resume()
          return finish(true, null)
        }

        const clInt = cl ? parseInt(cl, 10) : 0
        if (clInt > MAX_RESPONSE_SIZE) {
          res.resume()
          return finish(false, ERRORS.RESPONSE_TOO_LARGE)
        }

        const encoding = _functions.getEncodingType(res.headers['content-encoding'])

        const handleResponse = (buffer) => {
          const text = buffer.toString(UTF8)
          try {
            const result = _functions.parseBody(text, contentType, false)
            if (status >= 400) {
              finish(false, _functions.createHttpError(status, method, url, res.headers, result, res.statusMessage))
            } else {
              finish(true, result)
            }
          } catch (e) {
            finish(false, new Error(`JSON parse error: ${e.message}`))
          }
        }

        if (clInt > 0 && clInt < SMALL_RESPONSE_THRESHOLD && encoding === ENCODING_NONE) {
          res.once('data', handleResponse)
          res.once('error', (e) => finish(false, e))
          return
        }

        if (encoding !== ENCODING_NONE && clInt > 0 && clInt < COMPRESSION_MIN_SIZE) {
          const compressed = []
          res.on('data', (c) => compressed.push(c))
          res.once('end', () => {
            try {
              handleResponse(_functions.decompressSync(Buffer.concat(compressed), encoding))
            } catch (e) {
              finish(false, e)
            }
          })
          res.once('error', (e) => finish(false, e))
          return
        }

        if (clInt > 0 && clInt <= MAX_RESPONSE_SIZE) prealloc = Buffer.allocUnsafe(clInt)
        chunks = []

        let stream = res
        if (encoding !== ENCODING_NONE) {
          const decomp = _functions.createDecompressor(encoding)
          decomp.once('error', (e) => finish(false, e))
          res.pipe(decomp)
          stream = decomp
        }

        res.once('aborted', () => finish(false, ERRORS.RESPONSE_ABORTED))
        res.once('error', (e) => finish(false, e))

        stream.on('data', (chunk) => {
          if (prealloc) {
            chunk.copy(prealloc, size)
            size += chunk.length
          } else {
            size += chunk.length
            if (size > MAX_RESPONSE_SIZE) return finish(false, ERRORS.RESPONSE_TOO_LARGE)
            chunks.push(chunk)
          }
        })

        stream.once('end', () => {
          if (size === 0) return finish(true, null)
          handleResponse(prealloc ? prealloc.slice(0, size) : (chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size)))
        })
      })

      req.once('error', (e) => finish(false, e))
      timer = setTimeout(() => finish(false, new Error(`Request timeout: ${this.timeout}ms`)), this.timeout)
      payload ? req.end(payload) : req.end()
    })
  }

  _getH2Session() {
    if (!this._h2 || this._h2.closed || this._h2.destroyed) {
      this._clearH2()
      this._h2 = http2.connect(this.baseUrl)
      this._h2Timer = setTimeout(() => this._closeH2(), H2_TIMEOUT)
      this._h2Timer.unref()
      const onEnd = () => this._clearH2()
      this._h2.once('error', onEnd)
      this._h2.once('close', onEnd)
      this._h2.socket?.unref?.()
    }
    return this._h2
  }

  _clearH2() {
    if (this._h2Timer) { clearTimeout(this._h2Timer); this._h2Timer = null }
    this._h2 = null
  }

  _closeH2() {
    if (this._h2Timer) { clearTimeout(this._h2Timer); this._h2Timer = null }
    if (this._h2) { try { this._h2.close() } catch {} this._h2 = null }
  }

  _h2Request(method, path, headers, payload) {
    const session = this._getH2Session()

    return new Promise((resolve, reject) => {
      let req, timer, done = false, chunks = [], size = 0, prealloc = null

      const finish = (ok, val) => {
        if (done) return
        done = true
        if (timer) { clearTimeout(timer); timer = null }
        chunks = prealloc = null
        if (req && !ok) req.close(http2.constants.NGHTTP2_CANCEL)
        ok ? resolve(val) : reject(val)
      }

      const h2h = {
        ':method': method,
        ':path': path,
        Authorization: headers.Authorization,
        Accept: headers.Accept,
        'Accept-Encoding': headers['Accept-Encoding'],
        'User-Agent': headers['User-Agent']
      }
      if (headers['Content-Type']) h2h['Content-Type'] = headers['Content-Type']
      if (headers['Content-Length']) h2h['Content-Length'] = headers['Content-Length']

      req = session.request(h2h)

      req.once('response', (rh) => {
        if (timer) { clearTimeout(timer); timer = null }

        const status = rh[':status'] || 0
        const cl = rh['content-length']

        if (status === 204 || cl === '0') {
          req.resume()
          return finish(true, null)
        }

        const clInt = cl ? parseInt(cl, 10) : 0
        if (clInt > MAX_RESPONSE_SIZE) {
          req.resume()
          return finish(false, ERRORS.RESPONSE_TOO_LARGE)
        }

        if (clInt > 0 && clInt <= MAX_RESPONSE_SIZE) prealloc = Buffer.allocUnsafe(clInt)

        const encoding = _functions.getEncodingType(rh['content-encoding'])
        const decomp = encoding !== ENCODING_NONE ? _functions.createDecompressor(encoding) : null
        const stream = decomp ? req.pipe(decomp) : req

        if (decomp) decomp.once('error', (e) => finish(false, e))
        req.once('error', (e) => finish(false, e))

        stream.on('data', (chunk) => {
          if (prealloc) {
            chunk.copy(prealloc, size)
            size += chunk.length
          } else {
            size += chunk.length
            if (size > MAX_RESPONSE_SIZE) return finish(false, ERRORS.RESPONSE_TOO_LARGE)
            chunks.push(chunk)
          }
        })

        stream.once('end', () => {
          if (size === 0) return finish(true, null)
          const buffer = prealloc ? prealloc.slice(0, size) : (chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size))
          try {
            const result = JSON.parse(buffer.toString(UTF8))
            if (status >= 400) {
              finish(false, _functions.createHttpError(status, method, this.baseUrl + path, rh, result))
            } else {
              finish(true, result)
            }
          } catch (e) {
            finish(false, new Error(`JSON parse error: ${e.message}`))
          }
        })
      })

      timer = setTimeout(() => finish(false, new Error(`Request timeout: ${this.timeout}ms`)), this.timeout)
      payload ? req.end(payload) : req.end()
    })
  }

  async updatePlayer({ guildId, data, noReplace = false }) {
    return this.makeRequest('PATCH', `${this._getSessionPath()}/players/${guildId}?noReplace=${noReplace}`, data)
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
    if (!_functions.isValidBase64(encodedTrack)) throw ERRORS.INVALID_TRACK
    return this.makeRequest('GET', `${this._endpoints.decodetrack}${encodeURIComponent(encodedTrack)}`)
  }

  async decodeTracks(encodedTracks) {
    if (!Array.isArray(encodedTracks) || !encodedTracks.length) throw ERRORS.INVALID_TRACKS
    for (let i = 0; i < encodedTracks.length; i++) {
      if (!_functions.isValidBase64(encodedTracks[i])) throw ERRORS.INVALID_TRACKS
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
    const hasEncoded = typeof encoded === 'string' && encoded.length > 0 && _functions.isValidBase64(encoded)
    const title = track?.info?.title

    if (!track || (!guildId && !hasEncoded && !title)) {
      this.aqua?.emit?.('error', '[Aqua/Lyrics] Invalid track object')
      return null
    }

    const skip = skipTrackSource ? 'true' : 'false'

    if (guildId) {
      try {
        const lyrics = await this.makeRequest('GET', `${this._getSessionPath()}/players/${guildId}/track/lyrics?skipTrackSource=${skip}`)
        if (this._validLyrics(lyrics)) return lyrics
      } catch {}
    }

    if (hasEncoded) {
      try {
        const lyrics = await this.makeRequest('GET', `${this._endpoints.lyrics}?track=${encodeURIComponent(encoded)}&skipTrackSource=${skip}`)
        if (this._validLyrics(lyrics)) return lyrics
      } catch {}
    }

    if (title) {
      const query = track?.info?.author ? `${title} ${track.info.author}` : title
      try {
        const lyrics = await this.makeRequest('GET', `${this._endpoints.lyrics}/search?query=${encodeURIComponent(query)}`)
        if (this._validLyrics(lyrics)) return lyrics
      } catch {}
    }

    return null
  }

  _validLyrics(r) {
    if (!r) return false
    if (typeof r === 'string') return r.length > 0
    if (typeof r === 'object') return Array.isArray(r) ? r.length > 0 : Object.keys(r).length > 0
    return false
  }

  async subscribeLiveLyrics(guildId, skipTrackSource = false) {
    try {
      return await this.makeRequest('POST', `${this._getSessionPath()}/players/${guildId}/lyrics/subscribe?skipTrackSource=${skipTrackSource ? 'true' : 'false'}`) === null
    } catch {
      return false
    }
  }

  async unsubscribeLiveLyrics(guildId) {
    try {
      return await this.makeRequest('DELETE', `${this._getSessionPath()}/players/${guildId}/lyrics/subscribe`) === null
    } catch {
      return false
    }
  }

  destroy() {
    if (this.agent) { this.agent.destroy(); this.agent = null }
    this._closeH2()
    if (this._headerPool) { this._headerPool.length = 0; this._headerPool = null }
    this.aqua = this.node = this.request = this.defaultHeaders = this._endpoints = null
  }
}

module.exports = Rest