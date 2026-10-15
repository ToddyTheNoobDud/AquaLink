import type Track from '../shared/Track.ts'

/**
 * Waiting tracks in FIFO order, stored as references. Playback and cleanup stay
 * with the caller; adding a track just stores it.
 *
 * @example
 * ```ts
 * const queue = new Queue()
 * queue.add(track)
 * const next = queue.dequeue()
 * ```
 */
export default class Queue {
  private tracks: Track[] = []

  /**
   * Number of waiting tracks.
   * @example
   * ```ts
   * console.log(player.queue.size)
   * ```
   */
  public get size() {
    return this.tracks.length
  }

  /**
   * Appends tracks in order, keeping their references. Returns this queue for chaining.
   *
   * @param tracks - Tracks to append; spread arrays with ...tracks.
   * @example
   * ```ts
   * player.queue.add(track)
   * const tracks = await aqua.resolve('slayr eyesight', 'ytsearch')
   * if (tracks) player.queue.add(...tracks)
   * ```
   */
  public add(...tracks: Track[]) {
    this.tracks.push(...tracks)
    return this
  }

  /**
   * Reads a track without removing it.
   *
   * @param index - Zero-based; negative indexes count from the end (-1 is last).
   * @returns Stored Track, or undefined if out of range.
   * @example
   * ```ts
   * const first = player.queue.at(0)
   * const last = player.queue.at(-1)
   * console.log(first?.info.title, last?.info.title)
   * ```
   */
  public at(index: number) {
    return this.tracks.at(index)
  }

  /**
   * Removes the first track. Playback and cleanup stay with the caller.
   *
   * @returns Removed Track, or undefined if empty.
   * @example
   * ```ts
   * const removed = player.queue.dequeue()
   * console.log(removed?.info.title)
   * ```
   */
  public dequeue() {
    return this.tracks.shift()
  }

  /**
   * Copies the list for display. Array changes leave the queue alone;
   * Track objects are still shared.
   *
   * @returns Track[] in queue order, with the same Track references.
   * @example
   * ```ts
   * const titles = player.queue.toArray().map(track => track.info.title)
   * console.log(titles)
   * ```
   */
  public toArray() {
    return this.tracks.slice()
  }
}
