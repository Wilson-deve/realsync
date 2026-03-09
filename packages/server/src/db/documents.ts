import { prisma } from './client'

/** Creates a new document inside a workspace. */
export async function createDocument(workspaceId: string, title = 'Untitled') {
  return prisma.document.create({
    data: { workspaceId, title },
  })
}

/** Fetches a single document by its ID. */
export async function getDocument(docId: string) {
  return prisma.document.findUnique({
    where: { id: docId },
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
