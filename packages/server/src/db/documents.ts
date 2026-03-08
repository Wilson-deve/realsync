import { prisma } from './client'

/**
 * Create a new document inside a workspace.
 * Returns the full Prisma Document record.
 */
export async function createDocument(workspaceId: string, title = 'Untitled') {
  return prisma.document.create({
    data: { workspaceId, title },
  })
}

/**
 * Fetch a single document by its ID.
 * Returns `null` if no document with that ID exists.
 */
export async function getDocument(docId: string) {
  return prisma.document.findUnique({
    where: { id: docId },
  })
}

/**
 * Update the denormalised snapshot fields on a document.
 * Called by the OT handler after each successfully applied operation
 * to keep an up-to-date content cache without replaying all operations.
 */
export async function updateSnapshot(docId: string, content: string, version: number) {
  return prisma.document.update({
    where: { id: docId },
    data: { snapshotContent: content, snapshotVersion: version },
  })
}
