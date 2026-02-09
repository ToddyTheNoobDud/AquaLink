const FILTER_DEFAULTS = Object.freeze({
  karaoke: Object.freeze({
    level: 1,
    monoLevel: 1,
    filterBand: 220,
    filterWidth: 100
  }),
  timescale: Object.freeze({ speed: 1, pitch: 1, rate: 1 }),
  tremolo: Object.freeze({ frequency: 2, depth: 0.5 }),
  vibrato: Object.freeze({ frequency: 2, depth: 0.5 }),
  rotation: Object.freeze({ rotationHz: 0 }),
  distortion: Object.freeze({
    sinOffset: 0,
    sinScale: 1,
    cosOffset: 0,
    cosScale: 1,
    tanOffset: 0,
    tanScale: 1,
    offset: 0,
    scale: 1
  }),
  channelMix: Object.freeze({
    leftToLeft: 1,
    leftToRight: 0,
    rightToLeft: 0,
    rightToRight: 1
  }),
  lowPass: Object.freeze({ smoothing: 20 })
})

const FILTER_KEYS = Object.freeze(
  Object.fromEntries(
    Object.entries(FILTER_DEFAULTS).map(([k, v]) => [
      k,
      Object.freeze(Object.keys(v))
    ])
  )
)

const EMPTY_ARRAY = Object.freeze([])

const FILTER_POOL_SIZE = 16
const filterPool = {
  pools: Object.fromEntries(Object.keys(FILTER_DEFAULTS).map(k => [k, []])),

  acquire(type) {
    const pool = this.pools[type]
    if (pool && pool.length > 0) {
      return pool.pop()
    }
    return { ...FILTER_DEFAULTS[type] }
  },

  release(type, obj) {
    if (!obj || !this.pools[type]) return
    const pool = this.pools[type]
    if (pool.length < FILTER_POOL_SIZE) {
      pool.push(obj)
    }
  }
}

const _utils = Object.freeze({
  shallowEqual(current, defaults, override, keys) {
    if (!current) return false
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]
      const expected = k in override ? override[k] : defaults[k]
      if (current[k] !== expected) return false
    }
    return true
  },

  equalizerEqual(a, b) {
    if (a === b) return true
    const lenA = a?.length || 0
    const lenB = b?.length || 0
    if (lenA !== lenB) return false
    for (let i = 0; i < lenA; i++) {
      const x = a[i],
        y = b[i]
      if (x.band !== y.band || x.gain !== y.gain) return false
    }
    return true
  },

  eqIsEmpty(arr) {
    return !arr || arr.length === 0
  },

  makeEqArray(len, gain) {
    const out = new Array(len)
    for (let i = 0; i < len; i++) out[i] = { band: i, gain }
    return out
  },

  mutateFilter(target, defaults, options, keys) {
    let changed = false
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]
      const newVal = k in options ? options[k] : defaults[k]
      if (target[k] !== newVal) {
        target[k] = newVal
        changed = true
      }
    }
    return changed
  }
})

class Filters {
  constructor(player, options = {}) {
    if (!player) throw new Error('Player instance is required')
    this.player = player
    this._pendingUpdate = false
    this._dirty = new Set()

    this.filters = {
      volume: options.volume ?? 1,
      equalizer: options.equalizer ?? EMPTY_ARRAY,
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

  destroy() {
    for (const [key, value] of Object.entries(this.filters)) {
      if (value && typeof value === 'object' && key !== 'equalizer') {
        filterPool.release(key, value)
      }
    }
    this._pendingUpdate = false
    this.player = null
  }

  _setFilter(filterName, enabled, options = {}) {
    const current = this.filters[filterName]
    if (!enabled) {
      if (current === null) return this
      filterPool.release(filterName, current)
      this.filters[filterName] = null
      this._dirty.add(filterName)
      return this._scheduleUpdate()
    }

    const defaults = FILTER_DEFAULTS[filterName]
    const keys = FILTER_KEYS[filterName]

    if (current) {
      if (_utils.shallowEqual(current, defaults, options, keys)) {
        return this
      }
      _utils.mutateFilter(current, defaults, options, keys)
      this._dirty.add(filterName)
      return this._scheduleUpdate()
    }

    const newFilter = filterPool.acquire(filterName)
    _utils.mutateFilter(newFilter, defaults, options, keys)
    this.filters[filterName] = newFilter
    this._dirty.add(filterName)
    return this._scheduleUpdate()
  }

  _scheduleUpdate() {
    if (this._pendingUpdate || !this.player) return this
    this._pendingUpdate = true
    queueMicrotask(() => {
      this._pendingUpdate = false
      if (this.player) {
        this.updateFilters().catch(() => {})
      }
    })
    return this
  }

  setEqualizer(bands) {
    const next = bands ?? EMPTY_ARRAY
    if (_utils.equalizerEqual(this.filters.equalizer, next)) return this
    this.filters.equalizer = next
    this._dirty.add('equalizer')
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
      if (
        this.presets.bassboost === null &&
        _utils.eqIsEmpty(this.filters.equalizer)
      )
        return this
      this.presets.bassboost = null
      return this.setEqualizer(EMPTY_ARRAY)
    }

    const value = options.value ?? 5
    if (value < 0 || value > 5)
      throw new Error('Bassboost value must be between 0 and 5')
    if (this.presets.bassboost === value) return this

    this.presets.bassboost = value
    const gain = (value - 1) * (1.25 / 9) - 0.25

    const current = Array.isArray(this.filters.equalizer)
      ? [...this.filters.equalizer]
      : []
    const bands = _utils.makeEqArray(13, gain)

    for (const b of bands) {
      const idx = current.findIndex((e) => e.band === b.band)
      if (idx !== -1) current[idx] = b
      else current.push(b)
    }

    return this.setEqualizer(current)
  }

  setSlowmode(enabled, options = {}) {
    const rate = enabled ? (options.rate ?? 0.8) : 1
    if (
      this.presets.slowmode === enabled &&
      this.filters.timescale?.rate === rate
    )
      return this
    this.presets.slowmode = enabled
    return this.setTimescale(enabled, { rate })
  }

  setNightcore(enabled, options = {}) {
    const rate = enabled ? (options.rate ?? 1.5) : 1
    if (
      this.presets.nightcore === enabled &&
      this.filters.timescale?.rate === rate
    )
      return this
    this.presets.nightcore = enabled
    return this.setTimescale(enabled, { rate })
  }

  setVaporwave(enabled, options = {}) {
    const pitch = enabled ? (options.pitch ?? 0.5) : 1
    if (
      this.presets.vaporwave === enabled &&
      this.filters.timescale?.pitch === pitch
    )
      return this
    this.presets.vaporwave = enabled
    return this.setTimescale(enabled, { pitch })
  }

  set8D(enabled, options = {}) {
    const rotationHz = enabled ? (options.rotationHz ?? 0.2) : 0
    if (
      this.presets._8d === enabled &&
      this.filters.rotation?.rotationHz === rotationHz
    )
      return this
    this.presets._8d = enabled
    return this.setRotation(enabled, { rotationHz })
  }

  async clearFilters() {
    const f = this.filters
    let changed = false

    if (f.volume !== 1) {
      f.volume = 1
      this._dirty.add('volume')
      changed = true
    }
    if (!_utils.eqIsEmpty(f.equalizer)) {
      f.equalizer = EMPTY_ARRAY
      this._dirty.add('equalizer')
      changed = true
    }

    const filterNames = Object.keys(FILTER_DEFAULTS)
    for (let i = 0; i < filterNames.length; i++) {
      const key = filterNames[i]
      if (f[key] !== null) {
        f[key] = null
        this._dirty.add(key)
        changed = true
      }
    }

    for (const key in this.presets) {
      if (this.presets[key] !== null) this.presets[key] = null
    }

    return changed ? this.updateFilters() : this
  }

  async updateFilters() {
    if (!this.player || !this._dirty.size) return this

    const payload = {}
    for (const key of this._dirty) {
      payload[key] = this.filters[key]
    }

    this._dirty.clear()

    await this.player.nodes.rest.updatePlayer({
      guildId: this.player.guildId,
      data: { filters: payload }
    })
    return this
  }
}

module.exports = Filters
