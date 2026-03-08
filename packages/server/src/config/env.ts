import { z } from 'zod'
import dotenv from 'dotenv'
dotenv.config()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  API_KEY_PREFIX: z.string().default('rs_live_'),
  WEBHOOK_SECRET: z.string().optional(),
})

const result = envSchema.safeParse(process.env)

if (!result.success) {
  console.error('Invalid environment variables:')
  console.error(result.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = result.data
