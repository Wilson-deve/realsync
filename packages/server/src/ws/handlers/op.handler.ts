import type { Server, Socket } from 'socket.io'
import type { Op } from '@realsync/ot-engine'
import { WS } from '../events'
import type { ServerToClientEvents, ClientToServerEvents } from '../events'
import { Prisma } from '@prisma/client'
import { getOperationsSince, saveOperation, getMaxOperationVersion } from '../../db/operations'
import { getDocument } from '../../db/documents'
import { publish } from '../../redis/pubsub'
import {
  acquireLock,
  releaseLock,
  getDocVersion,
  setDocVersion,
  deleteDocVersion,
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

/** Handles an op:submit event, running the OT convergence flow safely under a per-document lock. */
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

  // Authorisation guard: reject ops from sockets not in the document room.
  const session = await getSession(socket.id)
  if (!session || session.docId !== docId || !socket.rooms.has(docId)) {
    socket.emit(WS.ERROR, {
      code: 'FORBIDDEN',
      message: 'Join the document room before submitting operations',
    })
    return
  }

  // Step 2 — acquire per-document lock to prevent version collisions.
  let lockToken: string
  try {
    lockToken = await acquireLock(lockKey, env.OP_LOCK_TTL_MS, 3000)
  } catch {
    socket.emit(WS.ERROR, { code: 'LOCK_TIMEOUT', message: 'Server is busy — please retry' })
    return
  }

  // Flags and values set inside the lock and consumed outside it to minimize critical section.
  let shouldReconnect = false
  let reconnectVersion = 0 // the server version the out-of-sync client should resync to
  // Capture DB-derived version outside try/catch to aid self-healing log.
  let resolvedVersion: number | null = null
  let pendingAck: {
    serverVersion: number
    transformedOp: Op
    authorId: string
  } | null = null

  try {
    // Step 3 — resolve authoritative server version and detect if client is out of sync.
    let currentVersion = await getDocVersion(docId)
    if (currentVersion === null) {
      // Key missing: seed Redis from highest Postgres version.
      currentVersion = await getMaxOperationVersion(docId)
      await setDocVersion(docId, currentVersion)
      logger.info({ docId, currentVersion }, 'op:submit: seeded Redis version counter from DB')
    }
    // Capture for self-healing in post-lock path.
    resolvedVersion = currentVersion

    if (clientVersion > currentVersion) {
      // Signal post-lock path to force reconnect; avoid DB queries in critical section.
      logger.warn(
        { docId, clientVersion, currentVersion },
        'op:submit: clientVersion ahead of server — forcing reconnect'
      )
      shouldReconnect = true
      reconnectVersion = currentVersion
    } else if (currentVersion - clientVersion > env.OP_MAX_CATCHUP_OPS) {
      // Client is too far behind; force a full resync from latest snapshot instead of blocking writers.
      logger.warn(
        { docId, clientVersion, currentVersion, gap: currentVersion - clientVersion },
        'op:submit: client too far behind catch-up window — forcing reconnect'
      )
      shouldReconnect = true
      reconnectVersion = currentVersion
    } else {
      // Step 4 — fetch all operations applied since the client's version.
      const serverOps = await getOperationsSince(docId, clientVersion)

      // Step 5 — transform the incoming op against every server op since clientVersion.
      const transformedOp = transformAgainstServerOps(op, serverOps)

      // Step 6 — persist the transformed op with the new server version.
      const serverVersion = currentVersion + 1
      await saveOperation(docId, socket.data.userId, transformedOp, serverVersion)

      // Step 7 — update the version counter in Redis. Delete the key if it fails after DB save to self-heal.
      try {
        await setDocVersion(docId, serverVersion)
      } catch (setVersionErr) {
        logger.error(
          { setVersionErr, docId, serverVersion },
          'op:submit: setDocVersion failed after saveOperation — deleting stale key for self-healing'
        )
        try {
          await deleteDocVersion(docId)
        } catch (delErr) {
          logger.error({ delErr, docId }, 'op:submit: failed to delete stale doc-version key')
        }
        // Do not re-throw: op is saved; key self-heals on next submission.
      }

      // Critical section ends. Capture details for post-lock ACK and broadcast.
      pendingAck = { serverVersion, transformedOp, authorId: socket.data.userId }
    }
  } catch (err) {
    // Unique-constraint violation usually means Redis was stale; delete key to self-heal.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      resolvedVersion !== null
    ) {
      logger.error(
        { err, docId, resolvedVersion },
        'op:submit: unique-constraint violation — Redis version was stale, forcing reconnect'
      )
      try {
        await deleteDocVersion(docId)
      } catch (delErr) {
        logger.error(
          { delErr, docId },
          'op:submit: failed to delete stale doc-version key after P2002'
        )
      }
      shouldReconnect = true
      reconnectVersion = resolvedVersion
    } else {
      logger.error({ err, docId }, 'handleOpSubmit: error processing operation')
      socket.emit(WS.ERROR, { code: 'INTERNAL_ERROR', message: 'Failed to process operation' })
    }
  } finally {
    // ALWAYS release the lock to prevent freezing the document. Try/catch to avoid unhandled rejections.
    try {
      await releaseLock(lockKey, lockToken!)
    } catch (releaseErr) {
      logger.error(
        { releaseErr, lockKey, docId },
        'handleOpSubmit: releaseLock failed — lock may have expired'
      )
    }
  }

  // Steps 8–9 — ACK + broadcast outside critical section.
  if (pendingAck !== null) {
    const { serverVersion, transformedOp, authorId } = pendingAck

    // Step 8 — acknowledge the sender.
    socket.emit(WS.OP_ACK, { serverVersion, timestamp: Date.now() })

    // Step 9 — broadcast to all clients locally, and fan out across nodes via Redis publish.
    const broadcastPayload = {
      op: transformedOp,
      authorId,
      serverVersion,
      publisherId: NODE_ID,
    }

    // Local emit always happens unconditionally.
    io.to(docId).emit(WS.OP_BROADCAST, broadcastPayload)

    // Cross-node fanout via Redis. Log failure for ops awareness.
    try {
      await publish(`doc:${docId}`, broadcastPayload)
    } catch (pubErr) {
      logger.error(
        { pubErr, docId, serverVersion },
        'op:submit: Redis publish failed — remote nodes will not receive this op'
      )
    }

    // Snapshot optimisation: compute full document state every 100 ops.
    if (serverVersion % 100 === 0) {
      setImmediate(() => {
        void takeSnapshot(docId, serverVersion)
      })
    }

    logger.debug({ docId, serverVersion, latencyMs: Date.now() - start }, 'op:submit processed')
  }

  // Post-lock: build and send reconnect payload if flagged.
  if (shouldReconnect) {
    try {
      const doc = await getDocument(docId)
      // Bound ops fetch to reconnectVersion for a duplicate-free resync payload.
      const ops = doc ? await getOperationsSince(docId, doc.snapshotVersion, reconnectVersion) : []
      socket.emit(WS.DOC_RECONNECT, {
        snapshot: doc?.snapshotContent ?? '',
        version: doc?.snapshotVersion ?? 0,
        ops,
        syncedVersion: reconnectVersion,
      })
    } catch (err) {
      logger.error({ err, docId }, 'handleOpSubmit: reconnect fetch failed')
      socket.emit(WS.ERROR, { code: 'INTERNAL_ERROR', message: 'Failed to process operation' })
    }
  }
}
