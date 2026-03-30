import { Request, Response, NextFunction } from 'express'

import { AppError } from '../../utils/errors'
import { logger } from '../../utils/logger'

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError && err.isOperational) {
    res.status(err.statusCode).json({ code: err.code, message: err.message })
    return
  }

  // Express body-parser parse failure (malformed JSON body)
  if ('statusCode' in err && (err as { statusCode: unknown }).statusCode === 400) {
    res.status(400).json({ code: 'INVALID_JSON', message: 'Request body contains invalid JSON' })
    return
  }

  logger.error({ err, requestId: req.headers['x-request-id'] }, 'Unhandled error')
  res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' })
}
