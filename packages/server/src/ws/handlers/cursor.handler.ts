import type { Server, Socket } from 'socket.io'
import { WS } from '../events'
import type { ServerToClientEvents, ClientToServerEvents } from '../events'
import { getSession, setSession } from '../../redis/session'
import { logger } from '../../utils/logger'
import type { SocketData } from '../server'

interface CursorUpdatePayload {
  docId: string
  cursor: number
}

/**
 * Handle a `cursor:update` event from a connected client.
 *
 * Validates the payload, persists the new cursor position in the Redis session
 * store, then broadcasts a lightweight delta (`cursor:broadcast`) containing
 * only the fields that changed for the one user.  This avoids refetching the
 * full presence list from Redis and re-serialising all N sessions on every
 * keystroke, which would become a significant Redis + network hotspot at scale.
 *
 * Clients should apply the delta to their local presence map rather than
 * replacing the whole list.  A full `presence:update` is still sent by
 * room:join / presence:ping / disconnect to keep the authoritative list in sync.
 */
export async function handleCursorUpdate(
  io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>,
  payload: unknown
): Promise<void> {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as Record<string, unknown>).docId !== 'string' ||
    typeof (payload as Record<string, unknown>).cursor !== 'number' ||
    !Number.isFinite((payload as Record<string, unknown>).cursor as number) ||
    !Number.isInteger((payload as Record<string, unknown>).cursor as number) ||
    ((payload as Record<string, unknown>).cursor as number) < 0
  ) {
    socket.emit(WS.ERROR, {
      code: 'INVALID_PAYLOAD',
      message: 'cursor:update requires docId and a non-negative integer cursor',
    })
    return
  }

  const { docId, cursor } = payload as CursorUpdatePayload

  try {
    const session = await getSession(socket.id)
    if (!session) return

    // Guard: the session's recorded docId must match the payload docId, and
    // the socket must actually be in that Socket.io room.  Without this, a
    // client could supply an arbitrary docId and trigger presence broadcasts
    // into rooms it has never joined, or corrupt another document's presence.
    if (session.docId !== docId || !socket.rooms.has(docId)) {
      logger.warn(
        { socketId: socket.id, sessionDocId: session.docId, payloadDocId: docId },
        'cursor:update: docId mismatch or socket not in room — ignoring'
      )
      return
    }

    await setSession(socket.id, { ...session, cursor, lastSeen: Date.now() })
    // Emit a single-user delta instead of refetching and broadcasting the full
    // session list.  Presence:update (full list) is still emitted on join/leave
    // and presence:ping so clients always have a reconciliation path.
    io.to(docId).emit(WS.CURSOR_BROADCAST, {
      userId: session.userId,
      name: session.name,
      color: session.color,
      cursor,
    })
  } catch (err) {
    logger.error({ err, docId }, 'handleCursorUpdate: failed')
    socket.emit(WS.ERROR, { code: 'INTERNAL_ERROR', message: 'Failed to update cursor' })
  }
}
