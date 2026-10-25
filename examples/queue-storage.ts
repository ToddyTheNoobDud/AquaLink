import type { QueueLike, Track } from '../src/index.ts'

// Implements the player's storage contract without extending AquaLink's Queue.
// This small example keeps FIFO order in an array. Replace storage here.
export class BotQueue implements QueueLike {
  private tracks: Track[] = []

  get size() {
    return this.tracks.length
  }

  add(...tracks: Track[]) {
    this.tracks.push(...tracks)
  }

  at(index: number) {
    return this.tracks.at(index)
  }

  dequeue() {
    return this.tracks.shift()
  }

  clear() {
    // Drop references; the same Track may still belong to another player.
    this.tracks.length = 0
  }

  toArray() {
    return this.tracks.slice()
  }
}
