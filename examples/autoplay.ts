import type { AquaOptions } from '../src/index.ts'

// This policy searches for another track by the previous artist.
// Your bot can use its own catalogue or recommendation service instead.
export const artistAutoplay: NonNullable<AquaOptions['autoplay']> = async (
  player
) => {
  const previous = player.previous
  if (!previous?.author) {
    return null
  }

  const result = await player.aqua.resolve({
    query: previous.author,
    source: 'ytsearch',
    requester: previous.requester,
    nodes: player.node
  })

  return (
    result.tracks.find(
      (track) =>
        track.identifier !== previous.identifier ||
        track.sourceName !== previous.sourceName
    ) ?? null
  )
}
