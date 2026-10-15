import type { TrackAPI } from '../types/shared.ts'

/**
 * Holds encoded data and info from a track payload. Creating it only stores data;
 * pluginInfo/userData aren't stored yet.
 *
 * @example
 * ```ts
 * const track = new Track(trackData)
 * console.log(track.info.title)
 * ```
 */
export default class Track {
  /** Encoded data from the node, sent back to start playback. */
  public encoded: TrackAPI['track']['encoded']
  /** Payload metadata, kept by reference. */
  public info: TrackAPI['track']['info']

  /**
   * Keeps encoded and info. No cleanup resources; drop references when done for GC.
   *
   * @param data - One track payload from a load result.
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
