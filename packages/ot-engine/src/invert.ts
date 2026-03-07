import type { Op } from './type'

/**
 * Returns the inverse of an operation such that applying the op and then its
 * inverse leaves the document content unchanged:
 *   `apply(apply(doc, op), invert(op)).content === doc.content`
 *
 * **Important:** for delete ops, `apply()` must be called first so that
 * `op.deletedContent` is populated. Without it, the original text is unknown
 * and the inverse insert cannot be reconstructed.
 */
export function invert(op: Op): Op {
  switch (op.type) {
    case 'insert':
      return { type: 'delete', position: op.position, length: op.content.length }

    case 'delete': {
      if (op.deletedContent === undefined) {
        throw new Error(
          'Cannot invert delete op: deletedContent is missing. ' +
            'Call apply() on the op before calling invert().'
        )
      }
      return { type: 'insert', position: op.position, content: op.deletedContent }
    }

    case 'retain':
      // Spread the original op so attributes are preserved — dropping them
      // would make invert(retain) lose formatting metadata.
      return { ...op }
  }
}
