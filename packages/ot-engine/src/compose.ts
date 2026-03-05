import type { Op } from './type'

/**
 * Compose two *sequential* ops (op2 applied immediately after op1 on the same
 * client) into a single equivalent op.
 *
 * Returns null when the pair cannot be represented as one Op — callers should
 * apply both ops individually in that case.
 *
 * Law: apply(apply(doc, op1), op2) === apply(doc, compose(op1, op2))
 */
export function compose(op1: Op, op2: Op): Op | null {
  // ── insert + insert ──────────────────────────────────────────────────────
  if (op1.type === 'insert' && op2.type === 'insert') {
    const c1 = op1.content ?? ''
    const c2 = op2.content ?? ''
    // Sequential typing: op2 continues right after op1's inserted text
    if (op2.position === op1.position + c1.length) {
      return { type: 'insert', position: op1.position, content: c1 + c2 }
    }
    return null
  }

  // ── delete + delete ──────────────────────────────────────────────────────
  if (op1.type === 'delete' && op2.type === 'delete') {
    const l1 = op1.length ?? 0
    const l2 = op2.length ?? 0
    // Forward delete: op2 keeps removing from the same start position
    // (op1 already removed l1 chars, so position stays the same)
    if (op2.position === op1.position) {
      return { type: 'delete', position: op1.position, length: l1 + l2 }
    }
    // Backspace: op2 deletes the char immediately before op1's region
    // In the post-op1 doc, op2.position + l2 === op1.position means the
    // deleted region is [op2.position, op2.position + l2 + l1) in the original.
    if (op2.position + l2 === op1.position) {
      return { type: 'delete', position: op2.position, length: l2 + l1 }
    }
    return null
  }

  // ── retain + anything / anything + retain ─────────────────────────────────
  // retain is a no-op, so composing it with any op just yields that op.
  if (op1.type === 'retain') return op2
  if (op2.type === 'retain') return op1

  return null
}
