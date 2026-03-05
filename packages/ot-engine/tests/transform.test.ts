import { describe, it, expect } from 'vitest'
import { transform, apply } from '../src/index'
import type { Op, DocumentState } from '../src/index'

// Helper: apply two concurrent ops via transform and verify convergence
function converges(doc: DocumentState, op1: Op, op2: Op) {
  const [op1p, op2p] = transform(op1, op2)
  const left = apply(apply(doc, op1), op2p)
  const right = apply(apply(doc, op2), op1p)
  expect(left.content).toBe(right.content)
  return left.content
}

describe('transform() — insert vs insert', () => {
  it('two inserts at different positions converge', () => {
    const doc = { content: 'hello world', version: 0 }
    // op1: insert ' dear' at 5  →  'hello dear world'
    // op2: insert '!' at 11     →  'hello world!'
    const op1: Op = { type: 'insert', position: 5, content: ' dear' }
    const op2: Op = { type: 'insert', position: 11, content: '!' }
    const result = converges(doc, op1, op2)
    expect(result).toBe('hello dear world!')
  })

  it('two inserts at the same position — op1 wins tie-break', () => {
    const doc = { content: 'ab', version: 0 }
    const op1: Op = { type: 'insert', position: 1, content: 'X' }
    const op2: Op = { type: 'insert', position: 1, content: 'Y' }
    // Both clients must end up with the same string
    converges(doc, op1, op2)
  })

  it('insert before another insert shifts it right', () => {
    const doc = { content: 'ac', version: 0 }
    const op1: Op = { type: 'insert', position: 0, content: 'b' } // 'bac'
    const op2: Op = { type: 'insert', position: 1, content: 'd' } // 'adc'
    converges(doc, op1, op2)
  })
})

describe('transform() — delete vs delete', () => {
  it('two non-overlapping deletes converge', () => {
    const doc = { content: 'hello world', version: 0 }
    const op1: Op = { type: 'delete', position: 0, length: 5 } // removes 'hello'
    const op2: Op = { type: 'delete', position: 6, length: 5 } // removes 'world'
    const result = converges(doc, op1, op2)
    expect(result).toBe(' ')
  })

  it('overlapping deletes — shared region deleted once', () => {
    const doc = { content: 'abcde', version: 0 }
    const op1: Op = { type: 'delete', position: 1, length: 3 } // removes 'bcd'
    const op2: Op = { type: 'delete', position: 2, length: 2 } // removes 'cd'
    const result = converges(doc, op1, op2)
    expect(result).toBe('ae')
  })

  it('one delete completely covers the other', () => {
    const doc = { content: 'abcde', version: 0 }
    const op1: Op = { type: 'delete', position: 0, length: 5 } // removes everything
    const op2: Op = { type: 'delete', position: 1, length: 2 } // removes 'bc'
    const result = converges(doc, op1, op2)
    expect(result).toBe('')
  })

  it('identical deletes are idempotent', () => {
    const doc = { content: 'hello', version: 0 }
    const op1: Op = { type: 'delete', position: 0, length: 5 }
    const op2: Op = { type: 'delete', position: 0, length: 5 }
    const result = converges(doc, op1, op2)
    expect(result).toBe('')
  })
})

describe('transform() — insert vs delete', () => {
  it('insert before the deleted range — unaffected', () => {
    const doc = { content: 'hello world', version: 0 }
    const op1: Op = { type: 'insert', position: 0, content: 'say: ' }
    const op2: Op = { type: 'delete', position: 6, length: 5 } // removes 'world'
    const result = converges(doc, op1, op2)
    expect(result).toBe('say: hello ')
  })

  it('insert after the deleted range — shifts left', () => {
    const doc = { content: 'hello world', version: 0 }
    const op1: Op = { type: 'insert', position: 11, content: '!' }
    const op2: Op = { type: 'delete', position: 5, length: 6 } // removes ' world'
    const result = converges(doc, op1, op2)
    expect(result).toBe('hello!')
  })

  it('insert inside the deleted range — clamps to deletion start', () => {
    const doc = { content: 'hello world', version: 0 }
    const op1: Op = { type: 'insert', position: 7, content: 'X' } // inside 'world'
    const op2: Op = { type: 'delete', position: 6, length: 5 } // removes 'world'
    converges(doc, op1, op2)
  })

  it('delete vs insert — delete expands to cover inserted text', () => {
    const doc = { content: 'abcde', version: 0 }
    const op1: Op = { type: 'delete', position: 1, length: 3 } // deletes 'bcd'
    const op2: Op = { type: 'insert', position: 2, content: 'XX' } // inserts inside range
    converges(doc, op1, op2)
  })
})
