import type { Op } from './type'

/**
 * Shallow-equality check for op attributes.
 *
 * Compares own keys and values with `===`. This is intentionally shallow:
 * attribute values in this engine are primitives (string | number | boolean),
 * so a strict shallow comparison is both correct and sufficient.
 * If nested attribute objects are ever introduced, this must be upgraded to
 * a recursive deep-equal before that change ships.
 *
 * `undefined` is treated as "no attributes" and equals only `undefined`.
 */
function attrsEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k])
}

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
 *     AND their attributes are deeply equal are merged into a single insert.
 *     Inserts with different attributes are never merged — doing so would
 *     silently misattribute part of the inserted text.
 *   - Two adjacent deletes at the same position are merged into a single delete.
 */
export function compose(ops: Op[]): Op[] {
  if (ops.length === 0) return []

  const result: Op[] = [{ ...ops[0] }]

  for (let i = 1; i < ops.length; i++) {
    const last = result[result.length - 1]
    const curr = ops[i]

    // Merge adjacent inserts only when position is contiguous AND attributes match
    if (
      last.type === 'insert' &&
      curr.type === 'insert' &&
      curr.position === last.position + last.content.length &&
      attrsEqual(last.attributes, curr.attributes)
    ) {
      result[result.length - 1] = { ...last, content: last.content + curr.content }
      continue
    }

    // Merge adjacent deletes at the same position.
    // deletedContent must be handled explicitly: the spread would keep
    // last.deletedContent but the merged length is larger, making it stale.
    // - Both annotated: concatenate so invert() can reconstruct the full text.
    // - Neither annotated: leave undefined (apply() will populate later).
    // - Mixed: drop to undefined — we can't reconstruct the missing half.
    if (last.type === 'delete' && curr.type === 'delete' && curr.position === last.position) {
      const mergedDeletedContent =
        last.deletedContent !== undefined && curr.deletedContent !== undefined
          ? last.deletedContent + curr.deletedContent
          : undefined
      const merged = { ...last, length: last.length + curr.length }
      if (mergedDeletedContent !== undefined) {
        merged.deletedContent = mergedDeletedContent
      } else {
        delete merged.deletedContent
      }
      result[result.length - 1] = merged
      continue
    }

    result.push({ ...curr })
  }

  return result
}
