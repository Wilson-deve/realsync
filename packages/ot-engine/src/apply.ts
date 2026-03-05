import type { Op, DocumentState } from './type'

export function apply(doc: DocumentState, op: Op): DocumentState {
  if (op.type === 'insert') {
    // Empty string is the no-op sentinel produced by transform() when an insert
    // lands inside a concurrently deleted range — the surrounding chars are gone.
    if (op.content === undefined || op.content === '') return doc
    const content = doc.content.slice(0, op.position) + op.content + doc.content.slice(op.position)
    return { content, version: doc.version + 1 }
  }

  if (op.type === 'delete') {
    // Zero-length delete is a no-op (both clients deleted the same range).
    if (op.length === undefined || op.length === 0) return doc
    const content = doc.content.slice(0, op.position) + doc.content.slice(op.position + op.length)
    return { content, version: doc.version + 1 }
  }

  // retain — intentional no-op placeholder
  return doc
}
