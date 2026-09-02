// combine-variants.test.ts — I88, a COUNT error for a TYPE fault.
//
// The live call (operator-filed 2026-09-02) passed exactly two ids and was
// told it needed at least two, because the second id was an INSTANCE. The
// message pointed at the array length, which was correct, and the operator
// spent its time re-counting an array that was never wrong.

import { describe, expect, it } from 'bun:test'
import { combineVariantsRefusal } from './combine-variants'

describe('combineVariantsRefusal', () => {
  it('names the offending id and what it actually is', () => {
    const message = combineVariantsRefusal(
      [{ id: '571:31763', type: 'INSTANCE' }],
      1,
    )
    expect(message).toContain('571:31763')
    expect(message).toContain('is a INSTANCE')
    expect(message).toContain('not a COMPONENT')
  })

  it('keeps the count — it IS the condition', () => {
    expect(
      combineVariantsRefusal(
        [{ id: '571:31763', type: 'INSTANCE' }],
        1,
      ),
    ).toContain('found 1')
  })

  it('says so when an id names nothing at all', () => {
    expect(
      combineVariantsRefusal([{ id: 'nope' }], 1),
    ).toContain('nope names no node')
  })

  it('names several, each with its own type', () => {
    const message = combineVariantsRefusal(
      [
        { id: 'a', type: 'INSTANCE' },
        { id: 'b', type: 'FRAME' },
      ],
      0,
    )
    expect(message).toContain('a is a INSTANCE')
    expect(message).toContain('b is a FRAME')
  })

  it('counts the rest past the naming budget (T4)', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      id: 'n' + i,
      type: 'FRAME',
    }))
    const message = combineVariantsRefusal(many, 0)
    expect(message).toContain('n7')
    expect(message).not.toContain('n8 is')
    expect(message).toContain('and 3 more')
  })

  it('a genuinely short list gets the plain count and the route', () => {
    const message = combineVariantsRefusal([], 1)
    expect(message).toContain('found 1')
    expect(message).toContain('get_components')
    // No id was rejected, so nothing is invented about one.
    expect(message).not.toContain('not a COMPONENT')
  })

  it('names the create_tree trap only when an id was rejected', () => {
    expect(
      combineVariantsRefusal(
        [{ id: 'x', type: 'INSTANCE' }],
        1,
      ),
    ).toContain('positional')
    expect(combineVariantsRefusal([], 0)).not.toContain(
      'positional',
    )
  })
})
