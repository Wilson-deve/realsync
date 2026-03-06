import { Op } from './type'

/**
 * Reduces a sequence of operations into a minimal equivalent sequence by
 * merging adjacent compatible operations.
 *
 * Applying the composed result is always equivalent to applying each op in
 * the original array in order:
 *   `compose(ops).reduce(apply, doc) === ops.reduce(apply, doc)`
 *
 * Merge rules:
 *   - Two adjacent inserts where the second starts immediately after the first
 *     are merged into a single insert.
 *   - Two adjacent deletes at the same position are merged into a single delete.
 */
export function compose(ops: Op[]): Op[] {
  if (ops.length === 0) return []

  const result: Op[] = [{ ...ops[0] }]

  for (let i = 1; i < ops.length; i++) {
    const last = result[result.length - 1]
    const curr = ops[i]

    // Merge adjacent inserts: second position == first position + first content length
    if (
      last.type === 'insert' &&
      curr.type === 'insert' &&
      curr.position === last.position + last.content.length
    ) {
      result[result.length - 1] = { ...last, content: last.content + curr.content }
      continue
    }

    // Merge adjacent deletes at the same position
    if (last.type === 'delete' && curr.type === 'delete' && curr.position === last.position) {
      result[result.length - 1] = { ...last, length: last.length + curr.length }
      continue
    }

    result.push({ ...curr })
  }

  return result
}
