import type { Server, Socket } from 'socket.io'
import { WS } from '../events'
import type { ServerToClientEvents, ClientToServerEvents } from '../events'
import { getSession, setSession } from '../../redis/session'
import { publish } from '../../redis/pubsub'
import { NODE_ID } from '../../config/node-id'
import { logger } from '../../utils/logger'
import type { SocketData } from '../server'

interface CursorUpdatePayload {
  docId: string
  cursor: number
}

/** Handles a cursor:update event by saving to Redis and broadcasting a lightweight delta. */
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

    // Guard: session docId must match payload docId and socket must be in the room.
    if (session.docId !== docId || !socket.rooms.has(docId)) {
      logger.warn(
        { socketId: socket.id, sessionDocId: session.docId, payloadDocId: docId },
        'cursor:update: docId mismatch or socket not in room — ignoring'
      )
      return
    }

    await setSession(socket.id, { ...session, cursor, lastSeen: Date.now() })

    const broadcastPayload = {
      userId: session.userId,
      name: session.name,
      color: session.color,
      cursor,
      publisherId: NODE_ID,
    }

    // Emit directly to local sockets first.
    io.to(docId).emit(WS.CURSOR_BROADCAST, broadcastPayload)

    // Cross-node fanout: publish to presence channel so other nodes can emit locally.
    try {
      await publish(`presence:${docId}`, broadcastPayload)
    } catch (pubErr) {
      logger.error(
        { pubErr, docId },
        'cursor:update: Redis publish failed — remote nodes will not receive this cursor update'
      )
    }
  } catch (err) {
    logger.error({ err, docId }, 'handleCursorUpdate: failed')
    socket.emit(WS.ERROR, { code: 'INTERNAL_ERROR', message: 'Failed to update cursor' })
  }
}
