import type { Server, Socket } from 'socket.io'
import { WS } from './events'
import type { ServerToClientEvents, ClientToServerEvents } from './events'
import {
  getSession,
  setSession,
  deleteSession,
  getDocSessions,
  getDocVersion,
  setDocVersion,
} from '../redis/session'
import { getDocument } from '../db/documents'
import { getOperationsSince, getMaxOperationVersion } from '../db/operations'
import { handleOpSubmit } from './handlers/op.handler'
import { handleCursorUpdate } from './handlers/cursor.handler'
import { handlePresencePing } from './handlers/presence.handler'
import { logger } from '../utils/logger'
import type { SocketData } from './server'

// Assign a consistent color to a user based on their userId.
// The same userId always gets the same color across sessions.
const COLORS = [
  '#FF6B6B',
  '#4ECDC4',
  '#45B7D1',
  '#96CEB4',
  '#FFEAA7',
  '#DDA0DD',
  '#98D8C8',
  '#F7DC6F',
  '#82E0AA',
  '#85C1E9',
]
function assignColor(userId: string): string {
  const hash = userId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  return COLORS[hash % COLORS.length]
}

/**
 * Register all Socket.io event handlers for a newly-connected socket.
 * Called once per connection from the Socket.io `connection` event.
 */
export function registerHandlers(
  io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>
): void {
  // ── room:join ──────────────────────────────────────────────────────────────
  socket.on(WS.ROOM_JOIN, async (payload: unknown) => {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      typeof (payload as Record<string, unknown>).docId !== 'string'
    ) {
      socket.emit(WS.ERROR, { code: 'INVALID_PAYLOAD', message: 'room:join requires docId' })
      return
    }
    const { docId } = payload as { docId: string }

    try {
      const doc = await getDocument(docId)
      if (!doc) {
        socket.emit(WS.ERROR, { code: 'DOC_NOT_FOUND', message: `Document ${docId} not found` })
        return
      }

      // Authorisation: the document must belong to the user's workspace.
      // Without this check, any authenticated user who knows a docId can join
      // documents from other workspaces and read or write their content.
      if (doc.workspaceId !== socket.data.workspaceId) {
        socket.emit(WS.ERROR, { code: 'FORBIDDEN', message: `Document ${docId} not found` })
        return
      }

      // One-doc-per-socket enforcement:
      // Session storage is keyed only by socket.id, so joining a second
      // document would overwrite the single session record while leaving a
      // stale entry in the previous doc's session set.  Auto-leave every
      // existing document room before joining the new one.
      //
      // Failure semantics: if any step of the auto-leave fails we abort the
      // join and return an error to the client.  Continuing after a partial
      // leave would leave the socket joined to both the old and the new room
      // simultaneously, causing it to receive broadcasts for a document it no
      // longer has a valid session for and leaving stale presence entries in
      // the old room that would never be cleaned up.
      const existingDocRooms = Array.from(socket.rooms).filter(
        (r) => r !== socket.id && r !== docId
      )
      for (const prevDocId of existingDocRooms) {
        try {
          await socket.leave(prevDocId)
          await deleteSession(socket.id, prevDocId)
          const prevSessions = await getDocSessions(prevDocId)
          io.to(prevDocId).emit(WS.PRESENCE_UPDATE, { users: prevSessions })
        } catch (err) {
          logger.error({ err, prevDocId, socketId: socket.id }, 'room:join: auto-leave failed')
          socket.emit(WS.ERROR, {
            code: 'INTERNAL_ERROR',
            message: 'Failed to leave previous document — please try again',
          })
          return
        }
      }

      // Join the room FIRST so no broadcast can be missed, then capture the
      // version ceiling as the deduplication boundary.
      //
      // Correct ordering:
      //   1. socket.join(docId)  — socket is now in the room; every subsequent
      //      op:broadcast is queued / delivered to this socket.
      //   2. Capture syncedVersion — any op committed AFTER this point will be
      //      broadcast AND have serverVersion > syncedVersion.
      //   3. Fetch ops up to syncedVersion — the array covers  everything up to
      //      the boundary; no gap, no overlap with future broadcasts.
      //   4. Emit doc:reconnect with syncedVersion — the client discards any
      //      buffered broadcast whose serverVersion <= syncedVersion (already in
      //      ops) and applies broadcasts with serverVersion > syncedVersion on top.
      //
      // Previous (wrong) order  — capture version, then join — had a gap:
      //   an op committed between the read and the join was broadcast before the
      //   socket was in the room (missed) AND excluded from the ops array
      //   (payload was bounded to the old ceiling) → permanent data loss.
      await socket.join(docId)

      let syncedVersion = await getDocVersion(docId)
      if (syncedVersion === null) {
        syncedVersion = await getMaxOperationVersion(docId)
        // Persist the seeded version back to Redis so subsequent joins on this
        // node (or others, if using a shared Redis) read O(1) instead of
        // re-running the DB MAX aggregate on every join after a restart or
        // Redis eviction.  The NX flag ensures we don't race-overwrite a newer
        // version that handleOpSubmit may have written concurrently.
        await setDocVersion(docId, syncedVersion, /* nx */ true)
      }

      await setSession(socket.id, {
        userId: socket.data.userId,
        name: socket.data.name ?? 'Anonymous',
        docId,
        cursor: 0,
        color: assignColor(socket.data.userId),
        lastSeen: Date.now(),
      })

      // Send the snapshot plus every op applied since it was taken.
      // Snapshots are only written every 100 ops, so a joining client must
      // replay `opsSinceSnapshot` on top of the snapshot to reach current state.
      // Without this, clients joining between snapshots would receive a stale
      // document with no way to catch up.
      // Fetch only the ops between the snapshot and the captured ceiling so
      // the doc:reconnect payload is bounded and duplicate-free with respect
      // to any op:broadcast the socket receives after joining above.
      const opsSinceSnapshot = await getOperationsSince(docId, doc.snapshotVersion, syncedVersion)
      socket.emit(WS.DOC_RECONNECT, {
        snapshot: doc.snapshotContent,
        version: doc.snapshotVersion,
        ops: opsSinceSnapshot,
        syncedVersion,
      })

      // Broadcast updated presence list to everyone in the room.
      const sessions = await getDocSessions(docId)
      io.to(docId).emit(WS.PRESENCE_UPDATE, { users: sessions })
    } catch (err) {
      logger.error({ err, docId }, 'room:join failed')
      socket.emit(WS.ERROR, { code: 'INTERNAL_ERROR', message: 'Failed to join document' })

      // If socket.join(docId) already ran before the failure, the socket is
      // sitting in the room without a valid session.  This would keep
      // cross-node Redis subscriptions alive and deliver spurious broadcasts
      // until the client disconnects.  Best-effort rollback:
      if (socket.rooms.has(docId)) {
        try {
          await socket.leave(docId)
          await deleteSession(socket.id, docId)
          // Re-broadcast presence so the failed joiner is not shown to others.
          const sessions = await getDocSessions(docId)
          io.to(docId).emit(WS.PRESENCE_UPDATE, { users: sessions })
        } catch (cleanupErr) {
          logger.warn({ cleanupErr, docId, socketId: socket.id }, 'room:join rollback failed')
        }
      }
    }
  })

  // ── room:leave ─────────────────────────────────────────────────────────────
  socket.on(WS.ROOM_LEAVE, async (payload: unknown) => {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      typeof (payload as Record<string, unknown>).docId !== 'string'
    ) {
      socket.emit(WS.ERROR, { code: 'INVALID_PAYLOAD', message: 'room:leave requires docId' })
      return
    }
    const { docId } = payload as { docId: string }

    try {
      // The Socket.io room membership is the authoritative source: if the
      // socket is not in the room there is nothing to leave.
      if (!socket.rooms.has(docId)) {
        logger.warn(
          { socketId: socket.id, payloadDocId: docId },
          'room:leave: socket not in room — ignoring'
        )
        return
      }

      // If the session exists and its docId doesn't match the payload, the
      // state is inconsistent — but the socket IS in the room and will keep
      // receiving broadcasts until it leaves.  Log the mismatch for
      // investigation and fall through to leave + cleanup anyway: the room
      // membership in Socket.io is the authoritative state that must be
      // corrected regardless of what Redis says.
      const session = await getSession(socket.id)
      if (session && session.docId !== docId) {
        logger.warn(
          { socketId: socket.id, sessionDocId: session.docId, payloadDocId: docId },
          'room:leave: session docId mismatch — leaving room and cleaning up both docIds'
        )
        // Also clean up whichever docId the session points to, since that
        // room's presence set may have a stale entry for this socket.
        try {
          await socket.leave(session.docId)
          await deleteSession(socket.id, session.docId)
          const mismatchSessions = await getDocSessions(session.docId)
          io.to(session.docId).emit(WS.PRESENCE_UPDATE, { users: mismatchSessions })
        } catch (mismatchErr) {
          logger.warn(
            { mismatchErr, sessionDocId: session.docId, socketId: socket.id },
            'room:leave: cleanup of mismatched session docId failed'
          )
        }
      }

      await socket.leave(docId)
      // Best-effort: delete the session even if getSession returned null
      // (TTL expiry / eviction while the socket was still connected).
      await deleteSession(socket.id, docId)
      const sessions = await getDocSessions(docId)
      io.to(docId).emit(WS.PRESENCE_UPDATE, { users: sessions })
    } catch (err) {
      logger.error({ err, docId }, 'room:leave failed')
    }
  })

  // ── disconnecting ──────────────────────────────────────────────────────────
  // Use 'disconnecting' (not 'disconnect') because by the time 'disconnect'
  // fires Socket.io has already removed the socket from all of its rooms, so
  // socket.rooms only contains the socket's own private room, making the
  // room-iteration loop below a no-op and leaving stale entries in every
  // doc-sessions:* set.  'disconnecting' fires while rooms are still intact.
  socket.on('disconnecting', async () => {
    // Clean up every document room this socket was in.
    // Filter out the socket's own ID (Socket.io gives every socket a personal room).
    const rooms = Array.from(socket.rooms).filter((r) => r !== socket.id)
    for (const docId of rooms) {
      try {
        await deleteSession(socket.id, docId)
        const sessions = await getDocSessions(docId)
        io.to(docId).emit(WS.PRESENCE_UPDATE, { users: sessions })
      } catch (err) {
        // Best-effort: log but don't stop cleanup of remaining rooms.
        logger.warn({ err, docId, socketId: socket.id }, 'disconnect: session cleanup failed')
      }
    }
  })

  // ── operation, cursor, presence ────────────────────────────────────────────
  socket.on(WS.OP_SUBMIT, (payload: unknown) => {
    void handleOpSubmit(io, socket, payload)
  })
  socket.on(WS.CURSOR_UPDATE, (payload: unknown) => {
    void handleCursorUpdate(io, socket, payload)
  })
  socket.on(WS.PRESENCE_PING, (payload: unknown) => {
    void handlePresencePing(io, socket, payload)
  })
}
