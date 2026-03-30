import express, { Application } from 'express'
import helmet from 'helmet'
import cors from 'cors'

import { env } from '../config/env'
import { requestId } from './middleware/requestId'
import { errorHandler } from './middleware/errorHandler'
import { authRouter } from './routes/auth.router'
import { workspacesRouter } from './routes/workspaces.router'
import { documentsRouter } from './routes/documents.router'
import { webhooksRouter } from './routes/webhooks.router'

export function setupRoutes(app: Application): void {
  app.use(helmet())
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }))
  app.use(express.json({ limit: '1mb' }))
  app.use(requestId)

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  app.use('/auth', authRouter)
  app.use('/workspaces', workspacesRouter)
  app.use('/docs', documentsRouter)
  app.use('/webhooks', webhooksRouter)

  // errorHandler must be last
  app.use(errorHandler)
}
