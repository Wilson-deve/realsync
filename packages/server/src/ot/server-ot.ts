import { transform } from '@realsync/ot-engine'
import type { Op } from '@realsync/ot-engine'

/** Transforms a client operation against every server operation applied since the client's local version. */
export function transformAgainstServerOps(clientOp: Op, serverOps: Op[]): Op {
  let transformed = clientOp
  for (const serverOp of serverOps) {
    const [newOp] = transform(transformed, serverOp)
    transformed = newOp
  }
  return transformed
}
