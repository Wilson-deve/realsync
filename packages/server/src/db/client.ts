import { PrismaClient } from '@prisma/client'
import { env } from '../config/env'

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
  })

if (env.NODE_ENV === 'development') {
  global.__prisma = prisma
}
