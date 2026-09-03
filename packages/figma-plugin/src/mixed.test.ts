import { describe, expect, it } from 'bun:test'
import { omitMixed } from './mixed'

// Stands in for figma.mixed, which is a Symbol at runtime.
const MIXED = Symbol('figma.mixed')

describe('omitMixed', () => {
  it('passes an ordinary value straight through', () => {
    expect(omitMixed('BEVEL', MIXED)).toBe('BEVEL')
    expect(omitMixed(0, MIXED)).toBe(0)
    expect(omitMixed(false, MIXED)).toBe(false)
  })

  it('drops the mixed sentinel', () => {
    expect(omitMixed(MIXED, MIXED)).toBeUndefined()
  })

  // The point of the whole module: a symbol reaching the wire throws inside
  // postMessage and the reply is lost, so the caller sees a timeout rather
  // than an answer. Nothing that survives this may be a symbol.
  it('leaves no symbol behind to reach postMessage', () => {
    const out = [MIXED, 'ROUND', MIXED].map(v =>
      omitMixed(v, MIXED),
    )
    expect(out.some(v => typeof v === 'symbol')).toBe(false)
    expect(out).toEqual([undefined, 'ROUND', undefined])
  })

  it('does not confuse a different symbol with mixed', () => {
    const other = Symbol('something else')
    expect(omitMixed(other, MIXED)).toBe(other)
  })
})
