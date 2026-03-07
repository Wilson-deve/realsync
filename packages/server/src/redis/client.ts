import Redis from 'ioredis'
import { env } from '../config/env'

// IMPORTANT: Redis requires separate client instances for pub and sub.
// A client in subscribe mode can ONLY receive messages — it cannot publish.
// Attempting to publish from a subscribed client throws an error.

export const pubClient = new Redis(env.REDIS_URL, { lazyConnect: true })
export const subClient = new Redis(env.REDIS_URL, { lazyConnect: true })

/** Connect both Redis clients. Must be called before pub/sub operations. */
export async function connectRedis(): Promise<void> {
  await pubClient.connect()
  await subClient.connect()
}
