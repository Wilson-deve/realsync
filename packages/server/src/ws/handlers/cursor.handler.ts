import type { Server, Socket } from 'socket.io'
import { WS } from '../events'
import type { ServerToClientEvents, ClientToServerEvents } from '../events'
import { getSession, setSession, getDocSessions } from '../../redis/session'
import { logger } from '../../utils/logger'
import type { SocketData } from '../server'

interface CursorUpdatePayload {
  docId: string
  cursor: number
}

/**
 * Handle a `cursor:update` event from a connected client.
 *
 * Validates the payload, updates the sender's cursor position in the Redis
 * session store, then broadcasts the full presence list to everyone in the
 * document room so all clients see up-to-date cursor positions.
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
    typeof (payload as Record<string, unknown>).cursor !== 'number'
  ) {
    socket.emit(WS.ERROR, {
      code: 'INVALID_PAYLOAD',
      message: 'cursor:update requires docId and cursor',
    })
    return
  }

  const { docId, cursor } = payload as CursorUpdatePayload

  try {
    const session = await getSession(socket.id)
    if (!session) return

    await setSession(socket.id, { ...session, cursor, lastSeen: Date.now() })
    const sessions = await getDocSessions(docId)
    io.to(docId).emit(WS.PRESENCE_UPDATE, { users: sessions })
  } catch (err) {
    logger.error({ err, docId }, 'handleCursorUpdate: failed')
    socket.emit(WS.ERROR, { code: 'INTERNAL_ERROR', message: 'Failed to update cursor' })
  }
}
