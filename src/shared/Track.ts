import type { TrackAPI } from '../types/shared.ts'

export default class Track {
  public encoded: TrackAPI['track']['encoded']
  public info: TrackAPI['track']['info']

  constructor(data: TrackAPI['track']) {
    this.encoded = data.encoded
    this.info = data.info
  }
}
