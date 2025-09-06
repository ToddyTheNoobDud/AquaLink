'use strict'

const { Buffer } = require('node:buffer')
const { Agent: HttpsAgent, request: httpsRequest } = require('node:https')
const { Agent: HttpAgent, request: httpRequest } = require('node:http')
const http2 = require('node:http2')
const { createBrotliDecompress, createUnzip } = require('node:zlib')

const JSON_TYPE_REGEX = /^(?:application\/json|application\/(?:[a-z0-9.+-]*\+json))\b/i
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

const _functions = Object.freeze({
  isValidBase64(str) {
    if (typeof str !== 'string' || str.length === 0) return false
    const hasUrlChars = /[-_]/.test(str)
    const len = str.length
    return hasUrlChars
      ? len % 4 !== 1 && BASE64_URL_REGEX.test(str)
      : len % 4 === 0 && BASE64_STANDARD_REGEX.test(str)
  },
  isJsonContentType(ct) {
    return JSON_TYPE_REGEX.test(ct || EMPTY_STRING)
  },
  getDecompressor(encoding) {
    if (!encoding) return null
    if (encoding === 'br') return createBrotliDecompress()
    if (encoding === 'gzip' || encoding === 'deflate') return createUnzip()
    return null
  },
  collectStream(stream, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let total = 0
      const onData = (c) => {
        total += c.length
        if (total > limit) {
          cleanup()
          reject(ERRORS.RESPONSE_TOO_LARGE)
          return
        }
        chunks.push(c)
      }
      const onEnd = () => {
        cleanup()
        resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total))
      }
      const onError = (e) => {
        cleanup()
        reject(e)
      }
      const cleanup = () => {
        stream.removeListener('data', onData)
        stream.removeListener('end', onEnd)
        stream.removeListener('error', onError)
      }
      stream.on('data', onData)
      stream.once('end', onEnd)
      stream.once('error', onError)
    })
  },
  parseBody(buffer, isJson) {
    if (!buffer || buffer.length === 0) return null
    const text = buffer.toString(UTF8_ENCODING)
    if (!isJson) return text
    try {
      return JSON.parse(text)
    } catch (e) {
      const err = new Error('JSON parse error: ' + e.message)
      err.cause = e
      throw err
    }
  },
  buildHeaders(base, payload) {
    if (payload === undefined) return base
    return {
      ...base,
      'Content-Type': JSON_CONTENT_TYPE,
      'Content-Length': Buffer.byteLength(payload, UTF8_ENCODING)
    }
  }
})

class Rest {
  constructor(aqua, node) {
    this.aqua = aqua
    this.node = node
    this.sessionId = node.sessionId
    this.timeout = node.timeout || 15000

    const protocol = node.secure ? 'https:' : 'http:'
    const host = node.host.includes(':') && !node.host.startsWith('[') ? `[${node.host}]` : node.host
    this.origin = `${protocol}//${host}:${node.port}`
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
      'User-Agent': `Aqua-Lavalink/${API_VERSION} (Node.js ${process.version})`
    })

    const agentOpts = {
      keepAlive: true,
      maxSockets: node.maxSockets ?? 128,
      maxFreeSockets: node.maxFreeSockets ?? 64,
      freeSocketTimeout: node.freeSocketTimeout ?? 15000,
      keepAliveMsecs: node.keepAliveMsecs ?? 500,
      scheduling: 'lifo'
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

  async makeRequest(method, endpoint, body) {
    const url = `${this.origin}${endpoint}`
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    const headers = _functions.buildHeaders(this.defaultHeaders, payload)

    return this.useHttp2
      ? this._makeHttp2Request(method, endpoint, headers, payload)
      : this._makeHttp1Request(method, url, headers, payload)
  }

  _makeHttp1Request(method, url, headers, payload) {
    return new Promise((resolve, reject) => {
      let req
      const timer = setTimeout(() => {
        if (req) req.destroy(new Error(`Request timeout: ${this.timeout}ms`))
      }, this.timeout)
      if (timer.unref) timer.unref()

      const onError = (e) => {
        clearTimeout(timer)
        reject(e)
      }

      req = this.request(url, { method, headers, agent: this.agent }, (res) => {
        clearTimeout(timer)

        const status = res.statusCode || 0
        const h = res.headers
        if (status === 204 || h['content-length'] === '0') {
          res.resume()
          resolve(null)
          return
        }
        if (h['content-length']) {
          const size = parseInt(h['content-length'], 10)
          if (size > MAX_RESPONSE_SIZE) {
            res.resume()
            reject(ERRORS.RESPONSE_TOO_LARGE)
            return
          }
        }

        const encoding = (h['content-encoding'] || EMPTY_STRING).split(',')[0].trim()
        const isJson = _functions.isJsonContentType(h['content-type'])
        const decompressor = _functions.getDecompressor(encoding)
        const stream = decompressor ? res.pipe(decompressor) : res

        res.once('aborted', () => reject(ERRORS.RESPONSE_ABORTED))
        res.once('error', onError)
        if (decompressor) decompressor.once('error', onError)

        _functions.collectStream(stream, MAX_RESPONSE_SIZE)
          .then((buf) => {
            const result = _functions.parseBody(buf, isJson)
            if (status >= 400) {
              const error = new Error(`HTTP ${status} ${method} ${url}`)
              error.statusCode = status
              error.statusMessage = res.statusMessage
              error.headers = h
              error.body = result
              error.url = url
              reject(error)
              return
            }
            resolve(result)
          })
          .catch(onError)
      })

      req.once('error', onError)
      req.once('socket', (socket) => {
        socket.setNoDelay(true)
        socket.setKeepAlive(true, 500)
      })
      if (payload !== undefined) req.end(payload)
      else req.end()
    })
  }

  async _getH2Session() {
    if (this._h2 && !this._h2.closed && !this._h2.destroyed) return this._h2
    const session = http2.connect(this.origin)
    session.setTimeout(this.timeout, () => session.close())
    session.once('error', () => {}) // errors are handled per-request
    session.once('close', () => {
      if (this._h2 === session) this._h2 = null
    })
    // best effort: avoid keeping the event loop alive
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
      const timer = setTimeout(() => {
        if (req) req.close(http2.constants.NGHTTP2_CANCEL)
        reject(new Error(`Request timeout: ${this.timeout}ms`))
      }, this.timeout)
      if (timer.unref) timer.unref()

      const h = { ...headers, ':method': method, ':path': path }
      req = session.request(h)

      const onError = (e) => {
        clearTimeout(timer)
        reject(e)
      }

      req.once('response', (respHeaders) => {
        clearTimeout(timer)

        const status = respHeaders[':status'] || 0
        const cl = respHeaders['content-length']
        const ct = respHeaders['content-type'] || EMPTY_STRING
        if (status === 204 || cl === '0') {
          req.resume()
          resolve(null)
          return
        }
        if (cl) {
          const size = parseInt(cl, 10)
          if (size > MAX_RESPONSE_SIZE) {
            req.resume()
            reject(ERRORS.RESPONSE_TOO_LARGE)
            return
          }
        }

        const enc = (respHeaders['content-encoding'] || EMPTY_STRING).split(',')[0].trim()
        const isJson = _functions.isJsonContentType(ct)
        const decompressor = _functions.getDecompressor(enc)
        const stream = decompressor ? req.pipe(decompressor) : req

        if (decompressor) decompressor.once('error', onError)
        req.once('error', onError)

        _functions.collectStream(stream, MAX_RESPONSE_SIZE)
          .then((buf) => {
            const result = _functions.parseBody(buf, isJson)
            if (status >= 400) {
              const error = new Error(`HTTP ${status} ${method} ${this.origin}${path}`)
              error.statusCode = status
              error.headers = respHeaders
              error.body = result
              error.url = this.origin + path
              reject(error)
              return
            }
            resolve(result)
          })
          .catch(onError)
      })

      if (payload !== undefined) {
        req.end(payload)
      } else {
        req.end()
      }
    }).then((res) => res)
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
    if (!_functions.isValidBase64(encodedTrack)) throw ERRORS.INVALID_TRACK
    return this.makeRequest('GET', `${this._endpoints.decodetrack}${encodeURIComponent(encodedTrack)}`)
  }

  async decodeTracks(encodedTracks) {
    if (!Array.isArray(encodedTracks) || encodedTracks.length === 0) throw ERRORS.INVALID_TRACKS
    for (const t of encodedTracks) {
      if (!_functions.isValidBase64(t)) throw ERRORS.INVALID_TRACKS
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
    const hasEncoded = typeof encoded === 'string' && encoded.length > 0 && _functions.isValidBase64(encoded)
    const title = track?.info?.title

    if (!track || (!gid && !hasEncoded && !title)) {
      if (this.aqua?.emit) this.aqua.emit('error', '[Aqua/Lyrics] Invalid track object')
      return null
    }

    const skipParam = skipTrackSource ? 'true' : 'false'

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
      const res = await this.makeRequest('POST', `${this._getSessionPath()}/players/${guildId}/lyrics/subscribe?skipTrackSource=${skipTrackSource ? 'true' : 'false'}`)
      return res === null
    } catch {
      return false
    }
  }

  async unsubscribeLiveLyrics(guildId) {
    try {
      const res = await this.makeRequest('DELETE', `${this._getSessionPath()}/players/${guildId}/lyrics/subscribe`)
      return res === null
    } catch {
      return false
    }
  }

  destroy() {
    if (this.agent) {
      this.agent.destroy()
      this.agent = null
    }
    if (this._h2) {
      try { this._h2.close() } catch {}
      this._h2 = null
    }
  }
}

module.exports = Rest

