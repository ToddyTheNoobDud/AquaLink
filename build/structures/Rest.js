'use strict'

const { AqualinkEvents } = require('./AqualinkEvents')
const { Buffer } = require('node:buffer')
const { Agent: HttpsAgent, request: httpsRequest } = require('node:https')
const { Agent: HttpAgent, request: httpRequest } = require('node:http')
const http2 = require('node:http2')
const { createBrotliDecompress, createUnzip } = require('node:zlib')

const BASE64_STANDARD_REGEX = /^[A-Za-z0-9+/]*={0,2}$/
const BASE64_URL_REGEX = /^[A-Za-z0-9_-]*={0,2}$/

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024
const API_VERSION = 'v4'

const EMPTY_STRING = ''
const UTF8_ENCODING = 'utf8'
const JSON_CONTENT_TYPE = 'application/json'

const ERRORS = Object.freeze({
  NO_SESSION: Object.freeze(new Error('Session ID required')),
  INVALID_TRACK: Object.freeze(new Error('Invalid encoded track format')),
  INVALID_TRACKS: Object.freeze(new Error('One or more tracks have invalid format')),
  RESPONSE_TOO_LARGE: Object.freeze(new Error('Response too large')),
  RESPONSE_ABORTED: Object.freeze(new Error('Response aborted'))
})

const isValidBase64 = (str) => {
  if (typeof str !== 'string' || str.length === 0) return false

  const len = str.length
  const hasUrlChars = /[-_]/.test(str)
  return hasUrlChars
    ? len % 4 !== 1 && BASE64_URL_REGEX.test(str)
    : len % 4 === 0 && BASE64_STANDARD_REGEX.test(str)
}

const fastBool = (b) => b ? true : false

class Rest {
  constructor(aqua, node) {
    this.aqua = aqua
    this.node = node
    this.sessionId = node.sessionId
    this.timeout = node.timeout || 15000

    const protocol = node.secure ? 'https:' : 'http:'
    const host = node.host.includes(':') && !node.host.startsWith('[')
      ? `[${node.host}]`
      : node.host
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
      routeplanner: {
        status: `${this._apiBase}/routeplanner/status`,
        freeAddress: `${this._apiBase}/routeplanner/free/address`,
        freeAll: `${this._apiBase}/routeplanner/free/all`
      },
      lyrics: `${this._apiBase}/lyrics`
    })

    this.defaultHeaders = Object.freeze({
      Authorization: String(node.auth ?? EMPTY_STRING),
      Accept: 'application/json, */*;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': `Aqualink/${this.aqua.version} (Node.js ${process.version})`
    })

    const agentOpts = {
      keepAlive: true,
      maxSockets: node.maxSockets ?? 128,
      maxFreeSockets: node.maxFreeSockets ?? 64,
      freeSocketTimeout: node.freeSocketTimeout ?? 15000,
      keepAliveMsecs: node.keepAliveMsecs ?? 500,
      scheduling: 'lifo',
      timeout: this.timeout
    }
    if (node.secure) agentOpts.maxCachedSessions = node.maxCachedSessions ?? 200
    const AgentClass = node.secure ? HttpsAgent : HttpAgent
    this.agent = new AgentClass(agentOpts)

    this.request = node.secure ? httpsRequest : httpRequest
    this.useHttp2 = !!(this.aqua && this.aqua.options && this.aqua.options.useHttp2)

    this._h2 = null
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

  async makeRequest(method, endpoint, body = undefined) {
    const url = `${this.baseUrl}${endpoint}`
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    let headers = this.defaultHeaders

    if (payload !== undefined) {
      headers = Object.assign({}, this.defaultHeaders)
      headers['Content-Type'] = JSON_CONTENT_TYPE
      headers['Content-Length'] = Buffer.byteLength(payload, UTF8_ENCODING)
    }

    const isSimplePayload = !payload || Buffer.byteLength(payload, UTF8_ENCODING) < 1024
    const useHttp2 = this.useHttp2 && !isSimplePayload

    return useHttp2
      ? this._makeHttp2Request(method, endpoint, headers, payload)
      : this._makeHttp1Request(method, url, headers, payload)
  }

  _makeHttp1Request(method, url, headers, payload) {
    return new Promise((resolve, reject) => {
      let req
      let timeoutId
      let resolved = false

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
      }

      const fastResolve = (value) => {
        if (resolved) return
        resolved = true
        cleanup()
        resolve(value)
      }

      const fastReject = (error) => {
        if (resolved) return
        resolved = true
        cleanup()
        if (req && typeof req.destroy === 'function') {
          try { req.destroy() } catch {}
        }
        reject(error)
      }

      req = this.request(url, {
        method,
        headers,
        agent: this.agent,
        timeout: this.timeout
      }, (res) => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }

        if (res.statusCode === 204) {
          res.resume()
          fastResolve(null)
          return
        }

        const contentLength = res.headers['content-length']
        if (contentLength === '0') {
          res.resume()
          fastResolve(null)
          return
        }

        if (contentLength) {
          const size = parseInt(contentLength, 10)
          if (size > MAX_RESPONSE_SIZE) {
            fastReject(ERRORS.RESPONSE_TOO_LARGE)
            return
          }
        }

        const encoding = (res.headers['content-encoding'] || EMPTY_STRING).split(',')[0].trim()

        let stream = res
        let decompressor = null

        if (encoding === 'br') {
          decompressor = createBrotliDecompress()
        } else if (encoding === 'gzip' || encoding === 'deflate') {
          decompressor = createUnzip()
        }

        if (decompressor) {
          decompressor.once('error', fastReject)
          res.pipe(decompressor)
          stream = decompressor
        }

        res.once('aborted', () => fastReject(ERRORS.RESPONSE_ABORTED))
        res.once('error', fastReject)

        const chunks = []
        let totalSize = 0

        stream.on('data', (chunk) => {
          totalSize += chunk.length
          if (totalSize > MAX_RESPONSE_SIZE) {
            fastReject(ERRORS.RESPONSE_TOO_LARGE)
            return
          }
          chunks.push(chunk)
        })

        stream.once('end', () => {
          if (totalSize === 0) {
            fastResolve(null)
            return
          }

          const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalSize)
          const text = buffer.toString(UTF8_ENCODING)
          let result

          try {
            result = JSON.parse(text)
          } catch (err) {
            const error = new Error(`JSON parse error: ${err.message}`)
            fastReject(error)
            return
          }

          const status = res.statusCode
          if (status >= 400) {
            const error = new Error(`HTTP ${status} ${method} ${url}`)
            error.statusCode = status
            error.statusMessage = res.statusMessage
            error.headers = res.headers
            error.body = result
            error.url = url
            fastReject(error)
            return
          }

          fastResolve(result)
        })
      })

      req.once('error', fastReject)
      req.once('socket', (socket) => {
        socket.setNoDelay(true)
        socket.setKeepAlive(true, 500)
      })

      timeoutId = setTimeout(() => {
        const error = new Error(`Request timeout: ${this.timeout}ms`)
        fastReject(error)
      }, this.timeout)

      if (payload !== undefined) {
        req.end(payload)
      } else {
        req.end()
      }
    })
  }

  async _getH2Session() {
    if (this._h2 && !this._h2.closed && !this._h2.destroyed) return this._h2
    const session = http2.connect(this.baseUrl)
    session.setTimeout(this.timeout, () => session.close())
    session.once('error', () => {}) // errors handled per-request
    session.once('close', () => {
      if (this._h2 === session) this._h2 = null
    })
    if (session.socket && typeof session.socket.unref === 'function') {
      session.socket.unref()
    }
    this._h2 = session
    return session
  }

  async _makeHttp2Request(method, path, headers, payload) {
    const session = await this._getH2Session()
    return new Promise((resolve, reject) => {
      let req
      let timeoutId
      let resolved = false

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
      }

      const fastResolve = (value) => {
        if (resolved) return
        resolved = true
        cleanup()
        resolve(value)
      }

      const fastReject = (error) => {
        if (resolved) return
        resolved = true
        cleanup()
        if (req) req.close(http2.constants.NGHTTP2_CANCEL)
        reject(error)
      }

      const h = { ...headers, ':method': method, ':path': path }
      req = session.request(h)

      req.once('response', (respHeaders) => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }

        const status = respHeaders[':status'] || 0
        const cl = respHeaders['content-length']
        if (status === 204 || cl === '0') {
          req.resume()
          fastResolve(null)
          return
        }
        if (cl) {
          const size = parseInt(cl, 10)
          if (size > MAX_RESPONSE_SIZE) {
            req.resume()
            fastReject(ERRORS.RESPONSE_TOO_LARGE)
            return
          }
        }

        const enc = (respHeaders['content-encoding'] || EMPTY_STRING).split(',')[0].trim()
        const decompressor = enc === 'br' ? createBrotliDecompress() : (enc === 'gzip' || enc === 'deflate' ? createUnzip() : null)
        const stream = decompressor ? req.pipe(decompressor) : req

        if (decompressor) decompressor.once('error', fastReject)
        req.once('error', fastReject)

        const chunks = []
        let totalSize = 0

        stream.on('data', (chunk) => {
          totalSize += chunk.length
          if (totalSize > MAX_RESPONSE_SIZE) {
            fastReject(ERRORS.RESPONSE_TOO_LARGE)
            return
          }
          chunks.push(chunk)
        })

        stream.once('end', () => {
          if (totalSize === 0) {
            fastResolve(null)
            return
          }

          const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalSize)
          const text = buffer.toString(UTF8_ENCODING)
          let result

          // Since Lavalink only returns JSON, always parse as JSON
          try {
            result = JSON.parse(text)
          } catch (err) {
            const error = new Error(`JSON parse error: ${err.message}`)
            fastReject(error)
            return
          }

          if (status >= 400) {
            const error = new Error(`HTTP ${status} ${method} ${this.baseUrl}${path}`)
            error.statusCode = status
            error.headers = respHeaders
            error.body = result
            error.url = this.baseUrl + path
            fastReject(error)
            return
          }

          fastResolve(result)
        })
      })

      timeoutId = setTimeout(() => {
        fastReject(new Error(`Request timeout: ${this.timeout}ms`))
      }, this.timeout)

      if (payload !== undefined) {
        req.end(payload)
      } else {
        req.end()
      }
    })
  }

  async updatePlayer({ guildId, data, noReplace = false }) {
    const base = this._getSessionPath()
    const query = noReplace ? '?noReplace=true' : '?noReplace=false'
    return this.makeRequest('PATCH', `${base}/players/${guildId}${query}`, data)
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
    if (!isValidBase64(encodedTrack)) throw ERRORS.INVALID_TRACK
    return this.makeRequest('GET', `${this._endpoints.decodetrack}${encodeURIComponent(encodedTrack)}`)
  }

  async decodeTracks(encodedTracks) {
    if (!Array.isArray(encodedTracks) || encodedTracks.length === 0) throw ERRORS.INVALID_TRACKS
    for (let i = 0, len = encodedTracks.length; i < len; i++) {
      if (!isValidBase64(encodedTracks[i])) throw ERRORS.INVALID_TRACKS
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
    const gid = track?.guild_id ?? track?.guildId
    const encoded = track?.encoded
    const hasEncoded = typeof encoded === 'string' && encoded.length > 0 && isValidBase64(encoded)
    const title = track?.info?.title

    if (!track || (!gid && !hasEncoded && !title)) {
      this.aqua?.emit?.(AqualinkEvents.Error, '[Aqua/Lyrics] Invalid track object')
      return null
    }

    const skipParam = fastBool(skipTrackSource)

    if (gid) {
      try {
        const lyrics = await this.makeRequest('GET', `${this._getSessionPath()}/players/${gid}/track/lyrics?skipTrackSource=${skipParam}`)
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
    if (type === 'object') {
      return Array.isArray(response) ? response.length > 0 : Object.keys(response).length > 0
    }
    return false
  }

  async subscribeLiveLyrics(guildId, skipTrackSource = false) {
    try {
      const result = await this.makeRequest('POST', `${this._getSessionPath()}/players/${guildId}/lyrics/subscribe?skipTrackSource=${fastBool(skipTrackSource)}`)
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
    try {
      const activeSockets = this.agent.sockets || {};
      const freeSockets = this.agent.freeSockets || {};
      if (Object.keys(activeSockets).length || Object.keys(freeSockets).length) {
        console.warn('Active/free sockets remain:', { active: Object.keys(activeSockets).length, free: Object.keys(freeSockets).length });
      }
      this.agent.destroy();
    } catch (err) {
      console.error('Failed to destroy HTTP agent:', err);
    }
    this.agent = null;
  }
    if (this._h2) {
      try { this._h2.close() } catch {}
      this._h2 = null
    }
  }
}

module.exports = Rest
