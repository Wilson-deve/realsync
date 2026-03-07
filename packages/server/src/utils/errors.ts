/** Base application error with an HTTP status code and machine-readable code. */
export class AppError extends Error {
  public readonly code: string
  public readonly statusCode: number
  /** True for expected/handled errors (4xx); false for unexpected ones (5xx). */
  public readonly isOperational: boolean

  constructor(code: string, statusCode: number, message: string, isOperational = true) {
    super(message)
    this.code = code
    this.statusCode = statusCode
    this.isOperational = isOperational
    Error.captureStackTrace(this, this.constructor)
  }
}

/** Convenience factory for the most common error cases. */
export const Errors = {
  notFound:     (resource: string) => new AppError('NOT_FOUND',    404, `${resource} not found`),
  unauthorized: ()                 => new AppError('UNAUTHORIZED',  401, 'Authentication required'),
  forbidden:    (action: string)   => new AppError('FORBIDDEN',    403, `Not allowed to ${action}`),
  conflict:     (msg: string)      => new AppError('CONFLICT',     409, msg),
  badRequest:   (msg: string)      => new AppError('BAD_REQUEST',  400, msg),
  internal:     (msg: string)      => new AppError('INTERNAL',     500, msg, false),
}
