import { prisma } from './client'

/** Creates a new document inside a workspace and writes an AuditLog entry. */
export async function createDocument(workspaceId: string, title = 'Untitled', createdBy?: string) {
  return prisma.$transaction(async (tx) => {
    const doc = await tx.document.create({
      data: { workspaceId, title },
    })
    if (createdBy) {
      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: createdBy,
          action: 'document.create',
          resource: doc.id,
        },
      })
    }
    return doc
  })
}

/** Fetches a single document by its ID. Returns null if not found or soft-deleted. */
export async function getDocument(docId: string) {
  return prisma.document.findFirst({
    where: { id: docId, deletedAt: null },
  })
}

/** Updates the denormalised snapshot fields directly on a document. */
export async function updateSnapshot(
  docId: string,
  content: string,
  version: number
): Promise<number> {
  const result = await prisma.document.updateMany({
    where: { id: docId, snapshotVersion: { lt: version } },
    data: { snapshotContent: content, snapshotVersion: version },
  })
  return result.count
}

/** Soft-deletes a document by setting deletedAt and writing an AuditLog entry. */
export async function softDeleteDocument(docId: string, actorId: string): Promise<void> {
  const doc = await prisma.document.findUnique({ where: { id: docId } })
  if (!doc) return

  await prisma.$transaction([
    prisma.document.update({
      where: { id: docId },
      data: { deletedAt: new Date() },
    }),
    prisma.auditLog.create({
      data: {
        workspaceId: doc.workspaceId,
        actorId,
        action: 'document.delete',
        resource: docId,
      },
    }),
  ])
}
