import type { Op } from './type'

export type { OpType, Op, DocumentState } from './type'

/**
 * Operational Transformation.
 *
 * Given two operations (op1, op2) that were both applied against the
 * same document version (concurrent), returns [op1', op2'] such that:
 *
 *   apply(apply(doc, op1), op2') === apply(apply(doc, op2), op1')
 *
 * op1' = op1 transformed against op2  → apply after op2
 * op2' = op2 transformed against op1  → apply after op1
 */
export function transform(op1: Op, op2: Op): [Op, Op] {
  if (op1.type === 'insert' && op2.type === 'insert') {
    return transformII(op1, op2)
  }
  if (op1.type === 'insert' && op2.type === 'delete') {
    return transformID(op1, op2)
  }
  if (op1.type === 'delete' && op2.type === 'insert') {
    // Symmetric: swap args, swap result
    const [op2p, op1p] = transformID(op2, op1)
    return [op1p, op2p]
  }
  if (op1.type === 'delete' && op2.type === 'delete') {
    return transformDD(op1, op2)
  }
  // retain is a no-op
  return [op1, op2]
}

// ─── insert vs insert ────────────────────────────────────────────────────────
//
// Tie-break rule: when both insert at the same position, op1 keeps its
// position (op1 has priority) and op2 shifts right. This must be applied
// consistently on every client to converge.

function transformII(op1: Op, op2: Op): [Op, Op] {
  const p1 = op1.position
  const p2 = op2.position
  const l1 = op1.content?.length ?? 0
  const l2 = op2.content?.length ?? 0

  // op1' against op2: if op2 inserted strictly before p1, shift right
  const op1p: Op = p2 < p1 ? { ...op1, position: p1 + l2 } : { ...op1 }

  // op2' against op1: if op1 inserted at or before p2, shift right
  // (handles the tie-break: p1 === p2 → op2 shifts)
  const op2p: Op = p1 <= p2 ? { ...op2, position: p2 + l1 } : { ...op2 }

  return [op1p, op2p]
}

// ─── insert vs delete ────────────────────────────────────────────────────────

function transformID(opIns: Op, opDel: Op): [Op, Op] {
  const pi = opIns.position
  const pd = opDel.position
  const ld = opDel.length ?? 0
  const li = opIns.content?.length ?? 0

  // opIns' against opDel:
  //   Before delete range  → unchanged
  //   Inside delete range  → the chars around the insert are gone; preserve the
  //                          insert at pd BUT clear content so apply() skips it.
  //                          This keeps op2' simple (a single expanded delete)
  //                          while both paths still converge.
  //   After  delete range  → shift left by ld
  let opInsp: Op
  if (pi <= pd) {
    opInsp = { ...opIns }
  } else if (pi < pd + ld) {
    opInsp = { ...opIns, position: pd, content: '' } // no-op: content cleared
  } else {
    opInsp = { ...opIns, position: pi - ld }
  }

  // opDel' against opIns:
  //   Insert at or before delete start → shift delete right by li
  //   Insert inside delete range       → expand delete to swallow new content
  //   Insert after delete range        → unchanged
  let opDelp: Op
  if (pi <= pd) {
    opDelp = { ...opDel, position: pd + li }
  } else if (pi < pd + ld) {
    opDelp = { ...opDel, length: ld + li }
  } else {
    opDelp = { ...opDel }
  }

  return [opInsp, opDelp]
}

// ─── delete vs delete ────────────────────────────────────────────────────────

function transformDD(op1: Op, op2: Op): [Op, Op] {
  return [xformDel(op1, op2), xformDel(op2, op1)]
}

// Transform opA (delete) assuming opB (delete) was applied first.
function xformDel(opA: Op, opB: Op): Op {
  const pa = opA.position
  const pb = opB.position
  const la = opA.length ?? 0
  const lb = opB.length ?? 0

  // opB entirely before opA → shift opA left by lb
  if (pb + lb <= pa) {
    return { ...opA, position: pa - lb }
  }

  // opB entirely after opA → no change
  if (pb >= pa + la) {
    return { ...opA }
  }

  // opB completely covers opA → opA is already gone, become no-op
  if (pb <= pa && pb + lb >= pa + la) {
    return { ...opA, position: pb, length: 0 }
  }

  // opA completely covers opB → shrink opA by lb (overlap already deleted)
  if (pa <= pb && pa + la >= pb + lb) {
    return { ...opA, length: la - lb }
  }

  // Partial overlap: opA starts before opB, ends inside opB
  // [pa ──── pb ── pa+la ────── pb+lb]
  if (pa <= pb) {
    return { ...opA, length: pb - pa }
  }

  // Partial overlap: opA starts inside opB, ends after opB
  // [pb ──── pa ── pb+lb ────── pa+la]
  return { ...opA, position: pb, length: pa + la - (pb + lb) }
}
