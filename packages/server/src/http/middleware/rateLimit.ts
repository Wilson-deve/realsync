import rateLimit from 'express-rate-limit'

export const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests' })
  },
})

export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  keyGenerator: (req) => req.user?.userId ?? req.ip ?? 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests' })
  },
})
