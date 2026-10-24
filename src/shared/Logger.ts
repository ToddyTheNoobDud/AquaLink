import process from 'node:process'
import { inspect } from 'node:util'
import type { Logger, LogLevel } from '../types/shared.ts'

const logLevels: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Infinity
}

/** Small stdout logger. Filtering happens before formatting or writing anything.
 * Uses stdout's own buffering; it doesn't keep a separate queue or drop messages.
 */
export default function createLogger(level: LogLevel = 'info'): Logger {
  const minimumLevel = logLevels[level]
  if (minimumLevel === undefined) {
    throw new RangeError(`Unknown log level: ${level}`)
  }

  const write = (
    level: 'debug' | 'info' | 'error',
    fieldsOrMessage: object | string,
    message?: string
  ) => {
    if (logLevels[level] < minimumLevel) {
      return
    }

    let text = fieldsOrMessage
    if (typeof fieldsOrMessage !== 'string') {
      const fields = inspect(fieldsOrMessage, {
        colors: false,
        breakLength: Infinity
      })
      text = message ? `${message} ${fields}` : fields
    }
    process.stdout.write(
      `[${new Date().toISOString()}] ${level.toUpperCase()} [AquaLink] ${text}\n`
    )
  }

  return {
    debug: (fieldsOrMessage, message) =>
      write('debug', fieldsOrMessage, message),
    info: (fieldsOrMessage, message) => write('info', fieldsOrMessage, message),
    error: (fieldsOrMessage, message) =>
      write('error', fieldsOrMessage, message)
  }
}
