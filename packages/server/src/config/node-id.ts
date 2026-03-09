import { randomUUID } from 'crypto'

/**
 * Stable identifier for this server process instance.
 *
 * Generated once at startup — unique across all nodes in the cluster.
 * Used by the pub/sub layer to de-duplicate Redis messages: the publishing
 * node always broadcasts to its own local sockets directly, then embeds
 * this ID in the Redis payload so its own subscriber callback can skip the
 * message and avoid double-emitting to local clients.
 */
export const NODE_ID = randomUUID()
