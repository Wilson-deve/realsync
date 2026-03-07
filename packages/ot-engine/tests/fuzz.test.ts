import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { transform } from '../src/transform'
import { apply } from '../src/apply'
import { DocumentState, Op } from '../src/type'

describe('3-user concurrent editing', () => {
  it('all three clients converge — 1,000 runs', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 5, maxLength: 30 }),
        fc.nat(29),
        fc.nat(29),
        fc.nat(29),
        (doc, p1, p2, p3) => {
          const S: DocumentState = { content: doc, version: 0 }
          const op1: Op = { type: 'insert', position: p1 % (doc.length + 1), content: 'A' }
          const op2: Op = { type: 'insert', position: p2 % (doc.length + 1), content: 'B' }
          const op3: Op = { type: 'insert', position: p3 % (doc.length + 1), content: 'C' }

          // Server applies: op1, then op2', then op3''
          // [op1_2, op2_1]: transform op1 against op2
          const [op1_2, op2_1] = transform(op1, op2)
          // [op1_3, op3_1]: transform op1 against op3
          const [op1_3, op3_1] = transform(op1, op3)
          // Now transform the already-shifted op2_1 against op3_1
          const [op2_3, op3_2] = transform(op2_1, op3_1)

          // Client 1: saw op1 first, then receives op2_1, then op3_2
          const client1 = apply(apply(apply(S, op1), op2_1), op3_2)
          // Client 2: saw op2 first, then receives op1_2, then op3_2
          const client2 = apply(apply(apply(S, op2), op1_2), op3_2)
          // Client 3: saw op3 first, then receives op1_3, then op2_3
          const client3 = apply(apply(apply(S, op3), op1_3), op2_3)

          expect(client1.content).toBe(client2.content)
          expect(client2.content).toBe(client3.content)
        }
      ),
      { numRuns: 1000 }
    )
  })
})
