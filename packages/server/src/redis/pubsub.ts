import { pubClient, subClient } from './client'

// Channel naming convention — always follow this:
//   doc:{docId}          operations for a specific document
//   presence:{docId}     cursor + user state for a document
//   workspace:{wsId}     workspace-level events

/**
 * Publish a JSON-serialisable payload to a Redis channel.
 * Uses the dedicated pub client (never the sub client).
 */
export async function publish(channel: string, data: unknown): Promise<void> {
  await pubClient.publish(channel, JSON.stringify(data))
}

/**
 * Subscribe to a Redis channel and invoke `handler` for each message.
 * Parses the message as JSON before passing it to the handler.
 * Malformed JSON is silently ignored — it never crashes the process.
 */
export function subscribe(channel: string, handler: (data: unknown) => void): void {
  subClient.subscribe(channel, (err) => {
    if (err) throw new Error(`Redis subscribe error on channel ${channel}: ${err.message}`)
  })

  subClient.on('message', (ch, message) => {
    if (ch !== channel) return
    try {
      handler(JSON.parse(message))
    } catch {
      // Malformed JSON — log and ignore. Never crash the process over a bad message.
    }
  })
}
