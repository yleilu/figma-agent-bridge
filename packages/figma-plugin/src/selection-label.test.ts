import { describe, expect, test } from 'bun:test'
import {
  homogeneousKind,
  selectionNoun,
  selectionLabel,
} from './selection-label'

describe('homogeneousKind', () => {
  test('empty selection → null', () => {
    expect(homogeneousKind([])).toBeNull()
  })
  test('one node → its type', () => {
    expect(homogeneousKind([{ type: 'FRAME' }])).toBe(
      'FRAME',
    )
  })
  test('all same → that type', () => {
    expect(
      homogeneousKind([
        { type: 'FRAME' },
        { type: 'FRAME' },
      ]),
    ).toBe('FRAME')
  })
  test('differing → MIXED', () => {
    expect(
      homogeneousKind([
        { type: 'FRAME' },
        { type: 'TEXT' },
      ]),
    ).toBe('MIXED')
  })
  test('differs at the LAST index → MIXED', () => {
    expect(
      homogeneousKind([
        { type: 'FRAME' },
        { type: 'FRAME' },
        { type: 'TEXT' },
      ]),
    ).toBe('MIXED')
  })
})

describe('selectionNoun', () => {
  test('homogeneous type → plural noun', () => {
    expect(selectionNoun('FRAME', 2)).toBe('frames')
    expect(selectionNoun('TEXT', 3)).toBe('text layers')
    expect(selectionNoun('RECTANGLE', 5)).toBe('rectangles')
    expect(selectionNoun('INSTANCE', 4)).toBe('instances')
  })
  test('singular at one', () => {
    expect(selectionNoun('FRAME', 1)).toBe('frame')
    expect(selectionNoun('TEXT', 1)).toBe('text layer')
  })
  test('mixed / null / unmapped → generic node(s)', () => {
    expect(selectionNoun('MIXED', 3)).toBe('nodes')
    expect(selectionNoun(null, 2)).toBe('nodes')
    expect(selectionNoun('SOME_FUTURE_TYPE', 2)).toBe(
      'nodes',
    )
    expect(selectionNoun('MIXED', 1)).toBe('node')
  })
  test('inherited Object keys are not nouns', () => {
    expect(selectionNoun('toString', 2)).toBe('nodes')
    expect(selectionNoun('constructor', 2)).toBe('nodes')
  })
})

describe('selectionLabel', () => {
  test('composes count + noun + selected', () => {
    expect(selectionLabel(2, 'FRAME')).toBe(
      '2 frames selected',
    )
    expect(selectionLabel(1, 'TEXT')).toBe(
      '1 text layer selected',
    )
    expect(selectionLabel(3, 'MIXED')).toBe(
      '3 nodes selected',
    )
    expect(selectionLabel(1, null)).toBe('1 node selected')
  })
  test('zero is renderable but the caller gates it', () => {
    expect(selectionLabel(0, 'FRAME')).toBe(
      '0 frames selected',
    )
  })
})
