import { transform } from '@realsync/ot-engine'
import type { Op } from '@realsync/ot-engine'

/**
 * Transform a client operation against every server operation that was
 * applied since the client's local version snapshot.
 *
 * This is the core OT convergence step: after transformation, `clientOp`
 * can be safely applied on top of the current server document state and
 * produce the same result as if it had been applied concurrently.
 *
 * @param clientOp  The operation submitted by the client.
 * @param serverOps Operations persisted since the client's version, in
 *                  ascending version order.
 * @returns The transformed operation, ready to be persisted.
 */
export function transformAgainstServerOps(clientOp: Op, serverOps: Op[]): Op {
  let transformed = clientOp
  for (const serverOp of serverOps) {
    const [newOp] = transform(transformed, serverOp)
    transformed = newOp
  }
  return transformed
}
