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

const ENCODING_BR = 1
const ENCODING_GZIP = 2
const ENCODING_DEFLATE = 3
const ENCODING_NONE = 0

const MAX_RESPONSE_SIZE = 10485760
const SMALL_RESPONSE_THRESHOLD = 512
const COMPRESSION_MIN_SIZE = 1024
const API_VERSION = 'v4'
const UTF8_ENCODING = 'utf8'
const JSON_CONTENT_TYPE = 'application/json'
const HTTP2_THRESHOLD = 1024
const MAX_HEADER_POOL = 10

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
  if (len % 4 === 1) return false
  for (let i = 0; i < len; i++) {
    if (!BASE64_LOOKUP[str.charCodeAt(i)]) return false
  }
  return true
}

const _getEncodingType = (encodingHeader) => {
  if (!encodingHeader) return ENCODING_NONE
  const firstChar = encodingHeader.charCodeAt(0)
  if (firstChar === 98 && encodingHeader.startsWith('br')) return ENCODING_BR
  if (firstChar === 103 && encodingHeader.startsWith('gzip')) return ENCODING_GZIP
  if (firstChar === 100 && encodingHeader.startsWith('deflate')) return ENCODING_DEFLATE
  return ENCODING_NONE
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
    this._h2CleanupTimer = null
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

    const origCreateConnection = this.agent.createConnection
    this.agent.createConnection = (options, callback) => {
      const socket = origCreateConnection.call(this.agent, options, callback)
      socket.setNoDelay(true)
      socket.setKeepAlive(true, 500)
      socket.unref?.()
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

    let headers = this._headerPool.pop()
    if (!headers) headers = Object.create(null)

    headers.Authorization = this.defaultHeaders.Authorization
    headers.Accept = this.defaultHeaders.Accept
    headers['Accept-Encoding'] = this.defaultHeaders['Accept-Encoding']
    headers['User-Agent'] = this.defaultHeaders['User-Agent']
    headers['Content-Type'] = JSON_CONTENT_TYPE
    headers['Content-Length'] = payloadLength

    return headers
  }

  _returnHeadersToPool(headers) {
    if (headers !== this.defaultHeaders && this._headerPool.length < MAX_HEADER_POOL) {
      headers.Authorization = null
      headers.Accept = null
      headers['Accept-Encoding'] = null
      headers['User-Agent'] = null
      headers['Content-Type'] = null
      headers['Content-Length'] = null
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
      let req = null
      let timeoutId = null
      let resolved = false
      let chunks = []
      let totalSize = 0
      let preallocatedBuffer = null

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        chunks = null
        preallocatedBuffer = null
      }

      const complete = (isSuccess, value) => {
        if (resolved) return;
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

        const clInt = contentLength ? parseInt(contentLength, 10) : 0
        if (clInt > MAX_RESPONSE_SIZE) {
          res.resume()
          return complete(false, ERRORS.RESPONSE_TOO_LARGE)
        }

        const encodingType = _getEncodingType(res.headers['content-encoding'])

        if (clInt > 0 && clInt < SMALL_RESPONSE_THRESHOLD && encodingType === ENCODING_NONE) {
          res.once('data', (chunk) => {
            const text = chunk.toString(UTF8_ENCODING)
            let result = text
            const contentType = res.headers['content-type'] || ''

            if (contentType.charCodeAt(0) === 97 && contentType.includes('application/json')) {
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
          res.once('error', (err) => complete(false, err))
          return;
        }

        if (clInt > 0 && clInt <= MAX_RESPONSE_SIZE) {
          preallocatedBuffer = Buffer.allocUnsafe(clInt)
          chunks = []
        } else {
          chunks = []
        }

        let stream = res

        if (encodingType !== ENCODING_NONE) {
          if (clInt > 0 && clInt < COMPRESSION_MIN_SIZE) {
            const compressedChunks = []
            res.on('data', (chunk) => compressedChunks.push(chunk))
            res.once('end', () => {
              try {
                const compressed = Buffer.concat(compressedChunks)
                const decompressed = encodingType === ENCODING_BR
                  ? brotliDecompressSync(compressed)
                  : unzipSync(compressed)
                const text = decompressed.toString(UTF8_ENCODING)
                let result = text
                const contentType = res.headers['content-type'] || ''

                if (contentType.charCodeAt(0) === 97 && contentType.includes('application/json')) {
                  result = JSON.parse(text)
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
              } catch (err) {
                complete(false, err)
              }
            })
            res.once('error', (err) => complete(false, err))
            return;
          } else {
            const decompressor = encodingType === ENCODING_BR ? createBrotliDecompress() : createUnzip()
            decompressor.once('error', (err) => complete(false, err))
            res.pipe(decompressor)
            stream = decompressor
          }
        }

        res.once('aborted', () => complete(false, ERRORS.RESPONSE_ABORTED))
        res.once('error', (err) => complete(false, err))

        stream.on('data', (chunk) => {
          if (preallocatedBuffer) {
            chunk.copy(preallocatedBuffer, totalSize)
            totalSize += chunk.length
          } else {
            totalSize += chunk.length
            if (totalSize > MAX_RESPONSE_SIZE) return complete(false, ERRORS.RESPONSE_TOO_LARGE)
            chunks.push(chunk)
          }
        })

        stream.once('end', () => {
          if (totalSize === 0) return complete(true, null)

          const buffer = preallocatedBuffer
            ? preallocatedBuffer.slice(0, totalSize)
            : (chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalSize))
          const text = buffer.toString(UTF8_ENCODING)
          let result = text
          const contentType = res.headers['content-type'] || ''

          if (contentType.charCodeAt(0) === 97 && contentType.includes('application/json')) {
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

      req.once('error', (err) => complete(false, err))
      timeoutId = setTimeout(() => complete(false, new Error(`Request timeout: ${this.timeout}ms`)), this.timeout)
      payload ? req.end(payload) : req.end()
    })
  }

  _getOrCreateHttp2Session() {
    if (!this._h2 || this._h2.closed || this._h2.destroyed) {
      if (this._h2) this._h2 = null

      this._h2 = http2.connect(this.baseUrl)

      if (this._h2CleanupTimer) clearTimeout(this._h2CleanupTimer)
      this._h2CleanupTimer = setTimeout(() => this._closeHttp2Session(), 60000)
      this._h2CleanupTimer.unref()

      this._h2.once('error', () => { this._h2 = null })
      this._h2.once('close', () => { this._h2 = null })
      this._h2.socket?.unref?.()
    }

    return this._h2
  }

  async _makeHttp2Request(method, path, headers, payload) {
    const session = this._getOrCreateHttp2Session()

    return new Promise((resolve, reject) => {
      let req = null
      let timeoutId = null
      let resolved = false
      let chunks = []
      let totalSize = 0
      let preallocatedBuffer = null

      const complete = (isSuccess, value) => {
        if (resolved) return;
        resolved = true

        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }

        chunks = null
        preallocatedBuffer = null
        if (req && !isSuccess) req.close(http2.constants.NGHTTP2_CANCEL)
        isSuccess ? resolve(value) : reject(value)
      }

      const h2Headers = {
        ':method': method,
        ':path': path,
        Authorization: headers.Authorization,
        Accept: headers.Accept,
        'Accept-Encoding': headers['Accept-Encoding'],
        'User-Agent': headers['User-Agent']
      }

      if (headers['Content-Type']) h2Headers['Content-Type'] = headers['Content-Type']
      if (headers['Content-Length']) h2Headers['Content-Length'] = headers['Content-Length']

      req = session.request(h2Headers)

      req.once('response', (respHeaders) => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }

        const status = respHeaders[':status'] || 0
        const cl = respHeaders['content-length']

        if (status === 204 || cl === '0') return req.resume(), complete(true, null)

        const clInt = cl ? parseInt(cl, 10) : 0
        if (clInt > MAX_RESPONSE_SIZE) {
          req.resume()
          return complete(false, ERRORS.RESPONSE_TOO_LARGE)
        }

        if (clInt > 0 && clInt <= MAX_RESPONSE_SIZE) {
          preallocatedBuffer = Buffer.allocUnsafe(clInt)
        }

        const encodingType = _getEncodingType(respHeaders['content-encoding'])
        const decompressor = encodingType !== ENCODING_NONE
          ? (encodingType === ENCODING_BR ? createBrotliDecompress() : createUnzip())
          : null
        const stream = decompressor ? req.pipe(decompressor) : req

        if (decompressor) decompressor.once('error', (err) => complete(false, err))
        req.once('error', (err) => complete(false, err))

        stream.on('data', (chunk) => {
          if (preallocatedBuffer) {
            chunk.copy(preallocatedBuffer, totalSize)
            totalSize += chunk.length
          } else {
            totalSize += chunk.length
            if (totalSize > MAX_RESPONSE_SIZE) return complete(false, ERRORS.RESPONSE_TOO_LARGE)
            chunks.push(chunk)
          }
        })

        stream.once('end', () => {
          if (totalSize === 0) return complete(true, null)

          const buffer = preallocatedBuffer
            ? preallocatedBuffer.slice(0, totalSize)
            : (chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalSize))
          const text = buffer.toString(UTF8_ENCODING)
          let result = null

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

  _closeHttp2Session() {
    if (this._h2CleanupTimer) {
      clearTimeout(this._h2CleanupTimer)
      this._h2CleanupTimer = null
    }

    if (this._h2) {
      try {
        this._h2.close()
      } catch {}
      this._h2 = null
    }
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
    for (let i = 0; i < encodedTracks.length; i++) {
      if (!_isValidBase64(encodedTracks[i])) throw ERRORS.INVALID_TRACKS
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

    const skipParam = skipTrackSource ? 'true' : 'false'

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
      const result = await this.makeRequest('POST', `${this._getSessionPath()}/players/${guildId}/lyrics/subscribe?skipTrackSource=${skipTrackSource ? 'true' : 'false'}`)
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
    if (this.agent) {
      this.agent.destroy()
      this.agent = null
    }

    this._closeHttp2Session()

    if (this._headerPool) {
      this._headerPool.length = 0
      this._headerPool = null
    }

    this.aqua = null
    this.node = null
    this.request = null
    this.defaultHeaders = null
    this._endpoints = null
  }
}

module.exports = Rest
