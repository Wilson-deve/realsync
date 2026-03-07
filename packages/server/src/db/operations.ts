import { Prisma } from '@prisma/client'
import type { OpType } from '@prisma/client'
import type { Op } from '@realsync/ot-engine'
import { prisma } from './client'

/**
 * Persists a single OT operation to the append-only operation log.
 * `version` is the document version AFTER this operation is applied.
 */
export async function saveOperation(
  docId: string,
  userId: string,
  op: Op,
  version: number,
) {
  return prisma.operation.create({
    data: {
      docId,
      userId,
      type:       op.type.toUpperCase() as OpType,
      position:   op.type !== 'retain' ? op.position : 0,
      content:    op.type === 'insert' ? op.content : null,
      length:     op.type !== 'insert' ? op.length  : null,
      attributes: op.type !== 'delete'
        ? ((op.attributes as Prisma.InputJsonValue | undefined) ?? Prisma.DbNull)
        : Prisma.DbNull,
      version,
    },
  })
}

/**
 * Returns all operations on `docId` with version > `sinceVersion`,
 * ordered ascending — ready to be replayed in sequence.
 */
export async function getOperationsSince(docId: string, sinceVersion: number): Promise<Op[]> {
  const rows = await prisma.operation.findMany({
    where:   { docId, version: { gt: sinceVersion } },
    orderBy: { version: 'asc' },
  })

  return rows.map((row): Op => {
    if (row.type === 'INSERT') {
      return { type: 'insert', position: row.position, content: row.content ?? '' }
    }
    if (row.type === 'DELETE') {
      return { type: 'delete', position: row.position, length: row.length ?? 0 }
    }
    // RETAIN
    return { type: 'retain', length: row.length ?? 0 }
  })
}
