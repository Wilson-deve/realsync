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

/** Registers all Socket.io event handlers for a newly-connected socket. */
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
      if (doc.workspaceId !== socket.data.workspaceId) {
        socket.emit(WS.ERROR, { code: 'FORBIDDEN', message: `Document ${docId} not found` })
        return
      }

      // One-doc-per-socket enforcement: Auto-leave every existing document room before joining a new one to prevent stale sessions.
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

      // Join the room FIRST so no broadcast is missed, then capture the version ceiling as the sync boundary.
      await socket.join(docId)

      let syncedVersion = await getDocVersion(docId)
      if (syncedVersion === null) {
        syncedVersion = await getMaxOperationVersion(docId)
        // Persist the seeded version back to Redis immediately for quick retrieval by other sockets.
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

      // Send the ops applied since the last snapshot up to syncedVersion.
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

      // Best-effort rollback: if socket.join(docId) already ran, leave the room.
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
      // The Socket.io room membership is the authoritative source.
      if (!socket.rooms.has(docId)) {
        logger.warn(
          { socketId: socket.id, payloadDocId: docId },
          'room:leave: socket not in room — ignoring'
        )
        return
      }

      // If session exists with mismatched docId, clean it up anyway because socket membership is authoritative.
      const session = await getSession(socket.id)
      if (session && session.docId !== docId) {
        logger.warn(
          { socketId: socket.id, sessionDocId: session.docId, payloadDocId: docId },
          'room:leave: session docId mismatch — leaving room and cleaning up both docIds'
        )
        // Clean up whichever docId the session points to.
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
      // Best-effort: delete the session even if getSession returned null.
      await deleteSession(socket.id, docId)
      const sessions = await getDocSessions(docId)
      io.to(docId).emit(WS.PRESENCE_UPDATE, { users: sessions })
    } catch (err) {
      logger.error({ err, docId }, 'room:leave failed')
    }
  })

  // ── disconnecting ──────────────────────────────────────────────────────────
  // Use 'disconnecting' because rooms are intact; 'disconnect' fires after rooms are cleared.
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
