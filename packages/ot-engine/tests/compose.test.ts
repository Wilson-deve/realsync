import { describe, it, expect } from 'vitest'
import { compose } from '../src/compose'
import { apply } from '../src/apply'
import { DocumentState, Op } from '../src/type'

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
})
