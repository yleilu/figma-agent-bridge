// grid-track.test.ts — the per-track sizing atom (I56).
//
// One track of a GRID frame is a `GridTrackSize` — `{type:'FLEX'|'FIXED'|'HUG',
// value?}` — and the grammar spells it the way CSS grid does, because that is
// the vocabulary the concept already has: `1fr`, `240px`, `hug`.
//
// PARSE and RENDER live in one module so the two cannot drift: whatever a read
// renders must parse back to the same track (T2), and that is asserted here as
// a round trip rather than as two lists someone has to keep aligned by hand.

import { describe, expect, it } from 'bun:test'
import {
  parseTrack,
  renderTrack,
} from '@figma-agent-bridge/server/serialize/grid-track'

describe('parseTrack', () => {
  it('reads a fractional track', () => {
    expect(parseTrack('1fr', 'rowSizes[0]')).toEqual({
      type: 'FLEX',
      value: 1,
    })
    expect(parseTrack('2.5fr', 'rowSizes[0]')).toEqual({
      type: 'FLEX',
      value: 2.5,
    })
  })

  it('reads a bare `fr` as one fraction', () => {
    expect(parseTrack('fr', 'rowSizes[0]')).toEqual({
      type: 'FLEX',
      value: 1,
    })
  })

  it('reads a fixed track, with or without the unit', () => {
    expect(parseTrack('240px', 'colSizes[0]')).toEqual({
      type: 'FIXED',
      value: 240,
    })
    expect(parseTrack('240', 'colSizes[0]')).toEqual({
      type: 'FIXED',
      value: 240,
    })
  })

  it('reads a hugging track, whatever its case', () => {
    expect(parseTrack('hug', 'rowSizes[1]')).toEqual({
      type: 'HUG',
    })
    expect(parseTrack('HUG', 'rowSizes[1]')).toEqual({
      type: 'HUG',
    })
  })

  it('refuses a spelling it does not know, naming the ones it does', () => {
    expect(() => parseTrack('auto', 'rowSizes[0]')).toThrow(
      /rowSizes\[0\]/,
    )
    expect(() => parseTrack('auto', 'rowSizes[0]')).toThrow(
      /1fr/,
    )
    expect(() => parseTrack('', 'rowSizes[0]')).toThrow()
    expect(() =>
      parseTrack('12fr34', 'rowSizes[0]'),
    ).toThrow()
  })

  it('refuses a negative track', () => {
    expect(() =>
      parseTrack('-4px', 'colSizes[0]'),
    ).toThrow()
  })
})

describe('renderTrack — and the round trip a read owes a write (T2)', () => {
  it('renders each type in the spelling parseTrack takes back', () => {
    expect(renderTrack({ type: 'FLEX', value: 1 })).toBe(
      '1fr',
    )
    expect(renderTrack({ type: 'FIXED', value: 240 })).toBe(
      '240px',
    )
    expect(renderTrack({ type: 'HUG' })).toBe('hug')
  })

  it('states the fraction a FLEX track omits', () => {
    // Figma leaves `value` optional on a FLEX track. `1fr` is what one
    // fraction means, and a read that emitted a bare `fr` would be a second
    // spelling of the same thing on the face that has to be canonical.
    expect(renderTrack({ type: 'FLEX' })).toBe('1fr')
  })

  it('round-trips every rendered track', () => {
    const tracks = [
      { type: 'FLEX' as const, value: 1 },
      { type: 'FLEX' as const, value: 3 },
      { type: 'FIXED' as const, value: 240 },
      { type: 'FIXED' as const, value: 0 },
      { type: 'HUG' as const },
    ]
    for (const track of tracks) {
      expect(
        parseTrack(renderTrack(track), 'rowSizes[0]'),
      ).toEqual(track)
    }
  })
})
