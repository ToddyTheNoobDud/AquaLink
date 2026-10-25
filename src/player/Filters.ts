import type {
  ChannelMixSettings,
  DistortionSettings,
  EqualizerBand,
  FilterOptions,
  KaraokeSettings,
  LowPassSettings,
  RotationSettings,
  TimescaleSettings,
  TremoloSettings,
  VibratoSettings
} from '../types/shared.ts'
import type Player from './Player.ts'

const defaults = {
  karaoke: { level: 1, monoLevel: 1, filterBand: 220, filterWidth: 100 },
  timescale: { speed: 1, pitch: 1, rate: 1 },
  tremolo: { frequency: 2, depth: 0.5 },
  vibrato: { frequency: 2, depth: 0.5 },
  rotation: { rotationHz: 0 },
  distortion: {
    sinOffset: 0,
    sinScale: 1,
    cosOffset: 0,
    cosScale: 1,
    tanOffset: 0,
    tanScale: 1,
    offset: 0,
    scale: 1
  },
  channelMix: {
    leftToLeft: 1,
    leftToRight: 0,
    rightToLeft: 0,
    rightToRight: 1
  },
  lowPass: { smoothing: 20 }
}

/** Local filter settings and presets. Each setter sends one update; await it before the next change.
 * Settings are changed locally before sending and aren't rolled back if the request fails.
 * Timescale presets share the same filter, so the last one replaces the earlier settings.
 * @example await player.filters.setNightcore(true)
 * @example player.filters.filters.pluginFilters = { myFilter: { value: 1 } }; await player.filters.updateFilters()
 */
export default class Filters {
  public filters: FilterOptions

  constructor(
    public player: Player,
    options: FilterOptions = {}
  ) {
    this.filters = {
      volume: 1,
      equalizer: [],
      karaoke: null,
      timescale: null,
      tremolo: null,
      vibrato: null,
      rotation: null,
      distortion: null,
      channelMix: null,
      lowPass: null,
      ...options
    }
  }

  protected setFilter<Key extends keyof typeof defaults>(
    key: Key,
    enabled: boolean,
    options?: FilterOptions[Key]
  ) {
    this.filters[key] = enabled ? { ...defaults[key], ...options } : null
    return this.updateFilters()
  }

  /** Replace equalizer bands. Indexes: 0..14; gains: -0.25..1. Invalid values throw.
   * @example await player.filters.setEqualizer([{ band: 0, gain: 0.2 }])
   */
  setEqualizer(bands: EqualizerBand[]) {
    if (
      bands.some(
        (band) =>
          !Number.isInteger(band.band) ||
          band.band < 0 ||
          band.band > 14 ||
          !Number.isFinite(band.gain) ||
          band.gain < -0.25 ||
          band.gain > 1
      )
    ) {
      throw new RangeError('Equalizer bands need 0..14 and gains -0.25..1.')
    }
    this.filters.equalizer = bands
    return this.updateFilters()
  }

  /** Set karaoke settings, or clear them with false. Omitted fields use the preset defaults. */
  setKaraoke(enabled: boolean, options?: KaraokeSettings) {
    return this.setFilter('karaoke', enabled, options)
  }

  /** Set speed/pitch/rate, or clear timescale with false. Defaults: 1 for each field. */
  setTimescale(enabled: boolean, options?: TimescaleSettings) {
    return this.setFilter('timescale', enabled, options)
  }

  /** Set tremolo, or clear it with false. Defaults: frequency=2, depth=0.5. */
  setTremolo(enabled: boolean, options?: TremoloSettings) {
    return this.setFilter('tremolo', enabled, options)
  }

  /** Set vibrato, or clear it with false. Defaults: frequency=2, depth=0.5. */
  setVibrato(enabled: boolean, options?: VibratoSettings) {
    return this.setFilter('vibrato', enabled, options)
  }

  /** Set rotationHz, or clear rotation with false. Default rotationHz: 0. */
  setRotation(enabled: boolean, options?: RotationSettings) {
    return this.setFilter('rotation', enabled, options)
  }

  /** Set distortion coefficients, or clear distortion with false. */
  setDistortion(enabled: boolean, options?: DistortionSettings) {
    return this.setFilter('distortion', enabled, options)
  }

  /** Set channel routing, or clear it with false. Defaults route left/right to themselves. */
  setChannelMix(enabled: boolean, options?: ChannelMixSettings) {
    return this.setFilter('channelMix', enabled, options)
  }

  /** Set low-pass smoothing, or clear it with false. Default smoothing: 20. */
  setLowPass(enabled: boolean, options?: LowPassSettings) {
    return this.setFilter('lowPass', enabled, options)
  }

  /** Apply the equalizer preset with value 0..5 (default: 5). false clears all equalizer bands. */
  setBassboost(enabled: boolean, options: { value?: number } = {}) {
    const value = options.value ?? 5
    if (!Number.isFinite(value) || value < 0 || value > 5) {
      throw new RangeError('Bassboost needs a value between 0 and 5.')
    }
    const gain = (value - 1) * (1.25 / 9) - 0.25
    return this.setEqualizer(
      enabled ? Array.from({ length: 13 }, (_, band) => ({ band, gain })) : []
    )
  }

  /** Replace timescale with the slowmode rate (default: 0.8). false clears timescale. */
  setSlowmode(enabled: boolean, options: { rate?: number } = {}) {
    return this.setTimescale(enabled, { rate: options.rate ?? 0.8 })
  }

  /** Replace timescale with the nightcore rate (default: 1.5). false clears timescale. */
  setNightcore(enabled: boolean, options: { rate?: number } = {}) {
    return this.setTimescale(enabled, { rate: options.rate ?? 1.5 })
  }

  /** Replace timescale with the vaporwave pitch (default: 0.5). false clears timescale. */
  setVaporwave(enabled: boolean, options: { pitch?: number } = {}) {
    return this.setTimescale(enabled, { pitch: options.pitch ?? 0.5 })
  }

  /** Replace rotation with the 8D preset (default rotationHz: 0.2). false clears rotation. */
  set8D(enabled: boolean, options: RotationSettings = {}) {
    return this.setRotation(enabled, { rotationHz: options.rotationHz ?? 0.2 })
  }

  /** Send an empty filter object to clear protocol and plugin settings.
   * @example await player.filters.clearFilters()
   */
  async clearFilters() {
    this.filters = {}
    return this.updateFilters()
  }

  /** Build a protocol object without null-valued fields. Nested values remain shared. */
  toJSON() {
    const payload: FilterOptions = {}
    for (const [name, value] of Object.entries(this.filters)) {
      if (value !== null) {
        payload[name] = value
      }
    }
    return payload
  }

  /** Send the current filter object, including bot-added plugin fields. Returns this on success.
   * @example player.filters.filters.pluginFilters = { echo: { delay: 500 } }
   * @example await player.filters.updateFilters()
   */
  async updateFilters() {
    await this.player.updatePlayer({ filters: this.toJSON() })
    return this
  }
}
