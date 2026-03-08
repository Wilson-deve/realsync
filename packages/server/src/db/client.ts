import { PrismaClient } from '@prisma/client'
import { env } from '../config/env'

// Singleton pattern — one Prisma instance for the entire process.
// In development, attach to global to survive hot reloads.
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
  })

if (env.NODE_ENV !== 'production') {
  global.__prisma = prisma
}
