import { randomUUID } from 'crypto'

import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt, { SignOptions } from 'jsonwebtoken'
import { z } from 'zod'

import { prisma } from '../../db/client'
import { env } from '../../config/env'
import { logger } from '../../utils/logger'
import { AppError } from '../../utils/errors'
import { validateBody } from '../middleware/validate'
import { publicLimiter } from '../middleware/rateLimit'

export const authRouter = Router()

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
})

function issueTokens(userId: string, workspaceId: string, role: string): { accessToken: string; refreshToken: string } {
  const base: SignOptions = {}
  const accessOpts: SignOptions = { ...base, expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'] }
  const refreshOpts: SignOptions = { ...base, expiresIn: env.JWT_REFRESH_EXPIRES_IN as SignOptions['expiresIn'] }

  const accessToken = jwt.sign({ userId, workspaceId, role }, env.JWT_SECRET, accessOpts)
  const refreshToken = jwt.sign({ userId, workspaceId, role }, env.JWT_SECRET, refreshOpts)
  return { accessToken, refreshToken }
}

// POST /auth/register
authRouter.post('/register', publicLimiter, validateBody(registerSchema), async (req, res, next) => {
  try {
    const { email, name, password } = req.body as z.infer<typeof registerSchema>
    const requestId = req.headers['x-request-id']

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      throw new AppError('CONFLICT', 409, 'A user with that email already exists')
    }

    const passwordHash = await bcrypt.hash(password, 12)
    const apiKey = env.API_KEY_PREFIX + randomUUID()

    // Create workspace first (ownerId updated after user is created)
    const result = await prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: { name: `${name}'s Workspace`, apiKey, ownerId: 'pending' },
      })
      const user = await tx.user.create({
        data: { email, name, passwordHash, workspaceId: workspace.id, role: 'OWNER' },
      })
      await tx.workspace.update({ where: { id: workspace.id }, data: { ownerId: user.id } })
      return { user, workspace: { ...workspace, ownerId: user.id } }
    })

    const { accessToken, refreshToken } = issueTokens(result.user.id, result.workspace.id, result.user.role)

    logger.info({ requestId, userId: result.user.id }, 'User registered')

    res.status(201).json({
      data: {
        user: { id: result.user.id, email: result.user.email, name: result.user.name, role: result.user.role },
        workspace: { id: result.workspace.id, name: result.workspace.name },
        accessToken,
        refreshToken,
      },
    })
  } catch (err) {
    next(err)
  }
})

// POST /auth/login
authRouter.post('/login', publicLimiter, validateBody(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body as z.infer<typeof loginSchema>
    const requestId = req.headers['x-request-id']

    const user = await prisma.user.findUnique({ where: { email } })
    const invalidMsg = 'Invalid credentials'

    if (!user) {
      // Compare against a dummy hash to prevent timing attacks
      await bcrypt.compare(password, '$2a$12$invalidhashXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
      throw new AppError('UNAUTHORIZED', 401, invalidMsg)
    }

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) {
      throw new AppError('UNAUTHORIZED', 401, invalidMsg)
    }

    const { accessToken, refreshToken } = issueTokens(user.id, user.workspaceId, user.role)

    logger.info({ requestId, userId: user.id }, 'User logged in')

    res.json({
      data: {
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        accessToken,
        refreshToken,
      },
    })
  } catch (err) {
    next(err)
  }
})

// POST /auth/refresh
authRouter.post('/refresh', publicLimiter, validateBody(refreshSchema), async (req, res, next) => {
  try {
    const { refreshToken } = req.body as z.infer<typeof refreshSchema>

    let payload: { userId: string; workspaceId: string; role: string }
    try {
      payload = jwt.verify(refreshToken, env.JWT_SECRET) as typeof payload
    } catch {
      throw new AppError('UNAUTHORIZED', 401, 'Invalid or expired refresh token')
    }

    const tokens = issueTokens(payload.userId, payload.workspaceId, payload.role)

    res.json({ data: tokens })
  } catch (err) {
    next(err)
  }
})
