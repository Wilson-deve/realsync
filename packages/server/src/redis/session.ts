import { randomUUID } from 'crypto'
import { pubClient } from './client'

const SESSION_TTL = 30 * 60 // 30 minutes in seconds

// Lua script: delete the key only when the stored value equals the caller's token.
// Runs atomically inside Redis — no other command can execute between the GET and DEL.
const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`

export interface SessionData {
  userId: string
  name: string
  docId: string
  cursor: number
  color: string
  lastSeen: number
}

/**
 * Write a session to Redis with a 30-minute TTL.
 * Also registers the sessionId in the per-document set so
 * `getDocSessions()` can enumerate all active sessions for a document.
 *
 * All three commands are sent in a single pipeline (MULTI/EXEC) so a
 * mid-flight crash cannot leave the session key and the set membership
 * in an inconsistent state.
 */
export async function setSession(sessionId: string, data: SessionData): Promise<void> {
  const key = `session:${sessionId}`
  await pubClient
    .multi()
    .set(key, JSON.stringify(data), 'EX', SESSION_TTL)
    .sadd(`doc-sessions:${data.docId}`, sessionId)
    .expire(`doc-sessions:${data.docId}`, SESSION_TTL)
    .exec()
}

/** Read a session by ID. Returns `null` if the key has expired or never existed. */
export async function getSession(sessionId: string): Promise<SessionData | null> {
  const raw = await pubClient.get(`session:${sessionId}`)
  return raw ? (JSON.parse(raw) as SessionData) : null
}

/** Remove a session and deregister it from its document's session set. */
export async function deleteSession(sessionId: string, docId: string): Promise<void> {
  await pubClient.del(`session:${sessionId}`)
  await pubClient.srem(`doc-sessions:${docId}`, sessionId)
}

/**
 * Return all live SessionData objects for a given document.
 * Expired sessions are silently filtered out (getSession returns null).
 */
export async function getDocSessions(docId: string): Promise<SessionData[]> {
  const ids = await pubClient.smembers(`doc-sessions:${docId}`)
  const sessions = await Promise.all(ids.map((id) => getSession(id)))
  return sessions.filter((s): s is SessionData => s !== null)
}

/** Return the current server-side version counter for a document. Defaults to 0. */
export async function getDocVersion(docId: string): Promise<number> {
  const v = await pubClient.get(`doc-version:${docId}`)
  return v ? parseInt(v, 10) : 0
}

/** Persist the current version counter for a document. */
export async function setDocVersion(docId: string, version: number): Promise<void> {
  await pubClient.set(`doc-version:${docId}`, version.toString())
}

/**
 * Acquire a Redis-backed mutex with a spin-wait.
 * Returns a unique token that the caller MUST pass to `releaseLock`.
 * Throws if the lock cannot be acquired within `ttlMs` milliseconds.
 *
 * Safety: stores a random token as the lock value instead of a constant.
 * This lets `releaseLock` verify ownership before deleting, preventing a
 * slow holder from releasing a lock that has already expired and been
 * re-acquired by another worker.
 */
export async function acquireLock(key: string, ttlMs: number): Promise<string> {
  const token = randomUUID()
  const deadline = Date.now() + ttlMs
  while (Date.now() < deadline) {
    const result = await pubClient.set(key, token, 'PX', ttlMs, 'NX')
    if (result === 'OK') return token
    await new Promise<void>((r) => setTimeout(r, 10)) // back-off 10 ms before retry
  }
  throw new Error(`Could not acquire lock: ${key}`)
}

/**
 * Release a Redis mutex acquired via `acquireLock`.
 * Uses a Lua script to atomically check the stored token before deleting,
 * so a holder whose TTL already expired cannot delete a new owner's lock.
 */
export async function releaseLock(key: string, token: string): Promise<void> {
  await pubClient.eval(RELEASE_LOCK_SCRIPT, 1, key, token)
}
