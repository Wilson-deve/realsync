import { Server } from 'socket.io'
import type { Server as HttpServer } from 'http'
import jwt from 'jsonwebtoken'
import { env } from '../config/env'
import { NODE_ID } from '../config/node-id'
import { subscribe } from '../redis/pubsub'
import { registerHandlers } from './rooms'
import { WS } from './events'
import type { ServerToClientEvents, ClientToServerEvents } from './events'
import { logger } from '../utils/logger'

/** Fields attached to every authenticated socket. */
export interface SocketData {
  userId: string
  workspaceId: string
  name?: string
}

/** Subscribes to a document's Redis channel when the first local socket joins and unsubscribes when the last leaves. */
function setupCrossNodeBroadcast(io: Server): void {
  // Maps channel to pending Promise to deduplicate subscriptions per room.
  const opRoomState = new Map<string, Promise<() => Promise<void>>>()
  const cursorRoomState = new Map<string, Promise<() => Promise<void>>>()

  // Helper to subscribe to a room and record the pending Promise.
  function subscribeRoom(
    map: Map<string, Promise<() => Promise<void>>>,
    channel: string,
    handler: (data: unknown) => void
  ): void {
    const pending = subscribe(channel, handler)
    map.set(channel, pending)
    pending.catch((err: unknown) => {
      map.delete(channel)
      logger.error(
        { err, channel },
        'Redis subscribe failed — cross-node broadcast disabled for channel'
      )
    })
  }

  io.of('/').adapter.on('join-room', (room: string, id: string) => {
    if (room === id) return

    // op:broadcast channel
    if (!opRoomState.has(`doc:${room}`)) {
      subscribeRoom(opRoomState, `doc:${room}`, (data: unknown) => {
        // Skip messages published by this node to avoid emitting duplicates to local sockets.
        if (
          typeof data === 'object' &&
          data !== null &&
          (data as Record<string, unknown>).publisherId === NODE_ID
        ) {
          return
        }
        io.to(room).emit(WS.OP_BROADCAST, data)
      })
    }

    // presence:{docId} channel
    if (!cursorRoomState.has(`presence:${room}`)) {
      subscribeRoom(cursorRoomState, `presence:${room}`, (data: unknown) => {
        if (
          typeof data === 'object' &&
          data !== null &&
          (data as Record<string, unknown>).publisherId === NODE_ID
        ) {
          return
        }
        io.to(room).emit(WS.CURSOR_BROADCAST, data)
      })
    }
  })

  io.of('/').adapter.on('leave-room', (room: string, id: string) => {
    if (room === id) return
    if (io.sockets.adapter.rooms.get(room)) return // other sockets still in the room

    // Unsubscribe both channels when the last socket leaves the room.
    for (const [map, channel] of [
      [opRoomState, `doc:${room}`],
      [cursorRoomState, `presence:${room}`],
    ] as [Map<string, Promise<() => Promise<void>>>, string][]) {
      const pending = map.get(channel)
      if (!pending) continue
      map.delete(channel)
      // Await in-flight subscribe to handle race condition where last socket leaves during subscription.
      pending
        .then((unsub) => unsub())
        .catch((err: unknown) => {
          logger.warn({ err, channel }, 'Redis unsubscribe failed')
        })
    }
  })
}

/** Creates and configures the Socket.io server with JWT authentication. */
export function createWebSocketServer(
  httpServer: HttpServer
): Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData> {
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(httpServer, {
    cors: { origin: env.CORS_ORIGIN, credentials: true },
    pingTimeout: 10000,
    pingInterval: 5000,
  })

  // Authenticate every connection before it reaches any handler.
  io.use((socket, next) => {
    // Retrieve auth token from handshake auth or fallback query string.
    const auth =
      typeof socket.handshake.auth === 'object' && socket.handshake.auth !== null
        ? (socket.handshake.auth as Record<string, unknown>)
        : {}
    const authToken = auth.token
    const queryRaw = socket.handshake.query.token
    const raw = authToken ?? (Array.isArray(queryRaw) ? queryRaw[0] : queryRaw)
    const token = typeof raw === 'string' ? raw : undefined
    if (!token) {
      return next(new Error('AUTH_REQUIRED'))
    }
    try {
      // Restrict to HS256 to prevent algorithm manipulation attacks.
      const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] })

      // Validate decoded token payload structure before attaching properties.
      if (
        typeof decoded !== 'object' ||
        decoded === null ||
        typeof (decoded as Record<string, unknown>).userId !== 'string' ||
        typeof (decoded as Record<string, unknown>).workspaceId !== 'string'
      ) {
        return next(new Error('AUTH_INVALID'))
      }

      const payload = decoded as { userId: string; workspaceId: string; name?: string }
      socket.data.userId = payload.userId
      socket.data.workspaceId = payload.workspaceId
      if (typeof payload.name === 'string') socket.data.name = payload.name
      next()
    } catch {
      next(new Error('AUTH_INVALID'))
    }
  })

  io.on('connection', (socket) => {
    registerHandlers(io, socket)
  })

  setupCrossNodeBroadcast(io)

  return io
}
