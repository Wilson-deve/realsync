import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { compose, apply, insert, del, retain } from '../src/index'
import type { Op, DocumentState } from '../src/index'

// ── Concrete cases ────────────────────────────────────────────────────────────

describe('compose() — insert + insert', () => {
  it('sequential typing merges into one insert', () => {
    // User types 'h', then 'i' → should compose to insert 'hi' at 0
    const op1 = insert(0, 'h')
    const op2 = insert(1, 'i')
    const composed = compose(op1, op2)
    expect(composed).not.toBeNull()
    expect(composed!.type).toBe('insert')
    expect(composed!.position).toBe(0)
    expect(composed!.content).toBe('hi')
  })

  it('compose law holds for adjacent inserts', () => {
    const doc: DocumentState = { content: 'ac', version: 0 }
    const op1 = insert(1, 'b') // 'abc'
    const op2 = insert(2, 'X') // 'abXc'
    const composed = compose(op1, op2)!
    expect(apply(apply(doc, op1), op2).content).toBe(apply(doc, composed).content)
  })

  it('returns null for non-adjacent inserts', () => {
    const op1 = insert(0, 'a')
    const op2 = insert(5, 'b') // gap between them
    expect(compose(op1, op2)).toBeNull()
  })
})

describe('compose() — delete + delete', () => {
  it('forward delete: same position extends length', () => {
    // User selects and deletes 'b', then 'c' at the same cursor position
    const op1 = del(1, 1) // removes 'b' from 'abc'
    const op2 = del(1, 1) // removes 'c' (now at pos 1) from 'ac'
    const composed = compose(op1, op2)
    expect(composed).not.toBeNull()
    expect(composed!.type).toBe('delete')
    expect(composed!.position).toBe(1)
    expect(composed!.length).toBe(2)
  })

  it('compose law holds for forward delete', () => {
    const doc: DocumentState = { content: 'abcde', version: 0 }
    const op1 = del(1, 2) // removes 'bc' → 'ade'
    const op2 = del(1, 1) // removes 'd' → 'ae'
    const composed = compose(op1, op2)!
    expect(apply(apply(doc, op1), op2).content).toBe(apply(doc, composed).content)
  })

  it('backspace: op2 deletes char immediately before op1 region', () => {
    // After deleting 'c' at pos 2, user backspaces 'b' at pos 1
    const op1 = del(2, 1) // removes 'c'
    const op2 = del(1, 1) // removes 'b' (now op2.position + op2.length === op1.position)
    const composed = compose(op1, op2)
    expect(composed).not.toBeNull()
    expect(composed!.type).toBe('delete')
    expect(composed!.position).toBe(1)
    expect(composed!.length).toBe(2)
  })

  it('compose law holds for backspace', () => {
    const doc: DocumentState = { content: 'abcde', version: 0 }
    const op1 = del(3, 1) // removes 'd' → 'abce'
    const op2 = del(2, 1) // removes 'c' (backspace) → 'abe'
    const composed = compose(op1, op2)!
    expect(apply(apply(doc, op1), op2).content).toBe(apply(doc, composed).content)
  })

  it('returns null for non-adjacent deletes', () => {
    const op1 = del(0, 1)
    const op2 = del(5, 1)
    expect(compose(op1, op2)).toBeNull()
  })
})

describe('compose() — mixed types', () => {
  it('returns null for insert + delete', () => {
    expect(compose(insert(0, 'a'), del(0, 1))).toBeNull()
  })

  it('returns null for delete + insert', () => {
    expect(compose(del(0, 1), insert(0, 'a'))).toBeNull()
  })
})

describe('compose() — retain', () => {
  it('retain + insert returns insert (retain is a no-op)', () => {
    const op = insert(3, 'hi')
    const composed = compose(retain(5), op)
    expect(composed).toEqual(op)
  })

  it('insert + retain returns insert', () => {
    const op = insert(3, 'hi')
    const composed = compose(op, retain(5))
    expect(composed).toEqual(op)
  })

  it('retain + delete returns delete', () => {
    const op = del(1, 3)
    const composed = compose(retain(10), op)
    expect(composed).toEqual(op)
  })

  it('retain + retain returns the second retain', () => {
    const composed = compose(retain(3), retain(7))
    expect(composed).toEqual(retain(7))
  })
})

//
// For any doc and any two sequential ops where compose returns non-null:
//   apply(apply(doc, op1), op2) === apply(doc, compose(op1, op2))

describe('fuzz: compose law', () => {
  const alphaStr = fc.stringMatching(/^[a-z]{1,6}$/)

  it('holds for sequential inserts', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{0,12}$/).chain((content) => {
          const len = content.length
          return fc.integer({ min: 0, max: len }).chain((pos1) =>
            alphaStr.chain((c1) =>
              fc.tuple(
                fc.constant({ content, version: 0 } as DocumentState),
                fc.constant({ type: 'insert' as const, position: pos1, content: c1 }),
                alphaStr.map((c2) => ({
                  type: 'insert' as const,
                  position: pos1 + c1.length, // guaranteed adjacent
                  content: c2,
                }))
              )
            )
          )
        }),
        ([doc, op1, op2]) => {
          const composed = compose(op1, op2)
          expect(composed).not.toBeNull()
          expect(apply(apply(doc, op1), op2).content).toBe(apply(doc, composed!).content)
        }
      ),
      { numRuns: 300 }
    )
  })

  it('holds for forward sequential deletes', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{3,12}$/).chain((content) => {
          const len = content.length
          return fc.integer({ min: 0, max: len - 2 }).chain((pos) =>
            fc.integer({ min: 1, max: Math.floor((len - pos) / 2) }).chain((l1) =>
              fc.integer({ min: 1, max: len - pos - l1 }).map((l2) => ({
                doc: { content, version: 0 } as DocumentState,
                op1: { type: 'delete' as const, position: pos, length: l1 },
                op2: { type: 'delete' as const, position: pos, length: l2 },
              }))
            )
          )
        }),
        ({ doc, op1, op2 }) => {
          const composed = compose(op1, op2)
          expect(composed).not.toBeNull()
          expect(apply(apply(doc, op1), op2).content).toBe(apply(doc, composed!).content)
        }
      ),
      { numRuns: 300 }
    )
  })
})
