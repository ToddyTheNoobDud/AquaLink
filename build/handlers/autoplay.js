const https = require('node:https')

// Default agent config (used only if shared agent not provided)
const AGENT_CONFIG = {
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: 8000,
  freeSocketTimeout: 4000
}

// Shared agent reference - can be set from Rest module
let sharedAgent = null
const getAgent = () => {
  if (!sharedAgent) {
    sharedAgent = new https.Agent(AGENT_CONFIG)
  }
  return sharedAgent
}

// Allow Rest module to inject its agent
const setSharedAgent = (agent) => {
  if (agent && typeof agent.request === 'function') {
    sharedAgent = agent
  }
}

const SC_LINK_RE = /<a\s+itemprop="url"\s+href="(\/[^"]+)"/g
const MAX_REDIRECTS = 3
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024 // 5 MB
const MAX_SC_LINKS = 50
const MAX_SP_RESULTS = 5
const DEFAULT_TIMEOUT_MS = 8000

const fastFetch = (url, depth = 0) =>
  new Promise((resolve, reject) => {
    if (depth > MAX_REDIRECTS) return reject(new Error('Too many redirects'))

    const req = https.get(
      url,
      { agent: getAgent(), timeout: DEFAULT_TIMEOUT_MS },
      (res) => {
        const { statusCode, headers } = res

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume()
          return fastFetch(new URL(headers.location, url).href, depth + 1).then(
            resolve,
            reject
          )
        }

        if (statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${statusCode}`))
        }

        const chunks = []
        let received = 0

        res.on('data', (chunk) => {
          received += chunk.length
          if (received > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('Response too large'))
            return
          }
          chunks.push(chunk)
        })

        res.on('end', () => {
          try {
            const buf = Buffer.concat(chunks)
            resolve(buf.toString())
          } catch (err) {
            reject(err)
          }
        })
      }
    )

    req.on('error', reject)
    req.setTimeout(DEFAULT_TIMEOUT_MS, () => req.destroy(new Error('Timeout')))
  })

const shuffleInPlace = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

const scAutoPlay = async (baseUrl) => {
  try {
    const html = await fastFetch(`${baseUrl}/recommended`)
    const links = []
    for (const m of html.matchAll(SC_LINK_RE)) {
      if (!m[1]) continue
      links.push(`https://soundcloud.com${m[1]}`)
      if (links.length >= MAX_SC_LINKS) break
    }
    return links.length ? shuffleInPlace(links) : []
  } catch (err) {
    console.error('scAutoPlay error:', err?.message || err)
    return []
  }
}

const spAutoPlay = async (seed, player, requester, excludedIds = []) => {
  try {
    if (!seed?.trackId) return null

    const seedQuery = `seed_tracks=${seed.trackId}${seed.artistIds ? `&seed_artists=${seed.artistIds}` : ''}`
    const res = await player.aqua.resolve({
      query: seedQuery,
      source: 'spsearch',
      requester
    })

    const candidates = res?.tracks || []
    if (!candidates.length) return null

    const seen = new Set(excludedIds)
    const prevId = player.current?.identifier
    if (prevId) seen.add(prevId)

    const out = []
    for (const t of candidates) {
      if (seen.has(t.identifier)) continue
      seen.add(t.identifier)
      t.pluginInfo = {
        ...(t.pluginInfo || {}),
        clientData: { fromAutoplay: true }
      }
      out.push(t)
      if (out.length === MAX_SP_RESULTS) break
    }

    return out.length ? out : null
  } catch (err) {
    console.error('spAutoPlay error:', err)
    return null
  }
}

module.exports = {
  scAutoPlay,
  spAutoPlay,
  setSharedAgent
}
