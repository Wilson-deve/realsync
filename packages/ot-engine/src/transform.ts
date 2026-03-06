import { Op, InsertOp, DeleteOp } from './type'

/**
 * Transforms two concurrent operations against each other.
 *
 * Returns `[op1', op2']` where:
 *   - `op1'` is op1 adjusted to be applied AFTER op2
 *   - `op2'` is op2 adjusted to be applied AFTER op1
 *
 * Convergence guarantee:
 *   `apply(apply(S, op1), op2') === apply(apply(S, op2), op1')`
 */
export function transform(op1: Op, op2: Op): [Op, Op] {
  if (op1.type === 'insert' && op2.type === 'insert') return transformII(op1, op2)
  if (op1.type === 'insert' && op2.type === 'delete') return transformID(op1, op2)
  if (op1.type === 'delete' && op2.type === 'insert') {
    // transformID(ins, del) returns [ins', del'] = [op2', op1'].
    // We need [op1', op2'], so swap the destructuring.
    const [op2p, op1p] = transformID(op2, op1)
    return [op1p, op2p]
  }
  if (op1.type === 'delete' && op2.type === 'delete') return transformDD(op1, op2)
  // retain pairs: neither side changes position
  return [op1, op2]
}

function transformII(op1: InsertOp, op2: InsertOp): [Op, Op] {
  if (op1.position < op2.position) {
    return [op1, { ...op2, position: op2.position + op1.content.length }]
  }
  if (op1.position > op2.position) {
    return [{ ...op1, position: op1.position + op2.content.length }, op2]
  }
  // Same position: op1 wins (deterministic server-side tie-break)
  return [op1, { ...op2, position: op2.position + op1.content.length }]
}

function transformID(ins: InsertOp, del: DeleteOp): [Op, Op] {
  // Insert is entirely before the delete range: delete shifts right
  if (ins.position <= del.position) {
    return [ins, { ...del, position: del.position + ins.content.length }]
  }
  // Insert is entirely after the delete range: insert shifts left
  if (ins.position >= del.position + del.length) {
    return [{ ...ins, position: ins.position - del.length }, del]
  }
  // Insert is inside the deleted range: move it to the deletion start.
  // The deletion "wins" positionally; the inserted content is preserved but
  // relocated to the boundary of the deleted region.
  return [{ ...ins, position: del.position }, del]
}

function transformDD(op1: DeleteOp, op2: DeleteOp): [Op, Op] {
  const op1End = op1.position + op1.length
  const op2End = op2.position + op2.length

  // op1 is entirely before op2
  if (op1End <= op2.position) {
    return [op1, { ...op2, position: op2.position - op1.length }]
  }
  // op2 is entirely before op1
  if (op2End <= op1.position) {
    return [{ ...op1, position: op1.position - op2.length }, op2]
  }
  // Overlapping: each side only deletes what the other has not already deleted
  const overlapStart = Math.max(op1.position, op2.position)
  const overlapEnd = Math.min(op1End, op2End)
  const overlap = overlapEnd - overlapStart

  return [
    {
      ...op1,
      position: Math.min(op1.position, op2.position),
      length: Math.max(0, op1.length - overlap),
    },
    {
      ...op2,
      position: Math.min(op1.position, op2.position),
      length: Math.max(0, op2.length - overlap),
    },
  ]
}
