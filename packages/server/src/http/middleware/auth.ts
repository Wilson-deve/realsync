import jwt from 'jsonwebtoken'

import { Request, Response, NextFunction } from 'express'

import { env } from '../../config/env'
import { AppError } from '../../utils/errors'

declare global {
  namespace Express {
    interface Request {
      user: { userId: string; workspaceId: string; role: string }
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return next(new AppError('UNAUTHORIZED', 401, 'Authentication required'))
  }

  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as {
      userId: string
      workspaceId: string
      role: string
    }
    req.user = { userId: payload.userId, workspaceId: payload.workspaceId, role: payload.role }
    next()
  } catch {
    next(new AppError('UNAUTHORIZED', 401, 'Invalid or expired token'))
  }
}
