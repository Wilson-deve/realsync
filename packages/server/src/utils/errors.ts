export class AppError extends Error {
  public readonly code: string
  public readonly statusCode: number
  public readonly isOperational: boolean

  constructor(code: string, statusCode: number, message: string, isOperational = true) {
    super(message)
    this.code = code
    this.statusCode = statusCode
    this.isOperational = isOperational
    this.name = this.constructor.name
    Error.captureStackTrace(this, this.constructor)
  }
}

export const Errors = {
  notFound: (resource: string) => new AppError('NOT_FOUND', 404, `${resource} not found`),
  unauthorized: () => new AppError('UNAUTHORIZED', 401, 'Authentication required'),
  forbidden: (action: string) => new AppError('FORBIDDEN', 403, `Not allowed to ${action}`),
  conflict: (msg: string) => new AppError('CONFLICT', 409, msg),
  badRequest: (msg: string) => new AppError('BAD_REQUEST', 400, msg),
  internal: (msg: string) => new AppError('INTERNAL', 500, msg, false),
}
