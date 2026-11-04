import { Track } from '../src/index.ts'

export class BotTrack extends Track {
  // Read the existing metadata instead of storing another copy of it.
  get displayTitle() {
    return `${this.author} - ${this.title}`
  }
}
