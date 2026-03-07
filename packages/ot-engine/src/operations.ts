import { InsertOp, DeleteOp, RetainOp } from './type'

/**
 * Creates an insert operation.
 * @throws if `position` is negative.
 */
export function insert(
  position: number,
  content: string,
  attributes?: Record<string, unknown>
): InsertOp {
  if (position < 0) throw new RangeError(`insert position must be >= 0, got ${position}`)
  return attributes
    ? { type: 'insert', position, content, attributes }
    : { type: 'insert', position, content }
}

/**
 * Creates a delete operation.
 * @throws if `position` or `length` is negative.
 */
export function del(position: number, length: number): DeleteOp {
  if (position < 0) throw new RangeError(`delete position must be >= 0, got ${position}`)
  if (length < 0) throw new RangeError(`delete length must be >= 0, got ${length}`)
  return { type: 'delete', position, length }
}

/**
 * Creates a retain operation.
 * @throws if `length` is negative.
 */
export function retain(length: number, attributes?: Record<string, unknown>): RetainOp {
  if (length < 0) throw new RangeError(`retain length must be >= 0, got ${length}`)
  return attributes ? { type: 'retain', length, attributes } : { type: 'retain', length }
}
