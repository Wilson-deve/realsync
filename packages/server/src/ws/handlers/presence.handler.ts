import type { Server, Socket } from 'socket.io'
import { WS } from '../events'
import type { ServerToClientEvents, ClientToServerEvents } from '../events'
import { getSession, setSession, getDocSessions } from '../../redis/session'
import { logger } from '../../utils/logger'
import type { SocketData } from '../server'

interface PresencePingPayload {
  docId: string
}

/**
 * Handle a `presence:ping` heartbeat event from a connected client.
 *
 * Refreshes the sender's `lastSeen` timestamp in the Redis session store
 * and broadcasts the updated presence list to everyone in the room.
 * Clients should send this every 15–30 seconds to stay "active".
 */
export async function handlePresencePing(
  io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>,
  payload: unknown
): Promise<void> {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as Record<string, unknown>).docId !== 'string'
  ) {
    socket.emit(WS.ERROR, { code: 'INVALID_PAYLOAD', message: 'presence:ping requires docId' })
    return
  }

  const { docId } = payload as PresencePingPayload

  try {
    const session = await getSession(socket.id)
    if (!session) return

    await setSession(socket.id, { ...session, lastSeen: Date.now() })
    const sessions = await getDocSessions(docId)
    io.to(docId).emit(WS.PRESENCE_UPDATE, { users: sessions })
  } catch (err) {
    logger.error({ err, docId }, 'handlePresencePing: failed')
    socket.emit(WS.ERROR, { code: 'INTERNAL_ERROR', message: 'Failed to process ping' })
  }
}
