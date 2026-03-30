import { randomUUID } from 'crypto'

import { Request, Response, NextFunction } from 'express'

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID()
  req.headers['x-request-id'] = id
  res.setHeader('X-Request-Id', id)
  next()
}
