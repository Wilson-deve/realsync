import { Prisma } from '@prisma/client'

import { prisma } from '../db/client'
import { logger } from '../utils/logger'

export async function log(
  workspaceId: string,
  actorId: string,
  action: string,
  resource: string,
  meta?: Record<string, unknown>
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorId,
        action,
        resource,
        meta: meta !== undefined ? (meta as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    })
  } catch (err) {
    logger.error({ err, workspaceId, actorId, action, resource }, 'Failed to write audit log')
  }
}
