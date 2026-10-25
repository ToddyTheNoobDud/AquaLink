import type { Logger } from '../src/index.ts'

// Pass client.logger here. This shape avoids making Seyfert a library dependency.
// Seyfert keeps control of levels, colors, formatting and output.
export function createSeyfertLogger(logger: {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  error(...args: unknown[]): void
}): Logger {
  const forward = (
    level: 'debug' | 'info' | 'error',
    fieldsOrMessage: object | string,
    message?: string
  ) => {
    if (typeof fieldsOrMessage === 'string') {
      logger[level]('[AquaLink]', fieldsOrMessage)
      return
    }
    logger[level]('[AquaLink]', message ?? '', fieldsOrMessage)
  }

  return {
    debug: (fieldsOrMessage, message) =>
      forward('debug', fieldsOrMessage, message),
    info: (fieldsOrMessage, message) =>
      forward('info', fieldsOrMessage, message),
    error: (fieldsOrMessage, message) =>
      forward('error', fieldsOrMessage, message)
  }
}
