import { Server } from 'socket.io'
import type { Server as HttpServer } from 'http'
import jwt from 'jsonwebtoken'
import { env } from '../config/env'
import { subClient } from '../redis/client'
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

/**
 * Receive operation broadcasts from all other server nodes and forward
 * them to the correct Socket.io room on THIS node.
 *
 * Server A publishes `doc:{docId}` → Redis → Server B's psubscribe handler
 * calls `io.to(docId).emit(OP_BROADCAST, ...)` → clients on B receive the op.
 *
 * Uses `subClient.psubscribe` (pattern subscription) directly because the
 * pubsub.ts abstraction only handles exact-channel subscriptions.
 */
function setupCrossNodeBroadcast(io: Server): void {
  subClient.psubscribe('doc:*', (err) => {
    if (err) {
      logger.error({ err }, 'Redis psubscribe failed — cross-node broadcast disabled')
    }
  })

  subClient.on('pmessage', (_pattern: string, channel: string, message: string) => {
    const docId = channel.replace('doc:', '')
    try {
      const data: unknown = JSON.parse(message)
      io.to(docId).emit(WS.OP_BROADCAST, data)
    } catch {
      logger.warn({ channel }, 'Redis: received malformed pmessage — ignoring')
    }
  })
}

/**
 * Create and configure the Socket.io server.
 *
 * Authentication: every connection must supply a JWT via the `token` query
 * parameter (`ws://host?token=<JWT>`). Connections without a valid token are
 * rejected before reaching any event handler.
 *
 * After authentication, `socket.data` is populated with `userId`,
 * `workspaceId`, and optionally `name` from the token payload.
 *
 * @param httpServer  The Node.js HTTP server to attach Socket.io to.
 * @returns           The configured `Server` instance.
 */
export function createWebSocketServer(httpServer: HttpServer): Server {
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
    const raw = socket.handshake.query.token
    const token = Array.isArray(raw) ? raw[0] : raw
    if (!token) {
      return next(new Error('AUTH_REQUIRED'))
    }
    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as {
        userId: string
        workspaceId: string
        name?: string
      }
      socket.data.userId = payload.userId
      socket.data.workspaceId = payload.workspaceId
      if (payload.name) socket.data.name = payload.name
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
