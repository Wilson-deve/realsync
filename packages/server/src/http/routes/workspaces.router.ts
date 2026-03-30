import { Router } from 'express'

import { prisma } from '../../db/client'
import { logger } from '../../utils/logger'
import { AppError } from '../../utils/errors'
import { requireAuth } from '../middleware/auth'
import { authLimiter } from '../middleware/rateLimit'

export const workspacesRouter = Router()

// GET /workspaces/:id
workspacesRouter.get('/:id', authLimiter, requireAuth, async (req, res, next) => {
  try {
    const requestId = req.headers['x-request-id']
    const { id } = req.params

    if (req.user.workspaceId !== id) {
      throw new AppError('FORBIDDEN', 403, 'Access denied to this workspace')
    }

    const [workspace, documentCount, memberCount] = await Promise.all([
      prisma.workspace.findUnique({ where: { id } }),
      prisma.document.count({ where: { workspaceId: id, deletedAt: null } }),
      prisma.user.count({ where: { workspaceId: id } }),
    ])

    if (!workspace) {
      throw new AppError('NOT_FOUND', 404, 'Workspace not found')
    }

    // Mask API key — show only last 6 chars
    const maskedKey = `rs_live_${'•'.repeat(8)}${workspace.apiKey.slice(-6)}`

    logger.info({ requestId, workspaceId: id }, 'Workspace fetched')

    res.json({
      data: {
        id: workspace.id,
        name: workspace.name,
        apiKey: maskedKey,
        createdAt: workspace.createdAt,
        documentCount,
        memberCount,
      },
    })
  } catch (err) {
    next(err)
  }
})
