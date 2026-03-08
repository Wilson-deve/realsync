import type { Server, Socket } from 'socket.io'
import type { Op } from '@realsync/ot-engine'
import { WS } from '../events'
import type { ServerToClientEvents, ClientToServerEvents } from '../events'
import { getOperationsSince, saveOperation, getMaxOperationVersion } from '../../db/operations'
import { getDocument } from '../../db/documents'
import { publish } from '../../redis/pubsub'
import {
  acquireLock,
  releaseLock,
  getDocVersion,
  setDocVersion,
  getSession,
} from '../../redis/session'
import { logger } from '../../utils/logger'
import type { SocketData } from '../server'
import { NODE_ID } from '../../config/node-id'
import { transformAgainstServerOps } from '../../ot/server-ot'
import { takeSnapshot } from '../../ot/snapshot'
import { env } from '../../config/env'

interface OpSubmitPayload {
  docId: string
  op: Op
  clientVersion: number
}

function isNonNegativeInteger(n: unknown): boolean {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0
}

function isPositiveInteger(n: unknown): boolean {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n > 0
}

function isValidOp(value: unknown): value is Op {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.type === 'insert') {
    return isNonNegativeInteger(v.position) && typeof v.content === 'string'
  }
  if (v.type === 'delete') {
    return isNonNegativeInteger(v.position) && isPositiveInteger(v.length)
  }
  if (v.type === 'retain') {
    return isPositiveInteger(v.length)
  }
  return false
}

/**
 * Handle an `op:submit` event from a connected client.
 *
 * This is the critical hot path — every keystroke flows through here.
 * The 9-step OT flow ensures all concurrently-editing clients converge
 * to the same document state:
 *
 *  1. Validate the incoming payload.
 *  2. Acquire a per-document mutex (prevents version collisions).
 *  3. Resolve the current server version; reject if client is ahead.
 *  4. Fetch all server ops since the client's local version.
 *  5. Transform the client op against those server ops.
 *  6. Persist the *transformed* op with the new server version.
 *  7. Update the Redis version counter.
 *  8. Acknowledge the sender.
 *  9. Broadcast via Redis pub/sub to all server nodes.
 *
 * The lock is always released in the finally block — a leaked lock would
 * permanently freeze editing for the affected document.
 */
export async function handleOpSubmit(
  io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>,
  payload: unknown
): Promise<void> {
  // Step 1 — validate payload shape arriving from the wire.
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as Record<string, unknown>).docId !== 'string' ||
    !isNonNegativeInteger((payload as Record<string, unknown>).clientVersion) ||
    !isValidOp((payload as Record<string, unknown>).op)
  ) {
    socket.emit(WS.ERROR, {
      code: 'INVALID_PAYLOAD',
      message: 'op:submit requires docId, a non-negative integer clientVersion, and a valid op',
    })
    return
  }

  const { docId, op, clientVersion } = payload as OpSubmitPayload
  const lockKey = `lock:doc:${docId}`
  const start = Date.now()

  // Authorisation guard: reject ops from sockets that haven't joined the room.
  // A socket must complete room:join (which validates workspace ownership) before
  // submitting ops — this prevents arbitrary document writes via a known docId.
  const session = await getSession(socket.id)
  if (!session || session.docId !== docId || !socket.rooms.has(docId)) {
    socket.emit(WS.ERROR, {
      code: 'FORBIDDEN',
      message: 'Join the document room before submitting operations',
    })
    return
  }

  // Step 2 — acquire per-document lock.
  // Only one op can be processed for a given document at a time.
  // Without this lock, two concurrent ops might both read version=5,
  // both think they are version=6, and we get a version collision.
  let lockToken: string
  try {
    lockToken = await acquireLock(lockKey, env.OP_LOCK_TTL_MS, 3000)
  } catch {
    socket.emit(WS.ERROR, { code: 'LOCK_TIMEOUT', message: 'Server is busy — please retry' })
    return
  }

  try {
    // Step 3 — resolve the authoritative server version inside the lock.
    // This must happen before fetching ops so we can detect a "client ahead"
    // condition (clientVersion > currentVersion) which means the client has a
    // version that doesn’t exist on the server yet — an impossible state under
    // normal operation that indicates the client is out of sync.
    let currentVersion = await getDocVersion(docId)
    if (currentVersion === null) {
      // Key missing: seed Redis from the highest version already in Postgres.
      currentVersion = await getMaxOperationVersion(docId)
      await setDocVersion(docId, currentVersion)
      logger.info({ docId, currentVersion }, 'op:submit: seeded Redis version counter from DB')
    }

    if (clientVersion > currentVersion) {
      // Client claims to be ahead of the server — this should never happen in
      // normal operation.  Force a reconnect so the client resets to the real
      // server state rather than persisting a logically invalid op.
      logger.warn(
        { docId, clientVersion, currentVersion },
        'op:submit: clientVersion ahead of server — forcing reconnect'
      )
      const doc = await getDocument(docId)
      const ops = doc ? await getOperationsSince(docId, doc.snapshotVersion) : []
      socket.emit(WS.DOC_RECONNECT, {
        snapshot: doc?.snapshotContent ?? '',
        version: doc?.snapshotVersion ?? 0,
        ops,
      })
      return
    }

    // Step 4 — fetch all operations applied since the client’s version.
    const serverOps = await getOperationsSince(docId, clientVersion)

    // Step 5 — transform the incoming op against every server op since clientVersion.
    const transformedOp = transformAgainstServerOps(op, serverOps)

    // Step 6 — persist the transformed op with the new server version.
    const serverVersion = currentVersion + 1
    await saveOperation(docId, socket.data.userId, transformedOp, serverVersion)

    // Step 7 — update the version counter in Redis.
    await setDocVersion(docId, serverVersion)

    // Step 8 — acknowledge the sender.
    // The op is durably persisted and the version counter is advanced, so we
    // ack unconditionally here.  Broadcast can fail independently (see step 9)
    // but the committed serverVersion must be returned to the client so it can
    // update its local version and avoid retrying an already-applied op.
    socket.emit(WS.OP_ACK, { serverVersion, timestamp: Date.now() })

    // Step 9 — broadcast to all clients.
    // Always emit to sockets on THIS node directly: reliable local delivery
    // must not depend on the Redis subscription being healthy.  For cross-node
    // fanout, publish via Redis pub/sub; the publisherId field lets other nodes
    // broadcast to their own clients while this node's subscription callback
    // ignores the echo and avoids double-emitting.
    const broadcastPayload = {
      op: transformedOp,
      authorId: socket.data.userId,
      serverVersion,
      publisherId: NODE_ID,
    }

    // Local emit always happens unconditionally.
    io.to(docId).emit(WS.OP_BROADCAST, broadcastPayload)

    // Cross-node fanout via Redis.  A failure here means remote nodes miss
    // this op until the affected clients reconnect, but local clients are
    // already covered.  Log for alerting so ops-on-call can investigate.
    try {
      await publish(`doc:${docId}`, broadcastPayload)
    } catch (pubErr) {
      logger.error(
        { pubErr, docId, serverVersion },
        'op:submit: Redis publish failed — remote nodes will not receive this op'
      )
    }

    // Snapshot optimisation: every 100 ops, compute and store a full document
    // state to keep replay time bounded. Runs outside the lock window.
    if (serverVersion % 100 === 0) {
      setImmediate(() => {
        void takeSnapshot(docId, serverVersion)
      })
    }

    logger.debug({ docId, serverVersion, latencyMs: Date.now() - start }, 'op:submit processed')
  } catch (err) {
    logger.error({ err, docId }, 'handleOpSubmit: error processing operation')
    socket.emit(WS.ERROR, { code: 'INTERNAL_ERROR', message: 'Failed to process operation' })
  } finally {
    // ALWAYS attempt to release the lock — a leaked lock freezes editing for
    // this document. Wrap in try/catch so a Redis network error here does not
    // become an unhandled rejection: the caller invokes this handler
    // fire-and-forget (void ...), so any rejection escaping the finally block
    // would not be caught and could crash the process.
    try {
      await releaseLock(lockKey, lockToken!)
    } catch (releaseErr) {
      logger.error(
        { releaseErr, lockKey, docId },
        'handleOpSubmit: releaseLock failed — lock may have expired'
      )
    }
  }
}
