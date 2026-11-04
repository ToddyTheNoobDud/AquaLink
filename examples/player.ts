import { Player, type Track } from '../src/index.ts'

export class BotPlayer extends Player {
  // Bot-owned settings can live on your subclass.
  public maxVolume = 100

  override async setVolume(volume: number) {
    if (Number.isFinite(volume)) {
      volume = Math.min(volume, this.maxVolume)
    }
    return super.setVolume(volume)
  }

  // A new method, callable from your commands after narrowing to BotPlayer.
  async playNow(track: Track) {
    return this.play(track, { noReplace: false })
  }
}
