import { Filters } from '../src/index.ts'

export class BotFilters extends Filters {
  // One custom preset over the normal equalizer. Other filter types are kept.
  // Disabling this preset clears the equalizer, including any other EQ preset.
  setBassCut(enabled: boolean) {
    return this.setEqualizer(
      enabled
        ? [
            { band: 0, gain: -0.25 },
            { band: 1, gain: -0.25 },
            { band: 2, gain: -0.25 }
          ]
        : []
    )
  }
}
