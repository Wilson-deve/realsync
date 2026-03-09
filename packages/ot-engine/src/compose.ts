import type { Op } from './type'

/** Shallow-equality check for op attributes. */
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

/** Merges a sequence of operations into a minimal equivalent sequence by merging adjacent compatible operations. */
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
