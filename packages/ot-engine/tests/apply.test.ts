import { describe, it, expect } from 'vitest'
import { apply } from '../src/index'

describe('apply() — insert', () => {
  it('inserts text in the middle', () => {
    const doc = { content: 'hello world', version: 0 }
    const result = apply(doc, { type: 'insert', position: 5, content: ' beautiful' })
    expect(result.content).toBe('hello beautiful world')
    expect(result.version).toBe(1)
  })

  it('inserts at position 0 (beginning)', () => {
    const doc = { content: 'world', version: 0 }
    const result = apply(doc, { type: 'insert', position: 0, content: 'hello ' })
    expect(result.content).toBe('hello world')
    expect(result.version).toBe(1)
  })

  it('inserts at end of document', () => {
    const doc = { content: 'hello', version: 0 }
    const result = apply(doc, { type: 'insert', position: 5, content: ' world' })
    expect(result.content).toBe('hello world')
    expect(result.version).toBe(1)
  })

  it('empty content is a no-op (transform sentinel)', () => {
    const doc = { content: 'hello', version: 0 }
    const result = apply(doc, { type: 'insert', position: 2, content: '' })
    expect(result.content).toBe('hello')
    expect(result.version).toBe(0) // version must NOT bump
  })

  it('undefined content is a no-op', () => {
    const doc = { content: 'hello', version: 3 }
    const result = apply(doc, { type: 'insert', position: 0 })
    expect(result.content).toBe('hello')
    expect(result.version).toBe(3)
  })
})

describe('apply() — delete', () => {
  it('deletes text in the middle', () => {
    const doc = { content: 'hello world', version: 0 }
    const result = apply(doc, { type: 'delete', position: 5, length: 6 })
    expect(result.content).toBe('hello')
    expect(result.version).toBe(1)
  })

  it('deletes from position 0', () => {
    const doc = { content: 'hello world', version: 0 }
    const result = apply(doc, { type: 'delete', position: 0, length: 6 })
    expect(result.content).toBe('world')
    expect(result.version).toBe(1)
  })

  it('deletes to end of document', () => {
    const doc = { content: 'hello world', version: 0 }
    const result = apply(doc, { type: 'delete', position: 5, length: 6 })
    expect(result.content).toBe('hello')
    expect(result.version).toBe(1)
  })

  it('deletes entire document', () => {
    const doc = { content: 'hello', version: 0 }
    const result = apply(doc, { type: 'delete', position: 0, length: 5 })
    expect(result.content).toBe('')
    expect(result.version).toBe(1)
  })

  it('zero length is a no-op (transform sentinel)', () => {
    const doc = { content: 'hello', version: 2 }
    const result = apply(doc, { type: 'delete', position: 0, length: 0 })
    expect(result.content).toBe('hello')
    expect(result.version).toBe(2) // version must NOT bump
  })

  it('undefined length is a no-op', () => {
    const doc = { content: 'hello', version: 1 }
    const result = apply(doc, { type: 'delete', position: 0 })
    expect(result.content).toBe('hello')
    expect(result.version).toBe(1)
  })
})

describe('apply() — retain', () => {
  it('is always a no-op', () => {
    const doc = { content: 'hello', version: 5 }
    const result = apply(doc, { type: 'retain', position: 0, length: 3 })
    expect(result.content).toBe('hello')
    expect(result.version).toBe(5)
  })
})
