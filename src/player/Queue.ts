import type Track from '../shared/Track.ts'

export default class Queue {
  private tracks: Track[] = []

  public get size() {
    return this.tracks.length
  }

  public add(...tracks: Track[]) {
    this.tracks.push(...tracks)
    return this
  }

  public at(index: number) {
    return this.tracks.at(index)
  }

  public dequeue() {
    return this.tracks.shift()
  }

  public toArray() {
    return this.tracks.slice()
  }
}
