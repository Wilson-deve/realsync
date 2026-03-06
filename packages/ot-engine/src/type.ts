/** All TypeScript types for the OT engine. No logic lives here. */

export type OpType = 'insert' | 'delete' | 'retain'

export interface InsertOp {
  type: 'insert'
  /** 0-based character index where insertion starts. */
  position: number
  /** The text being inserted. */
  content: string
  attributes?: Record<string, unknown>
}

export interface DeleteOp {
  type: 'delete'
  position: number
  length: number
  /**
   * Populated by `apply()` when the op is applied to a document.
   * Required by `invert()` to reconstruct the inverse insert operation.
   */
  deletedContent?: string
}

export interface RetainOp {
  type: 'retain'
  length: number
  attributes?: Record<string, unknown>
}

export type Op = InsertOp | DeleteOp | RetainOp

export interface DocumentState {
  content: string
  /** Increments by 1 on every successfully applied operation. */
  version: number
}
