import type Track from '../shared/Track.ts'

/** FIFO of waiting tracks. current belongs to Player, never to the queue.
 * @example const queue = new Queue(first, second); queue.shuffle()
 */
export default class Queue {
  private tracks: Track[] = []

  constructor(...tracks: Track[]) {
    this.add(...tracks)
  }

  get size() {
    return this.tracks.length
  }

  get length() {
    return this.size
  }

  /** Append references and return this queue. Doesn't start playback.
   * @example queue.add(first, second)
   */
  add(...tracks: Track[]) {
    for (let index = 0; index < tracks.length; index++) {
      this.tracks.push(tracks[index] as Track)
    }
    return this
  }

  /** Prepend tracks in the given order. Returns the new queue size. */
  unshift(...tracks: Track[]) {
    return this.tracks.unshift(...tracks)
  }

  /** Read an item or null. Negative indexes count from the end, as with Array.at. */
  at(index: number) {
    return this.tracks.at(index) ?? null
  }

  /** Remove the first matching object reference. Returns whether it was found. */
  remove(track: Track) {
    const index = this.tracks.indexOf(track)
    if (index < 0) {
      return false
    }
    this.tracks.splice(index, 1)
    return true
  }

  /** Releases queue references; shared Track wrappers aren't disposed. */
  clear() {
    this.tracks.length = 0
  }

  /** Snapshot the order. The array is copied; Track objects are shared. */
  toArray(): Track[] {
    return this.tracks.slice()
  }

  /** Remove the first waiting track, or return undefined when empty. */
  dequeue() {
    return this.tracks.shift()
  }

  /** Move between zero-based indexes. Invalid indexes leave the queue unchanged.
   * @example queue.move(2, 0)
   */
  move(from: number, to: number) {
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < 0 ||
      from >= this.size ||
      to >= this.size
    ) {
      return this
    }
    const track = this.tracks.splice(from, 1)[0] as Track
    this.tracks.splice(to, 0, track)
    return this
  }

  /** Shuffle waiting order in place and return this queue. Current is unaffected. */
  shuffle() {
    for (let index = this.size - 1; index > 0; index--) {
      const other = Math.floor(Math.random() * (index + 1))
      const track = this.tracks[index] as Track
      this.tracks[index] = this.tracks[other] as Track
      this.tracks[other] = track
    }
    return this
  }

  /** Iterate a snapshot, so later queue changes don't alter this traversal. */
  [Symbol.iterator]() {
    return this.toArray()[Symbol.iterator]()
  }
}
