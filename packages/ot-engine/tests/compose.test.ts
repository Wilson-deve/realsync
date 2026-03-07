import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { compose } from '../src/compose'
import { apply } from '../src/apply'
import { invert } from '../src/invert'
import { DocumentState, Op, DeleteOp } from '../src/type'

const doc = (content: string): DocumentState => ({ content, version: 0 })

/** Apply a list of ops sequentially to a document. */
function applyAll(d: DocumentState, ops: Op[]): DocumentState {
  return ops.reduce(apply, d)
}

describe('compose', () => {
  it('returns empty array for empty input', () => {
    expect(compose([])).toEqual([])
  })

  it('returns single-element array unchanged', () => {
    const op: Op = { type: 'insert', position: 0, content: 'hello' }
    expect(compose([op])).toEqual([op])
  })

  it('merges two adjacent inserts into one', () => {
    const ops: Op[] = [
      { type: 'insert', position: 0, content: 'AB' },
      { type: 'insert', position: 2, content: 'C' },
    ]
    const result = compose(ops)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'insert', position: 0, content: 'ABC' })
  })

  it('does NOT merge non-adjacent inserts', () => {
    const ops: Op[] = [
      { type: 'insert', position: 0, content: 'AB' },
      { type: 'insert', position: 5, content: 'C' }, // gap at positions 2-4
    ]
    expect(compose(ops)).toHaveLength(2)
  })

  it('merges two adjacent deletes at the same position', () => {
    const ops: Op[] = [
      { type: 'delete', position: 2, length: 1 },
      { type: 'delete', position: 2, length: 2 },
    ]
    const result = compose(ops)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'delete', position: 2, length: 3 })
  })

  describe('delete merge — deletedContent handling', () => {
    it('concatenates deletedContent when both ops are annotated', () => {
      const ops: Op[] = [
        { type: 'delete', position: 2, length: 2, deletedContent: 'll' },
        { type: 'delete', position: 2, length: 3, deletedContent: 'o w' },
      ]
      const result = compose(ops)
      expect(result).toHaveLength(1)
      expect((result[0] as DeleteOp).deletedContent).toBe('llo w')
      expect((result[0] as DeleteOp).length).toBe(5)
    })

    it('leaves deletedContent undefined when neither op is annotated', () => {
      const ops: Op[] = [
        { type: 'delete', position: 2, length: 2 },
        { type: 'delete', position: 2, length: 3 },
      ]
      const result = compose(ops)
      expect(result).toHaveLength(1)
      expect((result[0] as DeleteOp).deletedContent).toBeUndefined()
    })

    it('drops deletedContent when only one op is annotated (mixed state)', () => {
      const ops: Op[] = [
        { type: 'delete', position: 2, length: 2, deletedContent: 'll' },
        { type: 'delete', position: 2, length: 3 },
      ]
      const result = compose(ops)
      expect(result).toHaveLength(1)
      expect((result[0] as DeleteOp).deletedContent).toBeUndefined()
    })

    it('round-trips correctly through invert() when both ops were applied', () => {
      const d = doc('hello world')
      const op1: DeleteOp = { type: 'delete', position: 2, length: 2 }
      const op2: DeleteOp = { type: 'delete', position: 2, length: 3 }
      // Apply each individually to populate deletedContent
      apply(d, op1) // op1.deletedContent = 'll'
      apply({ content: 'heo world', version: 1 }, op2) // op2.deletedContent = 'o w'
      const composed = compose([op1, op2])
      expect(composed).toHaveLength(1)
      const inv = invert(composed[0])
      expect(inv).toMatchObject({ type: 'insert', position: 2, content: 'llo w' })
    })
  })

  it('composed result produces same document as applying each op individually', () => {
    const d = doc('hello world')
    const ops: Op[] = [
      { type: 'insert', position: 0, content: 'Say: ' },
      { type: 'insert', position: 5, content: '' }, // empty insert — no-op
      { type: 'delete', position: 11, length: 1 }, // delete 'd'
    ]
    // applyAll ignores version, compare content only
    expect(applyAll(d, compose(ops)).content).toBe(applyAll(d, ops).content)
  })

  it('composed result of three adjacent inserts produces same document', () => {
    const d = doc('world')
    const ops: Op[] = [
      { type: 'insert', position: 0, content: 'A' },
      { type: 'insert', position: 1, content: 'B' },
      { type: 'insert', position: 2, content: 'C' },
    ]
    const composed = compose(ops)
    expect(composed).toHaveLength(1)
    expect(applyAll(d, composed).content).toBe(applyAll(d, ops).content)
  })

  it('does not merge insert followed by delete', () => {
    const ops: Op[] = [
      { type: 'insert', position: 0, content: 'AB' },
      { type: 'delete', position: 2, length: 1 },
    ]
    expect(compose(ops)).toHaveLength(2)
  })

  describe('attribute compatibility', () => {
    it('merges adjacent inserts with identical attributes', () => {
      const ops: Op[] = [
        { type: 'insert', position: 0, content: 'A', attributes: { bold: true } },
        { type: 'insert', position: 1, content: 'B', attributes: { bold: true } },
      ]
      const result = compose(ops)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ content: 'AB', attributes: { bold: true } })
    })

    it('does NOT merge adjacent inserts with different attributes', () => {
      const ops: Op[] = [
        { type: 'insert', position: 0, content: 'A', attributes: { bold: true } },
        { type: 'insert', position: 1, content: 'B', attributes: { italic: true } },
      ]
      expect(compose(ops)).toHaveLength(2)
    })

    it('does NOT merge when one insert has attributes and the other does not', () => {
      const ops: Op[] = [
        { type: 'insert', position: 0, content: 'A', attributes: { bold: true } },
        { type: 'insert', position: 1, content: 'B' },
      ]
      expect(compose(ops)).toHaveLength(2)
    })

    it('merges adjacent inserts both without attributes', () => {
      const ops: Op[] = [
        { type: 'insert', position: 0, content: 'A' },
        { type: 'insert', position: 1, content: 'B' },
      ]
      expect(compose(ops)).toHaveLength(1)
    })
  })

  it('compose is semantically equivalent to sequential apply — 2,000 runs', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.array(
          fc.oneof(
            fc.record({
              type: fc.constant('insert' as const),
              position: fc.nat(30),
              content: fc.string({ minLength: 1, maxLength: 5 }),
            }),
            fc.record({
              type: fc.constant('delete' as const),
              position: fc.nat(29),
              length: fc.integer({ min: 1, max: 10 }),
            }),
          ),
          { minLength: 1, maxLength: 6 },
        ),
        (docContent, rawOps) => {
          // Build valid ops by tracking the running document length
          const ops: Op[] = []
          let content = docContent
          for (const raw of rawOps) {
            if (raw.type === 'insert') {
              const pos = raw.position % (content.length + 1)
              ops.push({ type: 'insert', position: pos, content: raw.content })
              content = content.slice(0, pos) + raw.content + content.slice(pos)
            } else {
              if (content.length === 0) continue
              const pos = raw.position % content.length
              const len = Math.min(raw.length, content.length - pos)
              if (len === 0) continue
              ops.push({ type: 'delete', position: pos, length: len })
              content = content.slice(0, pos) + content.slice(pos + len)
            }
          }
          if (ops.length === 0) return
          const d: DocumentState = { content: docContent, version: 0 }
          expect(applyAll(d, compose(ops)).content).toBe(applyAll(d, ops).content)
        },
      ),
      { numRuns: 2000 },
    )
  })
})
