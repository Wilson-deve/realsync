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

/**
 * In-flight SUBSCRIBE promises, keyed by channel.
 * Concurrent subscribe() calls for the same channel all await the same
 * promise so they either all succeed or all receive the same error.
 * The entry is removed once the SUBSCRIBE settles.
 */
const pendingSubscribes = new Map<string, Promise<void>>()

/**
 * In-flight UNSUBSCRIBE promises, keyed by channel.
 * A new subscribe() for a channel drains any pending UNSUBSCRIBE first so
 * the old fire-and-forget can't race ahead and undo the new subscription.
 */
const pendingUnsubscribes = new Map<string, Promise<void>>()

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
  // Drain any in-flight UNSUBSCRIBE first so we never send SUBSCRIBE while
  // Redis is still processing a prior UNSUBSCRIBE for the same channel.
  if (pendingUnsubscribes.has(channel)) {
    await pendingUnsubscribes.get(channel)
  }

  if (pendingSubscribes.has(channel)) {
    // Another caller is mid-SUBSCRIBE for this channel — await it so we either
    // share the success or propagate the same failure.
    await pendingSubscribes.get(channel)
  } else if (!channelHandlers.has(channel)) {
    // First subscriber for this channel: initiate the Redis SUBSCRIBE and
    // record the in-flight promise so concurrent callers can join it.
    const pending = subClient
      .subscribe(channel)
      .then(() => {
        channelHandlers.set(channel, new Set())
      })
      .catch((err: unknown) => {
        throw new Error(
          `Redis subscribe error on channel ${channel}: ${err instanceof Error ? err.message : String(err)}`
        )
      })
      .finally(() => {
        pendingSubscribes.delete(channel)
      })
    pendingSubscribes.set(channel, pending)
    await pending
  }

  // Safe: channelHandlers entry is guaranteed to exist after await above.
  channelHandlers.get(channel)!.add(handler)

  return () => {
    const handlers = channelHandlers.get(channel)
    if (!handlers) return
    handlers.delete(handler)
    if (handlers.size === 0) {
      channelHandlers.delete(channel)
      const pending: Promise<void> = subClient
        .unsubscribe(channel)
        .then(() => undefined)
        .catch((err: unknown) => {
          logger.warn(
            { channel, err: err instanceof Error ? err.message : String(err) },
            'Redis: unsubscribe failed'
          )
        })
        .finally(() => {
          pendingUnsubscribes.delete(channel)
        })
      pendingUnsubscribes.set(channel, pending)
    }
  }
}
