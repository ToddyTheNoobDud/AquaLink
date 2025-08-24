'use strict'

const FILTER_DEFAULTS = Object.freeze({
  karaoke: Object.freeze({ level: 1, monoLevel: 1, filterBand: 220, filterWidth: 100 }),
  timescale: Object.freeze({ speed: 1, pitch: 1, rate: 1 }),
  tremolo: Object.freeze({ frequency: 2, depth: 0.5 }),
  vibrato: Object.freeze({ frequency: 2, depth: 0.5 }),
  rotation: Object.freeze({ rotationHz: 0 }),
  distortion: Object.freeze({ sinOffset: 0, sinScale: 1, cosOffset: 0, cosScale: 1, tanOffset: 0, tanScale: 1, offset: 0, scale: 1 }),
  channelMix: Object.freeze({ leftToLeft: 1, leftToRight: 0, rightToLeft: 0, rightToRight: 1 }),
  lowPass: Object.freeze({ smoothing: 20 })
})

const fnShallowEqualWithDefaults = (current, defaults, override) => {
  if (!current) return false
  const keys = Object.keys(defaults)
  return keys.every(k => current[k] === (k in override ? override[k] : defaults[k]))
}

const fnEqualizerEqual = (a, b) => {
  const aa = a || []
  const bb = b || []
  if (aa === bb) return true
  if (aa.length !== bb.length) return false
  return aa.every((x, i) => x.band === bb[i].band && x.gain === bb[i].gain)
}

class Filters {
  constructor(player, options = {}) {
    this.player = player
    this._pendingUpdate = false

    this.filters = {
      volume: options.volume ?? 1,
      equalizer: options.equalizer ?? [],
      karaoke: options.karaoke ?? null,
      timescale: options.timescale ?? null,
      tremolo: options.tremolo ?? null,
      vibrato: options.vibrato ?? null,
      rotation: options.rotation ?? null,
      distortion: options.distortion ?? null,
      channelMix: options.channelMix ?? null,
      lowPass: options.lowPass ?? null
    }

    this.presets = {
      bassboost: options.bassboost ?? null,
      slowmode: options.slowmode ?? null,
      nightcore: options.nightcore ?? null,
      vaporwave: options.vaporwave ?? null,
      _8d: options._8d ?? null
    }
  }

  _setFilter(filterName, enabled, options = {}) {
    const current = this.filters[filterName]
    if (!enabled) {
      if (current === null) return this
      this.filters[filterName] = null
      return this._scheduleUpdate()
    }
    const defaults = FILTER_DEFAULTS[filterName]
    if (current && fnShallowEqualWithDefaults(current, defaults, options)) return this
    this.filters[filterName] = { ...defaults, ...options }
    return this._scheduleUpdate()
  }

  _scheduleUpdate() {
    if (this._pendingUpdate) return this
    this._pendingUpdate = true
    queueMicrotask(() => {
      this._pendingUpdate = false
      this.updateFilters().catch(() => {})
    })
    return this
  }

  setEqualizer(bands) {
    const next = bands || []
    if (fnEqualizerEqual(this.filters.equalizer, next)) return this
    this.filters.equalizer = next
    return this._scheduleUpdate()
  }

  setKaraoke(enabled, options = {}) {
    return this._setFilter('karaoke', enabled, options)
  }

  setTimescale(enabled, options = {}) {
    return this._setFilter('timescale', enabled, options)
  }

  setTremolo(enabled, options = {}) {
    return this._setFilter('tremolo', enabled, options)
  }

  setVibrato(enabled, options = {}) {
    return this._setFilter('vibrato', enabled, options)
  }

  setRotation(enabled, options = {}) {
    return this._setFilter('rotation', enabled, options)
  }

  setDistortion(enabled, options = {}) {
    return this._setFilter('distortion', enabled, options)
  }

  setChannelMix(enabled, options = {}) {
    return this._setFilter('channelMix', enabled, options)
  }

  setLowPass(enabled, options = {}) {
    return this._setFilter('lowPass', enabled, options)
  }

  setBassboost(enabled, options = {}) {
    if (!enabled) {
      if (this.presets.bassboost === null) return this
      this.presets.bassboost = null
      return this.setEqualizer([])
    }
    const value = options.value ?? 5
    if (value < 0 || value > 5) throw new Error('Bassboost value must be between 0 and 5')
    if (this.presets.bassboost === value) return this
    this.presets.bassboost = value
    const gain = (value - 1) * (1.25 / 9) - 0.25
    const eq = Array.from({ length: 13 }, (_, band) => ({ band, gain }))
    return this.setEqualizer(eq)
  }

  setSlowmode(enabled, options = {}) {
    const rate = enabled ? options.rate ?? 0.8 : 1
    if (this.presets.slowmode === enabled && this.filters.timescale?.rate === rate) return this
    this.presets.slowmode = enabled
    return this.setTimescale(enabled, { rate })
  }

  setNightcore(enabled, options = {}) {
    const rate = enabled ? options.rate ?? 1.5 : 1
    if (this.presets.nightcore === enabled && this.filters.timescale?.rate === rate) return this
    this.presets.nightcore = enabled
    return this.setTimescale(enabled, { rate })
  }

  setVaporwave(enabled, options = {}) {
    const pitch = enabled ? options.pitch ?? 0.5 : 1
    if (this.presets.vaporwave === enabled && this.filters.timescale?.pitch === pitch) return this
    this.presets.vaporwave = enabled
    return this.setTimescale(enabled, { pitch })
  }

  set8D(enabled, options = {}) {
    const rotationHz = enabled ? options.rotationHz ?? 0.2 : 0
    if (this.presets._8d === enabled && this.filters.rotation?.rotationHz === rotationHz) return this
    this.presets._8d = enabled
    return this.setRotation(enabled, { rotationHz })
  }

  async clearFilters() {
    const filters = this.filters
    const changed = Object.keys(filters).reduce((acc, key) => {
      const newValue = key === 'volume' ? 1 : key === 'equalizer' ? [] : null
      if (filters[key] !== newValue) {
        filters[key] = newValue
        return true
      }
      return acc
    }, false)
    for (const key in this.presets) {
      if (this.presets[key] !== null) this.presets[key] = null
    }
    if (!changed) return this
    return this.updateFilters()
  }

  async updateFilters(filters = this.filters) {
    this.filters = filters
    await this.player.nodes.rest.updatePlayer({
      guildId: this.player.guildId,
      data: { filters: this.filters }
    })
    return this
  }
}

module.exports = Filters
