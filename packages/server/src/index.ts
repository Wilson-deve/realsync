import express from 'express'
import { createServer } from 'http'
import { createWebSocketServer } from './ws/server'
import { connectRedis, pubClient, subClient } from './redis/client'
import { prisma } from './db/client'
import { env } from './config/env'
import { logger } from './utils/logger'

async function main(): Promise<void> {
  // Connect to Redis before starting the server so pub/sub is ready immediately.
  await connectRedis()
  logger.info('Redis connected')

  // Verify the database connection is healthy on startup.
  await prisma.$connect()
  logger.info('PostgreSQL connected')

  const app = express()
  app.use(express.json())

  /** Health check — used by load balancers and Docker HEALTHCHECK. */
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: process.env['npm_package_version'] ?? '0.1.0' })
  })

  const httpServer = createServer(app)
  const io = createWebSocketServer(httpServer)

  httpServer.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'RealSync server running...')
  })

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Shutting down gracefully…')

    // Close the Socket.io server first — stops accepting new WS connections
    // and waits for existing sockets to disconnect.
    await new Promise<void>((resolve) => io.close(() => resolve()))

    // Stop the HTTP server and wait for in-flight requests to finish.
    await new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve()))
    )

    await Promise.allSettled([prisma.$disconnect(), pubClient.quit(), subClient.quit()])
    logger.info('Shutdown complete')
    process.exit(0)
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Fatal startup error')
  process.exit(1)
})
