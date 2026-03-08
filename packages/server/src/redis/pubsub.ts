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
    try {
      handler(parsed)
    } catch (err) {
      logger.warn(
        { channel, err: err instanceof Error ? err.message : String(err) },
        'Redis: message handler threw — skipping'
      )
    }
  }
})

/**
 * Publish a JSON-serialisable payload to a Redis channel.
 * Uses the dedicated pub client (never the sub client).
 */
export async function publish(channel: string, data: unknown): Promise<void> {
  await pubClient.publish(channel, JSON.stringify(data))
}

function buildUnsubscribe(channel: string, handler: MessageHandler): () => Promise<void> {
  let called = false
  return async () => {
    // Idempotent: a second call after the handler was already removed is a no-op.
    if (called) return
    called = true

    const handlers = channelHandlers.get(channel)
    if (!handlers) return
    handlers.delete(handler)
    if (handlers.size > 0) return

    // Last handler removed — send UNSUBSCRIBE to Redis.
    // If an UNSUBSCRIBE is already in flight for this channel (e.g. concurrent
    // last-handler removal), reuse that promise instead of issuing a new command.
    if (pendingUnsubscribes.has(channel)) {
      await pendingUnsubscribes.get(channel)
      return
    }

    // Keep the channelHandlers entry in place until the command succeeds so
    // that in-flight messages don't land in a channel with no record at all.
    // Only delete it once Redis confirms; on failure the entry is retained
    // (Redis is still subscribed) and the error is rethrown so the caller
    // knows the UNSUBSCRIBE did not complete.
    const pending: Promise<void> = subClient
      .unsubscribe(channel)
      .then(() => {
        channelHandlers.delete(channel)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn(
          { channel, err: message },
          'Redis: unsubscribe failed — channel entry retained to stay consistent with Redis'
        )
        throw new Error(`Redis unsubscribe failed for channel ${channel}: ${message}`)
      })
      .finally(() => {
        pendingUnsubscribes.delete(channel)
      })
    pendingUnsubscribes.set(channel, pending)
    await pending
  }
}

/**
 * Subscribe to a Redis channel and invoke `handler` for each message.
 * Multiple handlers on the same channel share a single Redis subscription
 * and a single 'message' listener — no per-call listener is added.
 * Returns an async unsubscribe function that removes this handler only.
 * Await the unsubscribe function to confirm the Redis UNSUBSCRIBE completed.
 * Throws if the underlying Redis SUBSCRIBE command fails.
 */
export async function subscribe(
  channel: string,
  handler: MessageHandler
): Promise<() => Promise<void>> {
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
    // Create the handler Set and add this handler BEFORE issuing the SUBSCRIBE
    // so no messages are dropped in the window between Redis confirming the
    // subscription and the handler being registered. If SUBSCRIBE fails the
    // handler and the Set are both cleaned up in the catch block.
    channelHandlers.set(channel, new Set([handler]))
    const pending: Promise<void> = subClient
      .subscribe(channel)
      .then(() => undefined)
      .catch((err: unknown) => {
        channelHandlers.delete(channel)
        throw new Error(
          `Redis subscribe error on channel ${channel}: ${err instanceof Error ? err.message : String(err)}`
        )
      })
      .finally(() => {
        pendingSubscribes.delete(channel)
      })
    pendingSubscribes.set(channel, pending)
    await pending
    // Handler already added above — return the unsubscribe function directly.
    return buildUnsubscribe(channel, handler)
  }

  // Existing subscription (or just joined an in-flight one): add handler now.
  channelHandlers.get(channel)!.add(handler)

  return buildUnsubscribe(channel, handler)
}
