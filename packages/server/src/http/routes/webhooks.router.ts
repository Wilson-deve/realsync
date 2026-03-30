import { Router } from 'express'
import { z } from 'zod'

import { prisma } from '../../db/client'
import { logger } from '../../utils/logger'
import { requireAuth } from '../middleware/auth'
import { validateBody } from '../middleware/validate'
import { authLimiter } from '../middleware/rateLimit'

export const webhooksRouter = Router()

const createWebhookSchema = z.object({
  url: z.string().url().startsWith('https'),
  events: z.array(z.string()).min(1),
})

// POST /webhooks
webhooksRouter.post('/', authLimiter, requireAuth, validateBody(createWebhookSchema), async (req, res, next) => {
  try {
    const requestId = req.headers['x-request-id']
    const { url, events } = req.body as z.infer<typeof createWebhookSchema>

    const webhook = await prisma.webhook.create({
      data: { workspaceId: req.user.workspaceId, url, events },
    })

    logger.info({ requestId, webhookId: webhook.id, workspaceId: req.user.workspaceId }, 'Webhook created')

    res.status(201).json({ data: webhook })
  } catch (err) {
    next(err)
  }
})
