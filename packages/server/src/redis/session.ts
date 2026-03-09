import { randomUUID } from 'crypto'
import { pubClient } from './client'
import { logger } from '../utils/logger'

const SESSION_TTL = 30 * 60 // 30 minutes in seconds

/** Inspects the per-command results returned by ioredis `multi().exec()` and throws an aggregated error on failure or abort. */
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

// Lua script: atomically deletes the key only when the stored value equals the caller's token.
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

/** Writes a session to Redis with a 30-minute TTL and registers it in the document's session set atomically. */
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

/** Reads a session by ID, returning null and deleting the key if expired, missing, or corrupted. */
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

/** Removes a session and atomically deregisters it from its document's session set. */
export async function deleteSession(sessionId: string, docId: string): Promise<void> {
  const results = await pubClient
    .multi()
    .del(`session:${sessionId}`)
    .srem(`doc-sessions:${docId}`, sessionId)
    .exec()
  assertExecResults(results, `deleteSession(${sessionId})`)
}

/** Returns all live SessionData objects for a document, pruning expired and corrupt sessions. */
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

/** Returns the current server-side version counter for a document or null if absent. */
export async function getDocVersion(docId: string): Promise<number | null> {
  const v = await pubClient.get(`doc-version:${docId}`)
  if (v === null) return null
  if (!/^\d+$/.test(v)) {
    throw new Error(`Corrupt doc-version for ${docId}: stored value "${v}" is not a valid integer`)
  }
  return Number(v)
}

/** Persists the current version counter for a document, optionally using SET NX. */
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

/** Acquires a Redis-backed mutex with a spin-wait and exponential backoff, returning a token for releaseLock. */
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
    // Exponential backoff with full jitter to avoid thundering-herd.
    const cap = 500
    const base = 10
    const ceiling = Math.min(cap, base * 2 ** attempt)
    const delay = Math.max(1, Math.floor(Math.random() * ceiling))
    await new Promise<void>((r) => setTimeout(r, delay))
    attempt++
  }
  throw new Error(`Could not acquire lock: ${key}`)
}

/** Atomically releases a Redis mutex only if the stored token matches. */
export async function releaseLock(key: string, token: string): Promise<void> {
  const released = await pubClient.eval(RELEASE_LOCK_SCRIPT, 1, key, token)
  if (released !== 1) {
    logger.warn({ key }, 'releaseLock: lock was not held (expired or token mismatch)')
  }
}
