import { z } from 'zod'
import dotenv from 'dotenv'
dotenv.config()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  API_KEY_PREFIX: z.string().default('rs_live_'),
  WEBHOOK_SECRET: z.string().optional(),
  // Maximum time (ms) the per-document OT lock is held before it auto-expires.
  // Must be long enough to cover DB reads/writes + Redis publish under load.
  // Keeping this well above the p99 critical-section latency prevents a slow
  // node from releasing a lock that has already been re-acquired by another
  // worker and reintroducing version collisions.
  OP_LOCK_TTL_MS: z.coerce.number().int().positive().default(30_000),
  // Debounce window (ms) for coalescing presence:ping broadcasts.
  // All pings that arrive within this window collapse into a single
  // getDocSessions() read + PRESENCE_UPDATE emit.  Set lower for snappier
  // presence UI; set higher to reduce Redis load with many concurrent users.
  PRESENCE_DEBOUNCE_MS: z.coerce.number().int().positive().default(2_000),
  // Maximum number of server ops a client is allowed to be behind before
  // we refuse to transform inline and instead force a full doc:reconnect.
  // Applying N transforms while holding the per-document lock is O(N) DB
  // work on the hot path; an unbounded catch-up window lets a far-behind or
  // adversarial client cause arbitrarily long lock holds.
  // Default matches the snapshot interval (100 ops) so clients within one
  // snapshot window always get inline transform; beyond that, they resync.
  OP_MAX_CATCHUP_OPS: z.coerce.number().int().positive().default(100),
})

const result = envSchema.safeParse(process.env)

if (!result.success) {
  console.error('Invalid environment variables:')
  console.error(result.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = result.data
