import type Track from '../shared/Track.ts'
import type Player from './Player.ts'

/** Use the previous source where possible. All lookups go through the player's node. */
export async function getAutoplayTrack(player: Player): Promise<Track | null> {
  const previous = player.previous
  if (!previous) {
    return null
  }
  if (previous.sourceName === 'spotify') {
    return spotifyAutoplay(player, previous)
  }

  const options = { requester: previous.requester, nodes: player.node }
  let seed: Track | undefined = previous
  let query: string
  if (previous.sourceName === 'soundcloud') {
    if (!previous.author) {
      return null
    }
    // SoundCloud has no standard recommendation prefix. Search the artist instead.
    query = `scsearch:${previous.author}`
  } else {
    if (seed.sourceName !== 'youtube' && seed.sourceName !== 'ytmusic') {
      const search = [seed.author, seed.title].filter(Boolean).join(' - ')
      if (!search) {
        return null
      }
      const result = await player.aqua.resolve({
        ...options,
        source: 'ytmsearch',
        query: search
      })
      seed = result.tracks.find(
        (track) =>
          track.sourceName === 'youtube' || track.sourceName === 'ytmusic'
      )
    }
    if (!seed?.identifier) {
      return null
    }
    const identifier = encodeURIComponent(seed.identifier)
    query = `https://www.youtube.com/watch?v=${identifier}&list=RD${identifier}`
  }

  const result = await player.aqua.resolve({ ...options, query })
  return (
    result.tracks.find(
      (track) =>
        track.identifier &&
        track.identifier !== seed.identifier &&
        (previous.sourceName !== 'soundcloud' ||
          track.sourceName === 'soundcloud')
    ) ?? null
  )
}

/** NodeLink accepts seed_tracks; LavaSrc also supports ISRC and track mixes. */
async function spotifyAutoplay(
  player: Player,
  previous: Track
): Promise<Track | null> {
  const options = { requester: previous.requester, nodes: player.node }
  let seed = previous
  if ((!seed.identifier || seed.identifier === 'local') && !seed.isrc) {
    const query = [seed.author, seed.title].filter(Boolean).join(' - ')
    if (!query) {
      return null
    }
    const result = await player.aqua.resolve({
      ...options,
      source: 'spsearch',
      query
    })
    const match = result.tracks.find(
      (track) =>
        track.sourceName === 'spotify' &&
        track.identifier &&
        track.identifier !== 'local'
    )
    if (!match) {
      return null
    }
    seed = match
  }

  const trackId = seed.identifier === 'local' ? '' : seed.identifier
  const seedQuery = trackId
    ? `sprec:seed_tracks=${encodeURIComponent(trackId)}`
    : null
  let query = seedQuery
  if (!player.node.isNodelink) {
    if (seed.isrc) {
      query = `sprec:mix:isrc:${seed.isrc}`
    } else if (trackId) {
      query = `sprec:mix:track:${trackId}`
    }
  }
  if (!query) {
    return null
  }
  let result = await player.aqua.resolve({ ...options, query })
  if (!result.tracks.length && seedQuery && query !== seedQuery) {
    result = await player.aqua.resolve({ ...options, query: seedQuery })
  }
  return (
    result.tracks.find(
      (track) =>
        track.sourceName === 'spotify' &&
        track.identifier &&
        track.identifier !== 'local' &&
        track.identifier !== seed.identifier &&
        (!seed.isrc || track.isrc !== seed.isrc)
    ) ?? null
  )
}

/** Selection can wait on the node. Check playback again before starting its result. */
export async function startAutoplay(player: Player): Promise<void> {
  if (
    !player.isAutoplayEnabled ||
    player.destroyed ||
    !player.connected ||
    player.playing ||
    player.current ||
    (player.hasQueue && player.queue.size)
  ) {
    return
  }
  try {
    const policy = player.aqua.options?.autoplay
    const track = await (policy ? policy(player) : player.getAutoplayTrack())
    if (
      !player.isAutoplayEnabled ||
      player.destroyed ||
      !player.connected ||
      player.playing ||
      player.current
    ) {
      return
    }
    if (player.hasQueue && player.queue.size) {
      await player.play()
    } else if (track) {
      await player.play(track)
    } else if (!policy) {
      throw new Error('No related autoplay track was found.')
    }
  } catch (error) {
    if (!player.destroyed && player.isAutoplayEnabled) {
      player.emit('autoplayFailed', error)
      player.aqua.emit('autoplayFailed', player, error)
    }
  }
}
