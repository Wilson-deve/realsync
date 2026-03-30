import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { z } from 'zod'

import { createDocument, getDocument, softDeleteDocument } from '../../db/documents'
import { prisma } from '../../db/client'
import { env } from '../../config/env'
import { logger } from '../../utils/logger'
import { AppError } from '../../utils/errors'
import { requireAuth } from '../middleware/auth'
import { validateBody } from '../middleware/validate'
import { authLimiter } from '../middleware/rateLimit'

export const documentsRouter = Router()

const createDocSchema = z.object({
  title: z.string().min(1).optional(),
})

const patchDocSchema = z.object({
  title: z.string().min(1).optional(),
})

const shareSchema = z.object({
  role: z.enum(['viewer', 'editor', 'commenter']),
  expiresInDays: z.number().int().positive().optional(),
})

// POST /docs
documentsRouter.post('/', authLimiter, requireAuth, validateBody(createDocSchema), async (req, res, next) => {
  try {
    const requestId = req.headers['x-request-id']
    const { title } = req.body as z.infer<typeof createDocSchema>

    const doc = await createDocument(req.user.workspaceId, title ?? 'Untitled', req.user.userId)

    logger.info({ requestId, docId: doc.id, workspaceId: req.user.workspaceId }, 'Document created')

    res.status(201).json({
      data: {
        id: doc.id,
        title: doc.title,
        snapshotContent: doc.snapshotContent,
        snapshotVersion: doc.snapshotVersion,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      },
    })
  } catch (err) {
    next(err)
  }
})

// GET /docs/:id — supports auth token OR ?shareToken=
documentsRouter.get('/:id', async (req, res, next) => {
  try {
    const requestId = req.headers['x-request-id']
    const { id } = req.params
    const shareToken = req.query['shareToken'] as string | undefined

    const doc = await getDocument(id)
    if (!doc) {
      throw new AppError('NOT_FOUND', 404, 'Document not found')
    }

    let hasAccess = false

    if (req.headers.authorization?.startsWith('Bearer ')) {
      try {
        const token = req.headers.authorization.slice(7)
        const payload = jwt.verify(token, env.JWT_SECRET) as { workspaceId: string }
        hasAccess = payload.workspaceId === doc.workspaceId
      } catch {
        // fall through to share token check
      }
    }

    if (!hasAccess && shareToken) {
      try {
        const payload = jwt.verify(shareToken, env.JWT_SECRET) as { docId: string }
        hasAccess = payload.docId === id
      } catch {
        // invalid share token
      }
    }

    if (!hasAccess) {
      throw new AppError('FORBIDDEN', 403, 'Access denied to this document')
    }

    logger.info({ requestId, docId: id }, 'Document fetched')

    res.json({
      data: {
        id: doc.id,
        title: doc.title,
        snapshotContent: doc.snapshotContent,
        snapshotVersion: doc.snapshotVersion,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      },
    })
  } catch (err) {
    next(err)
  }
})

// PATCH /docs/:id
documentsRouter.patch('/:id', authLimiter, requireAuth, validateBody(patchDocSchema), async (req, res, next) => {
  try {
    const requestId = req.headers['x-request-id']
    const { id } = req.params
    const body = req.body as z.infer<typeof patchDocSchema>

    if (req.user.role !== 'EDITOR' && req.user.role !== 'OWNER') {
      throw new AppError('FORBIDDEN', 403, 'Insufficient permissions to edit this document')
    }

    const doc = await getDocument(id)
    if (!doc) {
      throw new AppError('NOT_FOUND', 404, 'Document not found')
    }

    if (doc.workspaceId !== req.user.workspaceId) {
      throw new AppError('FORBIDDEN', 403, 'Access denied to this document')
    }

    const updates: { title?: string } = {}
    if (body.title !== undefined) updates.title = body.title

    const updated = await prisma.document.update({ where: { id }, data: updates })

    logger.info({ requestId, docId: id }, 'Document updated')

    res.json({
      data: {
        id: updated.id,
        title: updated.title,
        snapshotContent: updated.snapshotContent,
        snapshotVersion: updated.snapshotVersion,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
    })
  } catch (err) {
    next(err)
  }
})

// DELETE /docs/:id — OWNER only, idempotent
documentsRouter.delete('/:id', authLimiter, requireAuth, async (req, res, next) => {
  try {
    const requestId = req.headers['x-request-id']
    const { id } = req.params

    if (req.user.role !== 'OWNER') {
      throw new AppError('FORBIDDEN', 403, 'Only owners can delete documents')
    }

    const doc = await getDocument(id)
    if (!doc) {
      res.status(204).send()
      return
    }

    if (doc.workspaceId !== req.user.workspaceId) {
      throw new AppError('FORBIDDEN', 403, 'Access denied to this document')
    }

    await softDeleteDocument(id, req.user.userId)

    logger.info({ requestId, docId: id }, 'Document soft-deleted')

    res.status(204).send()
  } catch (err) {
    next(err)
  }
})

// GET /docs/:id/history
documentsRouter.get('/:id/history', authLimiter, requireAuth, async (req, res, next) => {
  try {
    const requestId = req.headers['x-request-id']
    const { id } = req.params

    const page = Math.max(1, parseInt(req.query['page'] as string) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query['limit'] as string) || 50))
    const skip = (page - 1) * limit

    const doc = await getDocument(id)
    if (!doc) {
      throw new AppError('NOT_FOUND', 404, 'Document not found')
    }

    if (doc.workspaceId !== req.user.workspaceId) {
      throw new AppError('FORBIDDEN', 403, 'Access denied to this document')
    }

    const [operations, total] = await Promise.all([
      prisma.operation.findMany({
        where: { docId: id },
        orderBy: { version: 'asc' },
        skip,
        take: limit,
        include: {
          user: { select: { name: true, avatarUrl: true } },
        },
      }),
      prisma.operation.count({ where: { docId: id } }),
    ])

    logger.info({ requestId, docId: id, page, limit }, 'Document history fetched')

    res.json({
      data: {
        operations: operations.map((op) => ({
          id: op.id,
          version: op.version,
          type: op.type,
          position: op.position,
          content: op.content,
          length: op.length,
          authorId: op.userId,
          author: op.user,
          createdAt: op.timestamp,
        })),
        total,
        page,
        pages: Math.ceil(total / limit),
      },
    })
  } catch (err) {
    next(err)
  }
})

// POST /docs/:id/share
documentsRouter.post('/:id/share', authLimiter, requireAuth, validateBody(shareSchema), async (req, res, next) => {
  try {
    const requestId = req.headers['x-request-id']
    const { id } = req.params
    const { role, expiresInDays } = req.body as z.infer<typeof shareSchema>

    const doc = await getDocument(id)
    if (!doc) {
      throw new AppError('NOT_FOUND', 404, 'Document not found')
    }

    if (doc.workspaceId !== req.user.workspaceId) {
      throw new AppError('FORBIDDEN', 403, 'Access denied to this document')
    }

    const days = expiresInDays ?? 7
    const token = jwt.sign({ docId: id, role }, env.JWT_SECRET, { expiresIn: `${days}d` })

    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + days)

    const shareUrl = `${env.CORS_ORIGIN}/docs/${id}?shareToken=${token}`

    logger.info({ requestId, docId: id, role }, 'Share link generated')

    res.json({ data: { shareUrl, token, expiresAt } })
  } catch (err) {
    next(err)
  }
})
