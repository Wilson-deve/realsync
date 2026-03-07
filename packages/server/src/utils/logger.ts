import pino from 'pino'
import { env } from '../config/env'

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport:
    env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
})

/** Returns a child logger with a bound requestId for per-request tracing. */
export function createRequestLogger(requestId: string) {
  return logger.child({ requestId })
}
