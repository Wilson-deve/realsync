import type { SessionData } from '../redis/session'

/** All Socket.io event name constants. Import from here — no magic strings elsewhere. */
export const WS = {
  // Client → Server
  OP_SUBMIT: 'op:submit',
  CURSOR_UPDATE: 'cursor:update',
  PRESENCE_PING: 'presence:ping',
  ROOM_JOIN: 'room:join',
  ROOM_LEAVE: 'room:leave',

  // Server → Client
  OP_ACK: 'op:ack',
  OP_BROADCAST: 'op:broadcast',
  CURSOR_BROADCAST: 'cursor:broadcast',
  PRESENCE_UPDATE: 'presence:update',
  DOC_RECONNECT: 'doc:reconnect',
  ERROR: 'error',
} as const

// ── Socket.io typed event maps ───────────────────────────────────────────────

/** Events the server can emit to a client. */
export interface ServerToClientEvents {
  'op:ack': (payload: { serverVersion: number; timestamp: number }) => void
  'op:broadcast': (payload: unknown) => void
  /** Delta update: a single user's cursor moved. Cheaper than a full presence:update. */
  'cursor:broadcast': (payload: {
    userId: string
    name: string
    color: string
    cursor: number
  }) => void
  'presence:update': (payload: { users: SessionData[] }) => void
  'doc:reconnect': (payload: {
    snapshot: string
    version: number
    ops: unknown[]
    /** The server version the client is synchronised to after replaying ops.
     *  Any op:broadcast received with serverVersion > syncedVersion arrived
     *  after the snapshot was taken and must be applied on top; any broadcast
     *  with serverVersion <= syncedVersion is already included in ops and can
     *  be discarded.  Clients should buffer broadcasts received between
     *  room:join and doc:reconnect and apply only those above this boundary. */
    syncedVersion: number
  }) => void
  error: (payload: { code: string; message: string }) => void
}

/** Events the client can emit to the server. */
export interface ClientToServerEvents {
  'op:submit': (payload: unknown) => void
  'cursor:update': (payload: unknown) => void
  'presence:ping': (payload: unknown) => void
  'room:join': (payload: unknown) => void
  'room:leave': (payload: unknown) => void
}
