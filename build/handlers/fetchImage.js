const https = require('node:https')

const sourceHandlers = {
  spotify: fetchSpotifyThumbnail,
  youtube: fetchYouTubeThumbnail
}

const YOUTUBE_QUALITIES = ['maxresdefault', 'hqdefault', 'mqdefault', 'default']

const YOUTUBE_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/
const SPOTIFY_URI_REGEX =
  /^https:\/\/open\.spotify\.com\/(track|album|playlist)\/[a-zA-Z0-9]+/

async function getImageUrl(info) {
  if (!info?.sourceName || !info?.uri) return null

  const sourceName = info.sourceName.toLowerCase()
  const handler = sourceHandlers[sourceName]

  if (!handler) return null

  try {
    const param =
      sourceName === 'spotify'
        ? info.uri
        : sourceName === 'youtube'
          ? extractYouTubeId(info.uri)
          : info.uri

    if (!param) return null

    return await handler(param)
  } catch (error) {
    console.error(`Error fetching ${sourceName} thumbnail:`, error.message)
    return null
  }
}

function extractYouTubeId(uri) {
  if (!uri) return null

  let id = null

  if (uri.includes('youtube.com/watch?v=')) {
    id = uri.split('v=')[1]?.split('&')[0]
  } else if (uri.includes('youtu.be/')) {
    id = uri.split('youtu.be/')[1]?.split('?')[0]
  } else if (uri.includes('youtube.com/embed/')) {
    id = uri.split('embed/')[1]?.split('?')[0]
  } else if (YOUTUBE_ID_REGEX.test(uri)) {
    id = uri
  }

  return id && YOUTUBE_ID_REGEX.test(id) ? id : null
}

async function fetchSpotifyThumbnail(uri) {
  if (!SPOTIFY_URI_REGEX.test(uri)) {
    throw new Error('Invalid Spotify URI format')
  }

  const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(uri)}`

  try {
    const data = await fetchJson(url)
    return data?.thumbnail_url || null
  } catch (error) {
    throw new Error(`Spotify fetch failed: ${error.message}`)
  }
}

async function fetchYouTubeThumbnail(identifier) {
  if (!identifier || !YOUTUBE_ID_REGEX.test(identifier)) {
    throw new Error('Invalid YouTube identifier')
  }

  for (const quality of YOUTUBE_QUALITIES) {
    const url = `https://img.youtube.com/vi/${identifier}/${quality}.jpg`

    try {
      const exists = await checkImageExists(url)
      if (exists) return url
    } catch (_error) {}
  }

  return null
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode}`))
      }

      const chunks = []
      let totalLength = 0

      res.on('data', (chunk) => {
        chunks.push(chunk)
        totalLength += chunk.length

        if (totalLength > 1024 * 1024) {
          res.destroy()
          reject(new Error('Response too large'))
        }
      })

      res.on('end', () => {
        try {
          const data = Buffer.concat(chunks, totalLength).toString('utf8')
          const json = JSON.parse(data)
          resolve(json)
        } catch (error) {
          reject(new Error(`JSON parse error: ${error.message}`))
        }
      })
    })

    request.setTimeout(5000, () => {
      request.destroy()
      reject(new Error('Request timeout'))
    })

    request.on('error', (error) => {
      reject(new Error(`Request error: ${error.message}`))
    })
  })
}

function checkImageExists(url) {
  return new Promise((resolve) => {
    const request = https.request(url, { method: 'HEAD' }, (res) => {
      resolve(res.statusCode === 200)
    })

    request.setTimeout(3000, () => {
      request.destroy()
      resolve(false)
    })

    request.on('error', () => resolve(false))
    request.end()
  })
}

module.exports = {
  getImageUrl
}
