import type { DocumentState, Op } from './type'

/**
 * Applies a single operation to a document, returning the new document state.
 *
 * For delete ops, `deletedContent` is set on the op object so that `invert()`
 * can reconstruct the exact inverse insert. Positions are clamped to valid
 * bounds so no operation can throw a range error.
 */
export function apply(doc: DocumentState, op: Op): DocumentState {
  switch (op.type) {
    case 'insert': {
      const pos = Math.min(Math.max(0, op.position), doc.content.length)
      const content = doc.content.slice(0, pos) + op.content + doc.content.slice(pos)
      return { content, version: doc.version + 1 }
    }
    case 'delete': {
      const pos = Math.min(Math.max(0, op.position), doc.content.length)
      const len = Math.max(0, Math.min(op.length, doc.content.length - pos))
      // Annotate the op so invert() can produce the correct inverse insert.
      op.deletedContent = doc.content.slice(pos, pos + len)
      const content = doc.content.slice(0, pos) + doc.content.slice(pos + len)
      return { content, version: doc.version + 1 }
    }
    case 'retain': {
      return { ...doc, version: doc.version + 1 }
    }
  }
}
