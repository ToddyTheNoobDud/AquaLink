const unrefTimer = (t) => {
  try {
    t?.unref?.()
  } catch {}
}

const noop = () => {}

const EMPTY_ARRAY = Object.freeze([])

const clamp = (v, min = 0, max = 200) => {
  const n = +v
  return Number.isNaN(n) ? max : n < min ? min : n > max ? max : n
}

const isNum = (v) =>
  typeof v === 'number' && !Number.isNaN(v) && Number.isFinite(v)

const safeCall = (fn) => {
  try {
    const result = fn()
    return result?.then ? result.catch(noop) : result
  } catch {}
}

const computeAccuratePosition = (player) => {
  let position = player.position || 0
  if (player.playing && !player.paused && player.timestamp) {
    const elapsed = Date.now() - player.timestamp
    const maxDuration =
      player.current?.info?.length || player.current?.duration || Infinity
    position = Math.min(position + elapsed, maxDuration)
  }
  return position
}

const clearTimer = (timerRef) => {
  if (!timerRef.current) return
  clearTimeout(timerRef.current)
  timerRef.current = null
}

const clearIntervalRef = (timerRef) => {
  if (!timerRef.current) return
  clearInterval(timerRef.current)
  timerRef.current = null
}

const unrefTimeout = (fn, ms) => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return t
}

const isValidBase64 = (str) => {
  if (typeof str !== 'string' || !str) return false
  const len = str.length
  if (len % 4 === 1) return false
  for (let i = 0; i < len; i++) {
    const c = str.charCodeAt(i)
    if (
      !(
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) ||
        c === 43 ||
        c === 47 ||
        c === 61 ||
        c === 95 ||
        c === 45
      )
    )
      return false
  }
  return true
}

const errMsg = (err) => err?.message || String(err)

module.exports = {
  unrefTimer,
  noop,
  EMPTY_ARRAY,
  clamp,
  isNum,
  safeCall,
  computeAccuratePosition,
  clearTimer,
  clearIntervalRef,
  unrefTimeout,
  isValidBase64,
  errMsg
}
