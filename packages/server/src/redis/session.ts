import { randomUUID } from 'crypto'
import { pubClient } from './client'
import { logger } from '../utils/logger'

const SESSION_TTL = 30 * 60 // 30 minutes in seconds

/**
 * Inspect the per-command results returned by ioredis `multi().exec()`.
 * Each entry is a `[Error | null, unknown]` tuple — a non-null error means
 * that specific command failed even though the transaction was sent.
 * Throws an aggregated error if any command failed, or if the pipeline
 * itself was aborted (exec returned null, e.g. after a WATCH conflict).
 */
function assertExecResults(results: Array<[Error | null, unknown]> | null, context: string): void {
  if (results === null) {
    throw new Error(`Redis MULTI/EXEC aborted (WATCH conflict) in ${context}`)
  }
  const failed = results
    .map(([err], i) => (err ? `command[${i}]: ${err.message}` : null))
    .filter((msg): msg is string => msg !== null)
  if (failed.length > 0) {
    throw new Error(`Redis MULTI/EXEC partial failure in ${context}: ${failed.join('; ')}`)
  }
}

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
 * All three commands are dispatched atomically via MULTI/EXEC — Redis will
 * not interleave other clients' commands between them. Note: Redis does not
 * roll back on per-command runtime errors; `assertExecResults` checks the
 * per-command result array and throws if any command failed so the caller
 * is aware of partial writes.
 */
export async function setSession(sessionId: string, data: SessionData): Promise<void> {
  const key = `session:${sessionId}`
  const results = await pubClient
    .multi()
    .set(key, JSON.stringify(data), 'EX', SESSION_TTL)
    .sadd(`doc-sessions:${data.docId}`, sessionId)
    .expire(`doc-sessions:${data.docId}`, SESSION_TTL)
    .exec()
  assertExecResults(results, `setSession(${sessionId})`)
}

/** Read a session by ID. Returns `null` if the key has expired or never existed.
 * If the stored value is not valid JSON (corrupted or schema mismatch), the key
 * is deleted and `null` is returned rather than letting the error bubble up.
 */
export async function getSession(sessionId: string): Promise<SessionData | null> {
  const key = `session:${sessionId}`
  const raw = await pubClient.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SessionData
  } catch {
    logger.warn({ sessionId }, 'Redis: corrupt session value — deleting key')
    await pubClient.del(key)
    return null
  }
}

/** Remove a session and deregister it from its document's session set.
 * Both commands are dispatched atomically via MULTI/EXEC — no other client's
 * commands can interleave between them. Note: Redis does not roll back on
 * per-command errors; `assertExecResults` checks the result array and throws
 * if either command failed.
 */
export async function deleteSession(sessionId: string, docId: string): Promise<void> {
  const results = await pubClient
    .multi()
    .del(`session:${sessionId}`)
    .srem(`doc-sessions:${docId}`, sessionId)
    .exec()
  assertExecResults(results, `deleteSession(${sessionId})`)
}

/**
 * Return all live SessionData objects for a given document.
 * Fetches all session keys in a single MGET round-trip instead of one GET
 * per session. Expired/missing sessions (null values) are filtered out and
 * their IDs are pruned from the doc-sessions set in one SREM call.
 * Corrupt values are logged and treated as missing.
 */
export async function getDocSessions(docId: string): Promise<SessionData[]> {
  const ids = await pubClient.smembers(`doc-sessions:${docId}`)
  if (ids.length === 0) return []

  const keys = ids.map((id) => `session:${id}`)
  const raws = await pubClient.mget(...keys)

  const live: SessionData[] = []
  const stale: string[] = []
  const corrupt: string[] = []

  for (let i = 0; i < ids.length; i++) {
    const raw = raws[i]
    if (!raw) {
      stale.push(ids[i])
      continue
    }
    try {
      live.push(JSON.parse(raw) as SessionData)
    } catch {
      logger.warn(
        { sessionId: ids[i] },
        'Redis: corrupt session value in getDocSessions — deleting key'
      )
      corrupt.push(ids[i])
      stale.push(ids[i])
    }
  }

  const cleanups: Promise<unknown>[] = []
  if (stale.length > 0) cleanups.push(pubClient.srem(`doc-sessions:${docId}`, ...stale))
  if (corrupt.length > 0) cleanups.push(pubClient.del(...corrupt.map((id) => `session:${id}`)))
  if (cleanups.length > 0) await Promise.all(cleanups)
  return live
}

/**
 * Return the current server-side version counter for a document.
 * Returns `null` when the Redis key is absent (never set or evicted after a
 * restart) so callers can distinguish that from an explicit version=0.
 * Returns a parsed integer when the key exists.
 * Throws if the stored value is not a valid non-negative integer.
 */
export async function getDocVersion(docId: string): Promise<number | null> {
  const v = await pubClient.get(`doc-version:${docId}`)
  if (v === null) return null
  if (!/^\d+$/.test(v)) {
    throw new Error(`Corrupt doc-version for ${docId}: stored value "${v}" is not a valid integer`)
  }
  return Number(v)
}

/**
 * Persist the current version counter for a document.
 *
 * @param nx  When true, uses SET NX (only write if the key does not already
 *            exist).  Use this when seeding from the DB to avoid overwriting
 *            a version that handleOpSubmit may have written concurrently.
 */
export async function setDocVersion(docId: string, version: number, nx = false): Promise<void> {
  if (nx) {
    await pubClient.set(`doc-version:${docId}`, version.toString(), 'NX')
  } else {
    await pubClient.set(`doc-version:${docId}`, version.toString())
  }
}

/** Delete the version counter key for a document (e.g., to force a re-seed). */
export async function deleteDocVersion(docId: string): Promise<void> {
  await pubClient.del(`doc-version:${docId}`)
}

/**
 * Acquire a Redis-backed mutex with a spin-wait.
 * Returns a unique token that the caller MUST pass to `releaseLock`.
 *
 * @param key             Redis key used as the mutex.
 * @param lockTtlMs       How long the lock is held in Redis (PX expiry).
 *                        Must be long enough for the critical section to finish.
 * @param acquireTimeoutMs  Maximum time to spend waiting for the lock before
 *                        throwing. Defaults to `lockTtlMs` when omitted.
 *
 * Safety: stores a random token as the lock value instead of a constant.
 * This lets `releaseLock` verify ownership before deleting, preventing a
 * slow holder from releasing a lock that has already expired and been
 * re-acquired by another worker.
 */
export async function acquireLock(
  key: string,
  lockTtlMs: number,
  acquireTimeoutMs: number = lockTtlMs
): Promise<string> {
  const token = randomUUID()
  const deadline = Date.now() + acquireTimeoutMs
  let attempt = 0
  while (Date.now() < deadline) {
    const result = await pubClient.set(key, token, 'PX', lockTtlMs, 'NX')
    if (result === 'OK') return token
    // Exponential backoff with full jitter: delay in [0, min(cap, base * 2^attempt)].
    // This avoids thundering-herd when many workers contend for the same lock.
    const cap = 500
    const base = 10
    const ceiling = Math.min(cap, base * 2 ** attempt)
    const delay = Math.max(1, Math.floor(Math.random() * ceiling))
    await new Promise<void>((r) => setTimeout(r, delay))
    attempt++
  }
  throw new Error(`Could not acquire lock: ${key}`)
}

/**
 * Release a Redis mutex acquired via `acquireLock`.
 * Uses a Lua script to atomically check the stored token before deleting,
 * so a holder whose TTL already expired cannot delete a new owner's lock.
 * Logs a warning when the script returns 0 — meaning the lock either expired
 * or was already taken by another holder — so the caller is aware it may have
 * operated outside the critical section.
 */
export async function releaseLock(key: string, token: string): Promise<void> {
  const released = await pubClient.eval(RELEASE_LOCK_SCRIPT, 1, key, token)
  if (released !== 1) {
    logger.warn({ key }, 'releaseLock: lock was not held (expired or token mismatch)')
  }
}
