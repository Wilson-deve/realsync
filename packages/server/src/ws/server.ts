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

/**
 * Subscribe to a document's Redis channel when the first local socket joins
 * and unsubscribe when the last local socket leaves.  Uses the pubsub.ts
 * helpers so subscriptions are deduplicated and race-free.
 *
 * Server A publishes `doc:{docId}` → Redis → Server B's handler calls
 * `io.to(docId).emit(OP_BROADCAST, ...)` → clients on B receive the op.
 */
function setupCrossNodeBroadcast(io: Server): void {
  // Keyed by room name.  The value is the pending subscribe() promise while
  // the SUBSCRIBE is in flight, and the resolved unsubscribe function once it
  // completes.  Storing the promise immediately (before subscribe() resolves)
  // prevents two rapid join-room events from both calling subscribe() and
  // registering duplicate message handlers for the same room.
  const roomState = new Map<string, Promise<() => Promise<void>>>()

  io.of('/').adapter.on('join-room', (room: string, id: string) => {
    if (room === id) return
    if (roomState.has(room)) return // subscribe already in flight or completed

    const pending = subscribe(`doc:${room}`, (data: unknown) => {
      // Skip messages published by this node — it already emitted to its local
      // sockets directly in handleOpSubmit.  Without this guard, every op
      // would be emitted twice to clients on the publishing node.
      if (
        typeof data === 'object' &&
        data !== null &&
        (data as Record<string, unknown>).publisherId === NODE_ID
      ) {
        return
      }
      io.to(room).emit(WS.OP_BROADCAST, data)
    }).catch((err: unknown) => {
      // Subscribe failed — remove the entry so a future join can retry.
      roomState.delete(room)
      logger.error({ err, room }, 'Redis subscribe failed — cross-node broadcast disabled for room')
      // Return a no-op unsubscribe so the Promise type is consistent.
      return async () => {
        /* no-op */
      }
    })

    roomState.set(room, pending)
  })

  io.of('/').adapter.on('leave-room', (room: string, id: string) => {
    if (room === id) return
    if (io.sockets.adapter.rooms.get(room)) return // other sockets still in the room

    const pending = roomState.get(room)
    if (!pending) return
    roomState.delete(room)

    // Await the in-flight subscribe (if still pending) then unsubscribe.
    // This handles the race where the last socket leaves before subscribe()
    // resolves — without this the Redis subscription would leak indefinitely.
    pending
      .then((unsub) => unsub())
      .catch((err: unknown) => {
        logger.warn({ err, room }, 'Redis unsubscribe failed')
      })
  })
}

/**
 * Create and configure the Socket.io server.
 *
 * Authentication: every connection must supply a JWT via the Socket.io
 * `auth` payload (`socket = io(url, { auth: { token } })`).  This is the
 * preferred transport because `auth` is never part of the HTTP request URL
 * and therefore does not appear in proxy, CDN, or access logs.
 *
 * For backwards compatibility during client migration, `handshake.query.token`
 * is also accepted as a fallback.  Once all clients have been updated to pass
 * `auth.token`, the query-string fallback should be removed to eliminate the
 * risk of credential leakage via URL logging.
 *
 * TODO: remove `handshake.query.token` fallback once client migration is complete.
 *
 * After authentication, `socket.data` is populated with `userId`,
 * `workspaceId`, and optionally `name` from the token payload.
 *
 * @param httpServer  The Node.js HTTP server to attach Socket.io to.
 * @returns           The configured `Server` instance.
 */
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
      // Restrict to HS256 — the only algorithm compatible with a symmetric
      // JWT_SECRET.  Without this constraint, an attacker could craft a token
      // signed with RS256 (or the "none" algorithm) and jwt.verify() might
      // accept it depending on the jsonwebtoken version.
      const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] })

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
