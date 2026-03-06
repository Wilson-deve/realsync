import { describe, it, expect } from 'vitest'
import { apply } from '../src/apply'
import { DocumentState, DeleteOp } from '../src/type'

const doc = (content: string): DocumentState => ({ content, version: 0 })

describe('apply', () => {
  describe('insert', () => {
    it('inserts at the start', () => {
      expect(apply(doc('world'), { type: 'insert', position: 0, content: 'hello ' }).content).toBe(
        'hello world'
      )
    })
    it('inserts at the end', () => {
      expect(apply(doc('hello'), { type: 'insert', position: 5, content: '!' }).content).toBe(
        'hello!'
      )
    })
    it('inserts in the middle', () => {
      expect(apply(doc('helloworld'), { type: 'insert', position: 5, content: ' ' }).content).toBe(
        'hello world'
      )
    })
    it('clamps position < 0 to 0', () => {
      expect(apply(doc('ab'), { type: 'insert', position: -5, content: 'X' }).content).toBe('Xab')
    })
    it('clamps position > length to end', () => {
      expect(apply(doc('ab'), { type: 'insert', position: 99, content: 'X' }).content).toBe('abX')
    })
  })

  describe('delete', () => {
    it('deletes from the start', () => {
      expect(apply(doc('hello world'), { type: 'delete', position: 0, length: 6 }).content).toBe(
        'world'
      )
    })
    it('deletes from the middle', () => {
      expect(apply(doc('hello world'), { type: 'delete', position: 5, length: 6 }).content).toBe(
        'hello'
      )
    })
    it('clamps length that would exceed document bounds', () => {
      expect(apply(doc('hello'), { type: 'delete', position: 3, length: 100 }).content).toBe('hel')
    })
    it('clamps position < 0 to 0', () => {
      expect(apply(doc('hello'), { type: 'delete', position: -1, length: 2 }).content).toBe('llo')
    })
    it('sets deletedContent on the op', () => {
      const op: DeleteOp = { type: 'delete', position: 6, length: 5 }
      apply(doc('hello world'), op)
      expect(op.deletedContent).toBe('world')
    })
  })

  describe('retain', () => {
    it('does not modify content', () => {
      const d = doc('hello')
      expect(apply(d, { type: 'retain', length: 5 }).content).toBe('hello')
    })
  })

  describe('version', () => {
    it('increments version by 1 for every op type', () => {
      const d = doc('hello')
      expect(apply(d, { type: 'insert', position: 0, content: 'x' }).version).toBe(1)
      expect(apply(d, { type: 'delete', position: 0, length: 1 }).version).toBe(1)
      expect(apply(d, { type: 'retain', length: 1 }).version).toBe(1)
    })
  })
})
