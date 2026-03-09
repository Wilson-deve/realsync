import type { Op } from './type'

/** Returns the inverse of an operation to restore previous document state. */
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
      // Spread the original op to preserve attributes.
      return { ...op }
  }
}
