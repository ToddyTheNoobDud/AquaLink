import { Queue, type Track } from '../src/index.ts'

// New batches go to the front. Tracks within each batch keep their order.
export class NextUpQueue extends Queue {
  override add(...tracks: Track[]) {
    this.unshift(...tracks)
    return this
  }
}
