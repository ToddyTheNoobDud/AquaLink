import type { TrackAPI } from '../types/shared.ts'

/**
 * Small wrapper around a node's track payload: encoded data plus its info.
 * Doesn't load audio or play anything. pluginInfo/userData aren't stored yet.
 *
 * @example
 * ```ts
 * const track = new Track(trackData)
 * console.log(track.info.title)
 * ```
 */
export default class Track {
  /** Encoded string from the node, sent back when starting playback. */
  public encoded: TrackAPI['track']['encoded']
  /** Metadata from the payload; this is the same object reference, not a copy. */
  public info: TrackAPI['track']['info']

  /**
   * Keeps encoded and info from one payload. It doesn't create a cleanup resource.
   * Drop your references when done and let JavaScript's GC handle the object.
   *
   * @param data - One track payload, not the entire load result or an array.
   * @example
   * ```ts
   * const track = new Track(trackData)
   * player.queue.add(track)
   * ```
   */
  constructor(data: TrackAPI['track']) {
    this.encoded = data.encoded
    this.info = data.info
  }
}
