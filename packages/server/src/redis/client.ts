import Redis from 'ioredis'
import { env } from '../config/env'
import { logger } from '../utils/logger'

// IMPORTANT: Redis requires separate client instances for pub and sub.
// A client in subscribe mode can ONLY receive messages — it cannot publish.
// Attempting to publish from a subscribed client throws an error.

export const pubClient = new Redis(env.REDIS_URL, { lazyConnect: true })
export const subClient = new Redis(env.REDIS_URL, { lazyConnect: true })

// Attach error listeners immediately so unhandled 'error' events from
// ioredis (e.g. network drops, ECONNREFUSED) don't crash the process.
pubClient.on('error', (err) => logger.error({ err: err.message }, 'Redis pubClient error'))
subClient.on('error', (err) => logger.error({ err: err.message }, 'Redis subClient error'))

/** Connect both Redis clients. Must be called before pub/sub operations.
 * Both connections are attempted concurrently; if either fails the other is
 * disconnected so the process never starts in a partially-connected state.
 */
export async function connectRedis(): Promise<void> {
  try {
    await Promise.all([pubClient.connect(), subClient.connect()])
  } catch (err) {
    await Promise.allSettled([pubClient.disconnect(), subClient.disconnect()])
    throw err
  }
}
