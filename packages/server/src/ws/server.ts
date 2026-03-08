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
  // Deliver incoming Redis messages to the correct local room.
  // Uses exact-channel `subscribe` (not psubscribe) so only channels this node
  // has actively subscribed to are processed.
  subClient.on('message', (channel: string, message: string) => {
    const docId = channel.startsWith('doc:') ? channel.slice(4) : null
    if (!docId) return
    try {
      const data: unknown = JSON.parse(message)
      io.to(docId).emit(WS.OP_BROADCAST, data)
    } catch {
      logger.warn({ channel }, 'Redis: received malformed message — ignoring')
    }
  })

  // Subscribe when the FIRST local socket joins a doc room, unsubscribe when
  // the LAST local socket leaves.  This replaces the previous psubscribe('doc:*')
  // which received and JSON-parsed every op cluster-wide regardless of whether
  // any client on this node was interested in that document.
  //
  // Socket.io gives every socket a personal room named after its socket.id;
  // skip those by checking room === id.
  io.of('/').adapter.on('join-room', (room: string, id: string) => {
    if (room === id) return
    const localSize = io.sockets.adapter.rooms.get(room)?.size ?? 0
    if (localSize === 1) {
      subClient.subscribe(`doc:${room}`, (err) => {
        if (err)
          logger.error(
            { err, room },
            'Redis subscribe failed — cross-node broadcast disabled for room'
          )
      })
    }
  })

  io.of('/').adapter.on('leave-room', (room: string, id: string) => {
    if (room === id) return
    if (!io.sockets.adapter.rooms.get(room)) {
      subClient.unsubscribe(`doc:${room}`, (err) => {
        if (err) logger.warn({ err, room }, 'Redis unsubscribe failed')
      })
    }
  })
}

/**
 * Create and configure the Socket.io server.
 *
 * Authentication: every connection must supply a JWT via the Socket.io
 * `auth` payload (`socket = io(url, { auth: { token } })`).  The token is
 * intentionally NOT read from the URL query string, which is commonly logged
 * by proxies, CDNs, and access logs, risking credential leakage.
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
    // Prefer handshake.auth.token (not visible in URLs / proxy logs).
    // Accept handshake.query.token as a fallback only to aid migration.
    const authToken = (socket.handshake.auth as Record<string, unknown>).token
    const queryRaw = socket.handshake.query.token
    const raw = authToken ?? (Array.isArray(queryRaw) ? queryRaw[0] : queryRaw)
    const token = typeof raw === 'string' ? raw : undefined
    if (!token) {
      return next(new Error('AUTH_REQUIRED'))
    }
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET)

      // jwt.verify() can return a string (for non-object JWTs) or an object
      // that is missing the claims we require. Cast only after explicit runtime
      // validation so socket.data is never populated with undefined fields.
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
