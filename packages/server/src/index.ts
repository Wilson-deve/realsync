import express from 'express'
import { createServer } from 'http'
import { createWebSocketServer } from './ws/server'
import { connectRedis, pubClient, subClient } from './redis/client'
import { prisma } from './db/client'
import { env } from './config/env'
import { logger } from './utils/logger'

async function main(): Promise<void> {
  await connectRedis()
  logger.info('Redis connected')

  await prisma.$connect()
  logger.info('PostgreSQL connected')

  const app = express()
  app.use(express.json())

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: process.env['npm_package_version'] ?? '0.1.0' })
  })

  const httpServer = createServer(app)
  const io = createWebSocketServer(httpServer)

  httpServer.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'RealSync server running...')
  })

  let shutdownPromise: Promise<void> | null = null

  function shutdown(signal: string): Promise<void> {
    if (shutdownPromise) {
      logger.info({ signal }, 'shutdown already in progress — ignoring duplicate signal')
      return shutdownPromise
    }

    shutdownPromise = (async () => {
      logger.info({ signal }, 'Shutting down gracefully…')

      await new Promise<void>((resolve) => io.close(() => resolve()))

      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => {
          if (!err || (err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
            resolve()
          } else {
            reject(err)
          }
        })
      )

      await Promise.allSettled([prisma.$disconnect(), pubClient.quit(), subClient.quit()])
      logger.info('Shutdown complete')
      process.exit(0)
    })()

    return shutdownPromise
  }

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err: unknown) => {
      logger.error({ err }, 'shutdown: unhandled error — forcing exit')
      process.exit(1)
    })
  })
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err: unknown) => {
      logger.error({ err }, 'shutdown: unhandled error — forcing exit')
      process.exit(1)
    })
  })
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Fatal startup error')
  process.exit(1)
})
