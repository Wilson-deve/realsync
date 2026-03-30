import { z } from 'zod'

import { Request, Response, NextFunction } from 'express'

export function validateBody<T>(schema: z.ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        errors: result.error.flatten().fieldErrors,
      })
      return
    }
    req.body = result.data
    next()
  }
}
