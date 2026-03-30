import { createHmac } from 'crypto'

import axios from 'axios'

import { prisma } from '../db/client'
import { env } from '../config/env'
import { logger } from '../utils/logger'

export async function deliverWebhook(
  workspaceId: string,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  const webhooks = await prisma.webhook.findMany({
    where: { workspaceId, events: { has: event } },
  })

  if (webhooks.length === 0) return

  const body = JSON.stringify({ event, payload, timestamp: new Date().toISOString() })
  const secret = env.WEBHOOK_SECRET ?? 'no-secret'
  const signature = createHmac('sha256', secret).update(body).digest('hex')

  await Promise.allSettled(
    webhooks.map(async (wh) => {
      try {
        await axios.post(wh.url, body, {
          headers: {
            'Content-Type': 'application/json',
            'X-RealSync-Signature': `sha256=${signature}`,
            'X-RealSync-Event': event,
          },
          timeout: 5000,
        })
        logger.info({ webhookId: wh.id, event, workspaceId }, 'Webhook delivered')
      } catch (err) {
        logger.error({ err, webhookId: wh.id, event, workspaceId }, 'Webhook delivery failed')
      }
    })
  )
}
