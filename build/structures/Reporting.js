const { AqualinkEvents } = require('./AqualinkEvents')

function normalizeError(error, fallback = 'Unknown error') {
  if (error instanceof Error) return error
  if (typeof error === 'string' && error) return new Error(error)
  if (error && typeof error.message === 'string' && error.message) {
    return new Error(error.message)
  }
  return new Error(fallback)
}

function getAqua(target) {
  return target?.aqua || target || null
}

function reportSuppressedError(target, scope, error, data = null) {
  const aqua = getAqua(target)
  const err = normalizeError(error, `Suppressed error in ${scope}`)
  aqua?._trace?.(`${scope}.suppressed`, {
    ...(data || {}),
    error: err.message
  })
  aqua?.emit?.(AqualinkEvents.Debug, err)
  return err
}

module.exports = {
  normalizeError,
  reportSuppressedError
}
