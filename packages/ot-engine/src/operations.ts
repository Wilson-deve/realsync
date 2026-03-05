import type { Op } from './type'

/** Create a validated insert operation. */
export function insert(position: number, content: string): Op {
  if (position < 0) throw new RangeError(`insert: position must be >= 0, got ${position}`)
  if (content.length === 0) throw new RangeError('insert: content must be non-empty')
  return { type: 'insert', position, content }
}

/** Create a validated delete operation. ('delete' is a reserved word — use del) */
export function del(position: number, length: number): Op {
  if (position < 0) throw new RangeError(`del: position must be >= 0, got ${position}`)
  if (length <= 0) throw new RangeError(`del: length must be > 0, got ${length}`)
  return { type: 'delete', position, length }
}

/** Create a retain operation (skip-N-chars placeholder). */
export function retain(length: number): Op {
  if (length <= 0) throw new RangeError(`retain: length must be > 0, got ${length}`)
  return { type: 'retain', position: 0, length }
}
