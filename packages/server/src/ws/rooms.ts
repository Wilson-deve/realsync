import type { Server, Socket } from 'socket.io'
import { WS } from './events'
import type { ServerToClientEvents, ClientToServerEvents } from './events'
import {
  getSession,
  setSession,
  deleteSession,
  getDocSessions,
  getDocVersion,
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
      // stale entry in the previous doc's session set.  Auto-leave any
      // existing document room before joining the new one.
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
          logger.warn({ err, prevDocId, socketId: socket.id }, 'room:join: auto-leave failed')
        }
      }

      // Capture the current server version BEFORE joining the Socket.io room.
      // This is the version ceiling that bounds the initial sync payload.
      //
      // Why the order matters:
      //   socket.join(docId) makes the socket eligible to receive op:broadcast
      //   from Redis pub/sub immediately.  If we read ops AFTER joining, any op
      //   committed between the DB read and the join is forwarded as a broadcast
      //   AND included in the ops array — a duplicate.  By capturing the version
      //   ceiling first, then joining, then fetching ops up to that ceiling:
      //     - ops in doc:reconnect are bounded to <= syncedVersion
      //     - any op:broadcast arriving after join has serverVersion > syncedVersion
      //     - the client applies broadcasts only above the boundary — no duplicates
      let syncedVersion = await getDocVersion(docId)
      if (syncedVersion === null) {
        syncedVersion = await getMaxOperationVersion(docId)
      }

      await socket.join(docId)

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

      // If the session exists, also guard against a docId mismatch (a client
      // claiming to leave a doc that doesn't match its active session).
      const session = await getSession(socket.id)
      if (session && session.docId !== docId) {
        logger.warn(
          { socketId: socket.id, sessionDocId: session.docId, payloadDocId: docId },
          'room:leave: docId mismatch — ignoring'
        )
        return
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
