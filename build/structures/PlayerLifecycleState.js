function defineLifecycleAccessor(player, prop, key) {
  Object.defineProperty(player, prop, {
    configurable: true,
    enumerable: false,
    get() {
      return this._lifecycle[key]
    },
    set(value) {
      this._lifecycle[key] = !!value
    }
  })
}

function attachPlayerLifecycleState(player, options = {}) {
  Object.defineProperty(player, '_lifecycle', {
    configurable: true,
    enumerable: false,
    writable: false,
    value: {
      voiceRecovering: false,
      reconnecting: false,
      activelyReconnecting: false,
      resuming: !!options.resuming,
      deferredStart: false
    }
  })

  defineLifecycleAccessor(player, '_voiceRecovering', 'voiceRecovering')
  defineLifecycleAccessor(player, '_reconnecting', 'reconnecting')
  defineLifecycleAccessor(
    player,
    '_isActivelyReconnecting',
    'activelyReconnecting'
  )
  defineLifecycleAccessor(player, '_resuming', 'resuming')
  defineLifecycleAccessor(player, '_deferredStart', 'deferredStart')
  return player._lifecycle
}

module.exports = {
  attachPlayerLifecycleState
}
