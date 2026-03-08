import type { Server, Socket } from 'socket.io'
import { WS } from './events'
import type { ServerToClientEvents, ClientToServerEvents } from './events'
import { setSession, deleteSession, getDocSessions } from '../redis/session'
import { getDocument } from '../db/documents'
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

      socket.join(docId)

      await setSession(socket.id, {
        userId: socket.data.userId,
        name: socket.data.name ?? 'Anonymous',
        docId,
        cursor: 0,
        color: assignColor(socket.data.userId),
        lastSeen: Date.now(),
      })

      // Send current document state to the joining client (handles reconnects too).
      socket.emit(WS.DOC_RECONNECT, {
        snapshot: doc.snapshotContent,
        version: doc.snapshotVersion,
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
      socket.leave(docId)
      await deleteSession(socket.id, docId)
      const sessions = await getDocSessions(docId)
      io.to(docId).emit(WS.PRESENCE_UPDATE, { users: sessions })
    } catch (err) {
      logger.error({ err, docId }, 'room:leave failed')
    }
  })

  // ── disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
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
