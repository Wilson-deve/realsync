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

// Cache on global only in development to survive hot reloads.
// In test each module load gets a fresh client to prevent cross-test leakage.
if (env.NODE_ENV === 'development') {
  global.__prisma = prisma
}
