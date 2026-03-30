import { createDocument, getDocument, softDeleteDocument } from '../db/documents'
import { AppError } from '../utils/errors'
import { logger } from '../utils/logger'

interface UserContext {
  userId: string
  workspaceId: string
  role: string
}

export async function createDoc(workspaceId: string, title: string, user: UserContext) {
  const doc = await createDocument(workspaceId, title, user.userId)
  logger.info({ docId: doc.id, workspaceId, userId: user.userId }, 'Document created via service')
  return doc
}

export async function getDocWithAccess(docId: string, user: UserContext) {
  const doc = await getDocument(docId)
  if (!doc) throw new AppError('NOT_FOUND', 404, 'Document not found')
  if (doc.workspaceId !== user.workspaceId) throw new AppError('FORBIDDEN', 403, 'Access denied to this document')
  return doc
}

export async function deleteDoc(docId: string, user: UserContext): Promise<void> {
  if (user.role !== 'OWNER') throw new AppError('FORBIDDEN', 403, 'Only owners can delete documents')
  const doc = await getDocument(docId)
  if (!doc) return // idempotent
  if (doc.workspaceId !== user.workspaceId) throw new AppError('FORBIDDEN', 403, 'Access denied to this document')
  await softDeleteDocument(docId, user.userId)
  logger.info({ docId, userId: user.userId }, 'Document soft-deleted via service')
}
