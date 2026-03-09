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
  /** Populated by apply(), required by invert() to reconstruct original text. */
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

/** Maps clientId to last sequence number seen for duplicate detection. */
export type VectorClock = Record<string, number>
