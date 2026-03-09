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
 * Conditionally advance the denormalised snapshot fields on a document.
 *
 * Uses `updateMany` with a `snapshotVersion < version` guard so the write is
 * monotonic: a slower earlier snapshot job that finishes out of order will
 * match zero rows and silently no-op instead of overwriting a newer snapshot.
 * This prevents snapshotVersion/content regressions when concurrent
 * setImmediate snapshot jobs complete in arbitrary order.
 *
 * Returns the number of rows updated (0 or 1).
 */
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
