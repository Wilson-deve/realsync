import bcrypt from 'bcryptjs'
import jwt, { SignOptions } from 'jsonwebtoken'

import { env } from '../config/env'
import { AppError } from '../utils/errors'

export function issueTokens(
  userId: string,
  workspaceId: string,
  role: string
): { accessToken: string; refreshToken: string } {
  const accessOpts: SignOptions = { expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'] }
  const refreshOpts: SignOptions = { expiresIn: env.JWT_REFRESH_EXPIRES_IN as SignOptions['expiresIn'] }

  const accessToken = jwt.sign({ userId, workspaceId, role }, env.JWT_SECRET, accessOpts)
  const refreshToken = jwt.sign({ userId, workspaceId, role }, env.JWT_SECRET, refreshOpts)
  return { accessToken, refreshToken }
}

export function verifyRefreshToken(token: string): { userId: string; workspaceId: string; role: string } {
  try {
    return jwt.verify(token, env.JWT_SECRET) as { userId: string; workspaceId: string; role: string }
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'Invalid or expired refresh token')
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

export async function comparePassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}
