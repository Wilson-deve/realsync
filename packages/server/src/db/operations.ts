import { Prisma } from '@prisma/client'
import type { OpType } from '@prisma/client'
import type { Op } from '@realsync/ot-engine'
import { prisma } from './client'

/** Casts a Prisma JsonValue back to the attributes shape used by Op types, omitting undefined. */
function parseAttributes(raw: Prisma.JsonValue | null): Record<string, unknown> | undefined {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  return undefined
}

/** Persists a single OT operation to the append-only operation log. */
export async function saveOperation(docId: string, userId: string, op: Op, version: number) {
  return prisma.operation.create({
    data: {
      docId,
      userId,
      type: op.type.toUpperCase() as OpType,
      position: op.type !== 'retain' ? op.position : 0,
      content: op.type === 'insert' ? op.content : null,
      length: op.type !== 'insert' ? op.length : null,
      attributes:
        op.type !== 'delete'
          ? ((op.attributes as Prisma.InputJsonValue | undefined) ?? Prisma.DbNull)
          : Prisma.DbNull,
      version,
    },
  })
}

/**
 * Returns the highest version number persisted for a document, or 0 if no
 * operations have been stored yet.  Used to re-seed the Redis version counter
 * after a restart or cache eviction so it never falls behind the DB state.
 */
export async function getMaxOperationVersion(docId: string): Promise<number> {
  const result = await prisma.operation.aggregate({
    where: { docId },
    _max: { version: true },
  })
  return result._max.version ?? 0
}

/** Returns all operations on `docId` with version > `sinceVersion` ordered ascending. */
export async function getOperationsSince(
  docId: string,
  sinceVersion: number,
  upToVersion?: number
): Promise<Op[]> {
  const rows = await prisma.operation.findMany({
    where: {
      docId,
      version: {
        gt: sinceVersion,
        ...(upToVersion !== undefined ? { lte: upToVersion } : {}),
      },
    },
    orderBy: [{ version: 'asc' }, { id: 'asc' }],
  })

  return rows.map((row): Op => {
    if (row.type === 'INSERT') {
      if (row.content === null) {
        throw new Error(`Invariant violation: INSERT operation ${row.id} has null content`)
      }
      const op: Op = { type: 'insert', position: row.position, content: row.content }
      const attrs = parseAttributes(row.attributes)
      if (attrs !== undefined) op.attributes = attrs
      return op
    }
    if (row.type === 'DELETE') {
      if (row.length === null) {
        throw new Error(`Invariant violation: DELETE operation ${row.id} has null length`)
      }
      return { type: 'delete', position: row.position, length: row.length }
    }
    // RETAIN
    if (row.length === null) {
      throw new Error(`Invariant violation: RETAIN operation ${row.id} has null length`)
    }
    const op: Op = { type: 'retain', length: row.length }
    const attrs = parseAttributes(row.attributes)
    if (attrs !== undefined) op.attributes = attrs
    return op
  })
}
