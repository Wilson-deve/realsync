import { describe, it } from 'vitest'
import { expect } from 'vitest'
import * as fc from 'fast-check'
import { transform, apply } from '../src/index'
import type { Op, DocumentState } from '../src/index'

// ── Arbitraries ──────────────────────────────────────────────────────────────

const alphaString = fc.stringMatching(/^[a-z]{0,8}$/)

const docArb: fc.Arbitrary<DocumentState> = alphaString.map((content) => ({
  content,
  version: 0,
}))

function insertOpArb(docLen: number): fc.Arbitrary<Op> {
  if (docLen < 0) docLen = 0
  return fc.record({
    type: fc.constant('insert' as const),
    position: fc.integer({ min: 0, max: docLen }),
    content: alphaString.filter((s) => s.length > 0),
  })
}

function deleteOpArb(docLen: number): fc.Arbitrary<Op> {
  if (docLen === 0) {
    // Nothing to delete — return a no-op delete
    return fc.constant({ type: 'delete' as const, position: 0, length: 0 })
  }
  return fc.integer({ min: 0, max: docLen - 1 }).chain((position) =>
    fc.record({
      type: fc.constant('delete' as const),
      position: fc.constant(position),
      length: fc.integer({ min: 1, max: docLen - position }),
    })
  )
}

function opArb(docLen: number): fc.Arbitrary<Op> {
  return fc.oneof(insertOpArb(docLen), deleteOpArb(docLen))
}

// ── Diamond property ─────────────────────────────────────────────────────────
//
// For any document and any two concurrent operations:
//   apply(apply(doc, op1), op2') === apply(apply(doc, op2), op1')

function diamondHolds(doc: DocumentState, op1: Op, op2: Op): void {
  const [op1p, op2p] = transform(op1, op2)
  const left = apply(apply(doc, op1), op2p)
  const right = apply(apply(doc, op2), op1p)
  expect(left.content).toBe(right.content)
}

describe('fuzz: transform diamond property', () => {
  it('holds for insert vs insert', () => {
    fc.assert(
      fc.property(
        docArb.chain((doc) =>
          fc.tuple(
            fc.constant(doc),
            insertOpArb(doc.content.length),
            insertOpArb(doc.content.length)
          )
        ),
        ([doc, op1, op2]) => diamondHolds(doc, op1, op2)
      ),
      { numRuns: 200 }
    )
  })

  it('holds for delete vs delete', () => {
    fc.assert(
      fc.property(
        docArb
          .filter((d) => d.content.length > 0)
          .chain((doc) =>
            fc.tuple(
              fc.constant(doc),
              deleteOpArb(doc.content.length),
              deleteOpArb(doc.content.length)
            )
          ),
        ([doc, op1, op2]) => diamondHolds(doc, op1, op2)
      ),
      { numRuns: 200 }
    )
  })

  it('holds for insert vs delete', () => {
    fc.assert(
      fc.property(
        docArb
          .filter((d) => d.content.length > 0)
          .chain((doc) =>
            fc.tuple(
              fc.constant(doc),
              insertOpArb(doc.content.length),
              deleteOpArb(doc.content.length)
            )
          ),
        ([doc, op1, op2]) => diamondHolds(doc, op1, op2)
      ),
      { numRuns: 200 }
    )
  })

  it('holds for any two concurrent ops', () => {
    fc.assert(
      fc.property(
        docArb.chain((doc) =>
          fc.tuple(fc.constant(doc), opArb(doc.content.length), opArb(doc.content.length))
        ),
        ([doc, op1, op2]) => diamondHolds(doc, op1, op2)
      ),
      { numRuns: 500 }
    )
  })
})
