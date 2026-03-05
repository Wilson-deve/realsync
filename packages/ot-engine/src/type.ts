export type OpType = 'insert' | 'delete' | 'retain'

export interface Op {
  type: OpType
  position: number
  content?: string // insert
  length?: number // delete or retain
}

export interface DocumentState {
  content: string
  version: number
}

// Maps clientId → last sequence number seen from that client.
// Used by the server to detect out-of-order or duplicate op submissions.
export type VectorClock = Record<string, number>
