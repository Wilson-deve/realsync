import { InsertOp, DeleteOp, RetainOp } from './type'

/**
 * Creates an insert operation.
 */
export function insert(
  position: number,
  content: string,
  attributes?: Record<string, unknown>
): InsertOp {
  return attributes
    ? { type: 'insert', position, content, attributes }
    : { type: 'insert', position, content }
}

/**
 * Creates a delete operation.
 */
export function del(position: number, length: number): DeleteOp {
  return { type: 'delete', position, length }
}

/**
 * Creates a retain operation.
 */
export function retain(length: number, attributes?: Record<string, unknown>): RetainOp {
  return attributes ? { type: 'retain', length, attributes } : { type: 'retain', length }
}
