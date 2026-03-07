import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { apply } from '../src/apply'
import { invert } from '../src/invert'
import { DocumentState, DeleteOp, Op } from '../src/type'

const doc = (content: string): DocumentState => ({ content, version: 0 })

describe('invert', () => {
  describe('insert → delete (round-trip)', () => {
    it('inverts a start insert', () => {
      const d = doc('world')
      const op: Op = { type: 'insert', position: 0, content: 'hello ' }
      expect(apply(apply(d, op), invert(op)).content).toBe(d.content)
    })

    it('inverts an end insert', () => {
      const d = doc('hello')
      const op: Op = { type: 'insert', position: 5, content: '!' }
      expect(apply(apply(d, op), invert(op)).content).toBe(d.content)
    })

    it('inverts a middle insert', () => {
      const d = doc('helloworld')
      const op: Op = { type: 'insert', position: 5, content: ' ' }
      expect(apply(apply(d, op), invert(op)).content).toBe(d.content)
    })

    it('invert(insert) produces a delete with correct position and length', () => {
      const op: Op = { type: 'insert', position: 3, content: 'ABC' }
      const inv = invert(op)
      expect(inv).toEqual({ type: 'delete', position: 3, length: 3 })
    })
  })

  describe('delete → insert (round-trip)', () => {
    it('round-trips after apply populates deletedContent', () => {
      const d = doc('hello world')
      const op: DeleteOp = { type: 'delete', position: 5, length: 6 }
      apply(d, op) // populates op.deletedContent = ' world'
      expect(apply(apply(d, op), invert(op)).content).toBe(d.content)
    })

    it('invert(delete) produces an insert restoring the exact deleted text', () => {
      const d = doc('hello world')
      const op: DeleteOp = { type: 'delete', position: 6, length: 5 }
      apply(d, op)
      const inv = invert(op)
      expect(inv).toEqual({ type: 'insert', position: 6, content: 'world' })
    })

    it('throws if deletedContent is missing (apply not called first)', () => {
      const op: DeleteOp = { type: 'delete', position: 0, length: 3 }
      expect(() => invert(op)).toThrow('deletedContent is missing')
    })
  })

  describe('retain → retain (round-trip)', () => {
    it('invert(retain) returns an identical retain', () => {
      const op: Op = { type: 'retain', length: 10 }
      expect(invert(op)).toEqual({ type: 'retain', length: 10 })
    })

    it('preserves attributes on retain', () => {
      const op: Op = { type: 'retain', length: 5, attributes: { bold: true, color: 'red' } }
      expect(invert(op)).toEqual({ type: 'retain', length: 5, attributes: { bold: true, color: 'red' } })
    })

    it('does not add attributes when original has none', () => {
      const op: Op = { type: 'retain', length: 5 }
      const inv = invert(op)
      expect(inv).toEqual({ type: 'retain', length: 5 })
      expect('attributes' in inv).toBe(false)
    })

    it('round-trips retain (content unchanged)', () => {
      const d = doc('hello')
      const op: Op = { type: 'retain', length: 5 }
      expect(apply(apply(d, op), invert(op)).content).toBe(d.content)
    })
  })

  describe('round-trip property — 5,000 runs', () => {
    it('insert round-trip holds for any doc and position', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 50 }),
          fc.nat(50),
          fc.string({ minLength: 1, maxLength: 10 }),
          (content, p, text) => {
            const d: DocumentState = { content, version: 0 }
            const op: Op = { type: 'insert', position: p % (content.length + 1), content: text }
            expect(apply(apply(d, op), invert(op)).content).toBe(content)
          }
        ),
        { numRuns: 5000 }
      )
    })

    it('delete round-trip holds for any doc and position', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.nat(49),
          fc.integer({ min: 1, max: 10 }),
          (content, p, len) => {
            const d: DocumentState = { content, version: 0 }
            const op: DeleteOp = {
              type: 'delete',
              position: p % content.length,
              length: Math.min(len, content.length - (p % content.length)),
            }
            apply(d, op) // populate deletedContent
            expect(apply(apply(d, op), invert(op)).content).toBe(content)
          }
        ),
        { numRuns: 5000 }
      )
    })
  })
})
