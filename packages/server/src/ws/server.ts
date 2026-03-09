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
  // Two parallel Maps — one per pub/sub channel type — both keyed by room name.
  // Each stores the pending/resolved subscribe() promise so concurrent join-room
  // events skip duplicate SUBSCRIBE calls, and leave-room can unsubscribe when
  // the last socket leaves.  See individual subscribe blocks for why the raw
  // promise is stored before chaining .catch (retry-safety).
  const opRoomState = new Map<string, Promise<() => Promise<void>>>()
  const cursorRoomState = new Map<string, Promise<() => Promise<void>>>()

  // Helper: subscribe to a channel, store the promise in the given map, and
  // register a side-effect-only .catch that removes the entry on failure so
  // the next join-room can retry.  Returns the pending promise.
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

    // op:broadcast channel — guard uses the channel string, matching the key
    // used by subscribeRoom (map.set(channel, ...)) to prevent duplicates.
    if (!opRoomState.has(`doc:${room}`)) {
      subscribeRoom(opRoomState, `doc:${room}`, (data: unknown) => {
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
      })
    }

    // presence:{docId} channel (cursor + user state, per pubsub.ts convention)
    // — same dedup pattern.
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
      // Await the in-flight subscribe (if still pending) then unsubscribe.
      // This handles the race where the last socket leaves before subscribe()
      // resolves — without this the Redis subscription would leak indefinitely.
      pending
        .then((unsub) => unsub())
        .catch((err: unknown) => {
          logger.warn({ err, channel }, 'Redis unsubscribe failed')
        })
    }
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
    // Guard auth first: Socket.io types it as `object` but it can arrive as
    // undefined/null when the client connects without an auth payload.
    // Casting without this check would throw before next() can be called,
    // turning a missing credential into an unhandled exception.
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
