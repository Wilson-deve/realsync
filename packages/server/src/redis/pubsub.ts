import { pubClient, subClient } from './client'
import { logger } from '../utils/logger'

// Channel naming convention — always follow this:
//   doc:{docId}          operations for a specific document
//   presence:{docId}     cursor + user state for a document
//   workspace:{wsId}     workspace-level events

type MessageHandler = (data: unknown) => void

/**
 * Single shared dispatch map: channel → set of handlers.
 * A single 'message' listener on subClient fans out to the right handlers
 * instead of adding one listener per subscribe() call.
 */
const channelHandlers = new Map<string, Set<MessageHandler>>()

subClient.on('message', (channel, message) => {
  const handlers = channelHandlers.get(channel)
  if (!handlers) return
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch {
    // Malformed JSON — log and ignore. Never crash the process over a bad message.
    logger.warn({ channel, message }, 'Redis: received malformed JSON message')
    return
  }
  for (const handler of handlers) {
    handler(parsed)
  }
})

/**
 * Publish a JSON-serialisable payload to a Redis channel.
 * Uses the dedicated pub client (never the sub client).
 */
export async function publish(channel: string, data: unknown): Promise<void> {
  await pubClient.publish(channel, JSON.stringify(data))
}

/**
 * Subscribe to a Redis channel and invoke `handler` for each message.
 * Multiple handlers on the same channel share a single Redis subscription
 * and a single 'message' listener — no per-call listener is added.
 * Returns an unsubscribe function that removes this handler only.
 * Throws if the underlying Redis SUBSCRIBE command fails.
 */
export async function subscribe(channel: string, handler: MessageHandler): Promise<() => void> {
  if (!channelHandlers.has(channel)) {
    channelHandlers.set(channel, new Set())
    try {
      await subClient.subscribe(channel)
    } catch (err) {
      channelHandlers.delete(channel)
      throw new Error(
        `Redis subscribe error on channel ${channel}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  channelHandlers.get(channel)!.add(handler)

  return () => {
    const handlers = channelHandlers.get(channel)
    if (!handlers) return
    handlers.delete(handler)
    if (handlers.size === 0) {
      channelHandlers.delete(channel)
      subClient.unsubscribe(channel).catch((err: unknown) => {
        logger.warn(
          { channel, err: err instanceof Error ? err.message : String(err) },
          'Redis: unsubscribe failed'
        )
      })
    }
  }
}
