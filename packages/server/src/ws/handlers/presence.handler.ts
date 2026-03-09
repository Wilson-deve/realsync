import type { Server, Socket } from 'socket.io'
import { WS } from '../events'
import type { ServerToClientEvents, ClientToServerEvents } from '../events'
import { getSession, setSession, getDocSessions } from '../../redis/session'
import { logger } from '../../utils/logger'
import type { SocketData } from '../server'
import { env } from '../../config/env'

interface PresencePingPayload {
  docId: string
}

/** Per-room debounce timers to collapse concurrent presence pings into a single broadcast. */
const broadcastTimers = new Map<string, ReturnType<typeof setTimeout>>()

function schedulePresenceBroadcast(
  io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>,
  docId: string
): void {
  const existing = broadcastTimers.get(docId)
  if (existing !== undefined) clearTimeout(existing)

  broadcastTimers.set(
    docId,
    setTimeout(() => {
      broadcastTimers.delete(docId)

      // Skip broadcast if the room has no local sockets.
      if (!io.sockets.adapter.rooms.get(docId)?.size) return

      getDocSessions(docId)
        .then((sessions) => {
          io.to(docId).emit(WS.PRESENCE_UPDATE, { users: sessions })
        })
        .catch((err: unknown) => {
          logger.warn({ err, docId }, 'presence: scheduled broadcast failed')
        })
    }, env.PRESENCE_DEBOUNCE_MS)
  )
}

/** Handles a presence:ping event by updating lastSeen and scheduling a coalesced broadcast. */
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

    // Guard: reject pings for rooms the socket hasn't joined.
    if (session.docId !== docId || !socket.rooms.has(docId)) {
      logger.warn(
        { socketId: socket.id, sessionDocId: session.docId, payloadDocId: docId },
        'presence:ping: docId mismatch or socket not in room — ignoring'
      )
      return
    }

    // O(1): refresh this socket's lastSeen.
    await setSession(socket.id, { ...session, lastSeen: Date.now() })

    // Coalesced broadcast: defers expensive read/emit to the end of the debounce window.
    schedulePresenceBroadcast(io, docId)
  } catch (err) {
    logger.error({ err, docId }, 'handlePresencePing: failed')
    socket.emit(WS.ERROR, { code: 'INTERNAL_ERROR', message: 'Failed to process ping' })
  }
}
