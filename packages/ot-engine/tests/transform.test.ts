import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { transform } from '../src/transform'
import { apply } from '../src/apply'
import { DocumentState, Op } from '../src/type'

describe('transform — deterministic cases', () => {
  it('II: op1 before op2 — op2 shifts right', () => {
    const op1: Op = { type: 'insert', position: 0, content: 'AB' }
    const op2: Op = { type: 'insert', position: 3, content: 'X' }
    const [op1p, op2p] = transform(op1, op2)
    expect(op1p).toEqual(op1) // op1 unaffected
    expect((op2p as typeof op2).position).toBe(5) // 3 + 2
  })

  it('II: op2 before op1 — op1 shifts right', () => {
    const op1: Op = { type: 'insert', position: 5, content: 'A' }
    const op2: Op = { type: 'insert', position: 2, content: 'BB' }
    const [op1p, op2p] = transform(op1, op2)
    expect((op1p as typeof op1).position).toBe(7) // 5 + 2
    expect(op2p).toEqual(op2)
  })

  it('II: same position — op1 wins, op2 shifts right', () => {
    const op1: Op = { type: 'insert', position: 3, content: 'A' }
    const op2: Op = { type: 'insert', position: 3, content: 'B' }
    const [op1p, op2p] = transform(op1, op2)
    expect((op1p as typeof op1).position).toBe(3)
    expect((op2p as typeof op2).position).toBe(4) // 3 + 1
  })

  it('ID: insert before delete — delete shifts right', () => {
    const op1: Op = { type: 'insert', position: 0, content: 'XX' }
    const op2: Op = { type: 'delete', position: 3, length: 2 }
    const [op1p, op2p] = transform(op1, op2)
    expect(op1p).toEqual(op1)
    expect((op2p as typeof op2).position).toBe(5) // 3 + 2
  })

  it('ID: insert after delete — insert shifts left', () => {
    const op1: Op = { type: 'insert', position: 10, content: 'X' }
    const op2: Op = { type: 'delete', position: 3, length: 4 }
    const [op1p, op2p] = transform(op1, op2)
    expect((op1p as typeof op1).position).toBe(6) // 10 - 4
    expect(op2p).toEqual(op2)
  })

  it('ID: insert inside delete range — moves to delete start', () => {
    const op1: Op = { type: 'insert', position: 5, content: 'X' }
    const op2: Op = { type: 'delete', position: 3, length: 4 }
    const [op1p, op2p] = transform(op1, op2)
    expect((op1p as typeof op1).position).toBe(3)
    expect(op2p).toEqual(op2)
  })

  it('DI: symmetric of ID', () => {
    const op1: Op = { type: 'delete', position: 3, length: 4 }
    const op2: Op = { type: 'insert', position: 0, content: 'XX' }
    const [op1p, op2p] = transform(op1, op2)
    expect((op1p as typeof op1).position).toBe(5) // 3 + 2
    expect(op2p).toEqual(op2)
  })

  it('DD: non-overlapping — both adjust positions', () => {
    const op1: Op = { type: 'delete', position: 0, length: 2 }
    const op2: Op = { type: 'delete', position: 5, length: 3 }
    const [op1p, op2p] = transform(op1, op2)
    expect(op1p).toEqual(op1)
    expect((op2p as typeof op2).position).toBe(3) // 5 - 2
  })

  it('DD: overlapping — overlap is trimmed from both', () => {
    const op1: Op = { type: 'delete', position: 2, length: 5 } // chars 2-6
    const op2: Op = { type: 'delete', position: 4, length: 3 } // chars 4-6
    const [op1p, op2p] = transform(op1, op2)
    // overlap is chars 4-6 (length 3); op1 shrinks by 3, op2 shrinks by 3
    expect((op1p as typeof op1).length).toBe(2)
    expect((op2p as typeof op2).length).toBe(0)
  })
})

describe('OT convergence property', () => {
  it('holds for concurrent inserts — 10,000 runs', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }),
        fc.nat(50),
        fc.nat(50),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (doc, p1, p2, c1, c2) => {
          const S: DocumentState = { content: doc, version: 0 }
          const op1: Op = { type: 'insert', position: p1 % (doc.length + 1), content: c1 }
          const op2: Op = { type: 'insert', position: p2 % (doc.length + 1), content: c2 }
          const [op1p, op2p] = transform(op1, op2)
          expect(apply(apply(S, op1), op2p).content).toBe(apply(apply(S, op2), op1p).content)
        }
      ),
      { numRuns: 10000 }
    )
  })

  it('holds for concurrent deletes — 5,000 runs', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 2, maxLength: 50 }),
        fc.nat(49),
        fc.nat(49),
        (doc, p1, p2) => {
          if (doc.length < 2) return
          const S: DocumentState = { content: doc, version: 0 }
          const op1: Op = { type: 'delete', position: p1 % doc.length, length: 1 }
          const op2: Op = { type: 'delete', position: p2 % doc.length, length: 1 }
          const [op1p, op2p] = transform(op1, op2)
          expect(apply(apply(S, op1), op2p).content).toBe(apply(apply(S, op2), op1p).content)
        }
      ),
      { numRuns: 5000 }
    )
  })

  it('holds for mixed insert/delete — 5,000 runs', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.nat(50),
        fc.nat(49),
        fc.string({ minLength: 1, maxLength: 5 }),
        (doc, p1, p2, c1) => {
          const S: DocumentState = { content: doc, version: 0 }
          const op1: Op = { type: 'insert', position: p1 % (doc.length + 1), content: c1 }
          const op2: Op = { type: 'delete', position: p2 % doc.length, length: 1 }
          const [op1p, op2p] = transform(op1, op2)
          expect(apply(apply(S, op1), op2p).content).toBe(apply(apply(S, op2), op1p).content)
        }
      ),
      { numRuns: 5000 }
    )
  })
})
