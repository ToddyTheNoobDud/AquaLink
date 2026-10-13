import type Track from '../shared/Track.ts'

/**
 * A FIFO list of Track references. Adding a track doesn't start playback.
 * No cloning, auto-play or Track cleanup happens here.
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
   * How many tracks are waiting in this queue right now.
   * @example
   * ```ts
   * console.log(player.queue.size)
   * ```
   */
  public get size() {
    return this.tracks.length
  }

  /**
   * Adds one or more tracks to the end, in the order you pass them.
   * Stores the same references and returns this queue for chaining.
   *
   * @param tracks - Track instances to append; an array needs ...tracks.
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
   * Reads a track without removing it. Negative indexes count from the end.
   *
   * @param index - Zero-based index; -1 means the last track.
   * @returns The stored Track, or undefined if the index is out of range.
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
   * Removes and returns the first track. Doesn't play or dispose it.
   *
   * @returns The removed Track, or undefined if the queue is empty.
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
   * Returns a copy of the list, useful for displaying the queue.
   * Changing the array doesn't change this queue, but its Track objects are shared.
   *
   * @returns A shallow Track array in queue order.
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
