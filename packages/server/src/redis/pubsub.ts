import { pubClient, subClient } from './client'
import { logger } from '../utils/logger'

// Channel naming convention — always follow this:
//   doc:{docId}          operations for a specific document
//   presence:{docId}     cursor + user state for a document
//   workspace:{wsId}     workspace-level events

type MessageHandler = (data: unknown) => void | Promise<void>

/** Single shared dispatch map mapping channel to a set of handlers. */
const channelHandlers = new Map<string, Set<MessageHandler>>()

/** In-flight SUBSCRIBE promises, keyed by channel. */
const pendingSubscribes = new Map<string, Promise<void>>()

/** In-flight UNSUBSCRIBE promises, keyed by channel. */
const pendingUnsubscribes = new Map<string, Promise<void>>()

subClient.on('message', (channel, message) => {
  const handlers = channelHandlers.get(channel)
  if (!handlers) return
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch {
    // Malformed JSON — log and ignore.
    logger.warn({ channel, message }, 'Redis: received malformed JSON message')
    return
  }
  for (const handler of handlers) {
    Promise.resolve()
      .then(() => handler(parsed))
      .catch((err: unknown) => {
        logger.warn({ channel, err }, 'Redis: message handler threw — skipping')
      })
  }
})

/** Publish a JSON-serialisable payload to a Redis channel using the pub client. */
export async function publish(channel: string, data: unknown): Promise<void> {
  await pubClient.publish(channel, JSON.stringify(data))
}

function buildUnsubscribe(channel: string, handler: MessageHandler): () => Promise<void> {
  let called = false
  return async () => {
    // Idempotent: safe if called multiple times.
    if (called) return
    called = true

    const handlers = channelHandlers.get(channel)
    if (!handlers) return
    handlers.delete(handler)
    if (handlers.size > 0) return

    // Last handler removed: send UNSUBSCRIBE to Redis or wait on existing in-flight UNSUBSCRIBE.
    if (pendingUnsubscribes.has(channel)) {
      await pendingUnsubscribes.get(channel)
      return
    }

    // Wait on command, retaining channelHandlers entry on failure.
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

/** Subscribes to a Redis channel and invokes `handler` for each message, returning an unsubscribe callback. */
export async function subscribe(
  channel: string,
  handler: MessageHandler
): Promise<() => Promise<void>> {
  // Drain any in-flight UNSUBSCRIBE first.
  if (pendingUnsubscribes.has(channel)) {
    await pendingUnsubscribes.get(channel)
  }

  if (pendingSubscribes.has(channel)) {
    // Await an existing in-flight SUBSCRIBE.
    await pendingSubscribes.get(channel)
  } else if (!channelHandlers.has(channel)) {
    // Add handler and issue the SUBSCRIBE.
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
    // Handler already added above immediately return the unsubscribe function.
    return buildUnsubscribe(channel, handler)
  }

  // Existing subscription: add handler now.
  channelHandlers.get(channel)!.add(handler)

  return buildUnsubscribe(channel, handler)
}
