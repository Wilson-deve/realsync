import Redis from 'ioredis'
import { env } from '../config/env'
import { logger } from '../utils/logger'

// Redis requires separate client instances for pub and sub since a subscribed client cannot publish.

export const pubClient = new Redis(env.REDIS_URL, { lazyConnect: true })
export const subClient = new Redis(env.REDIS_URL, { lazyConnect: true })

// Attach error listeners immediately to prevent ioredis errors from crashing the process.
pubClient.on('error', (err) => logger.error({ err: err.message }, 'Redis pubClient error'))
subClient.on('error', (err) => logger.error({ err: err.message }, 'Redis subClient error'))

/** Connect both Redis clients concurrently, disconnecting both if either fails. */
export async function connectRedis(): Promise<void> {
  try {
    await Promise.all([pubClient.connect(), subClient.connect()])
  } catch (err) {
    await Promise.allSettled([pubClient.disconnect(), subClient.disconnect()])
    throw err
  }
}
