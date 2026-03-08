import type { Server, Socket } from 'socket.io'
import type { Op } from '@realsync/ot-engine'
import { WS } from '../events'
import type { ServerToClientEvents, ClientToServerEvents } from '../events'
import { getOperationsSince, saveOperation, getMaxOperationVersion } from '../../db/operations'
import { publish } from '../../redis/pubsub'
import {
  acquireLock,
  releaseLock,
  getDocVersion,
  setDocVersion,
  getSession,
} from '../../redis/session'
import { transformAgainstServerOps } from '../../ot/server-ot'
import { takeSnapshot } from '../../ot/snapshot'
import { logger } from '../../utils/logger'
import type { SocketData } from '../server'

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
 * The 8-step OT flow ensures all concurrently-editing clients converge
 * to the same document state:
 *
 *  1. Validate the incoming payload.
 *  2. Acquire a per-document mutex (prevents version collisions).
 *  3. Fetch all server ops since the client's local version.
 *  4. Transform the client op against those server ops.
 *  5. Persist the *transformed* op with the new server version.
 *  6. Update the Redis version counter.
 *  7. Acknowledge the sender.
 *  8. Broadcast via Redis pub/sub to all server nodes.
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
    lockToken = await acquireLock(lockKey, 5000, 3000)
  } catch {
    socket.emit(WS.ERROR, { code: 'LOCK_TIMEOUT', message: 'Server is busy — please retry' })
    return
  }

  try {
    // Step 3 — fetch all operations applied since the client's version.
    const serverOps = await getOperationsSince(docId, clientVersion)

    // Step 4 — transform the incoming op against every server op since clientVersion.
    const transformedOp = transformAgainstServerOps(op, serverOps)

    // Step 5 — resolve the current version, initializing from DB if the Redis
    // key is absent (server restart or cache eviction).  Without this, after
    // eviction getDocVersion would return null → we would compute serverVersion=1
    // and saveOperation would violate the @@unique([docId, version]) constraint.
    let currentVersion = await getDocVersion(docId)
    if (currentVersion === null) {
      // Key missing: seed Redis from the highest version already in Postgres.
      currentVersion = await getMaxOperationVersion(docId)
      await setDocVersion(docId, currentVersion)
      logger.info({ docId, currentVersion }, 'op:submit: seeded Redis version counter from DB')
    }
    const serverVersion = currentVersion + 1
    await saveOperation(docId, socket.data.userId, transformedOp, serverVersion)

    // Step 6 — update the version counter in Redis.
    await setDocVersion(docId, serverVersion)

    // Step 7 — acknowledge the sender.
    // The op is durably persisted and the version counter is advanced, so we
    // ack unconditionally here.  Broadcast can fail independently (see step 8)
    // but the committed serverVersion must be returned to the client so it can
    // update its local version and avoid retrying an already-applied op.
    socket.emit(WS.OP_ACK, { serverVersion, timestamp: Date.now() })

    // Step 8 — broadcast to all clients via Redis pub/sub.
    // If publish() fails (transient Redis error), fall back to a local
    // io.to(docId).emit so clients on THIS node still receive the op.
    // Clients on other nodes will catch up via doc:reconnect on their next
    // connection.  The publish failure is logged for alerting.
    const broadcastPayload = {
      op: transformedOp,
      authorId: socket.data.userId,
      serverVersion,
    }
    try {
      await publish(`doc:${docId}`, broadcastPayload)
    } catch (pubErr) {
      logger.error(
        { pubErr, docId, serverVersion },
        'op:submit: Redis publish failed — falling back to local broadcast'
      )
      io.to(docId).emit(WS.OP_BROADCAST, broadcastPayload)
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
