// grammar/path.test.ts — round-trip tests for atomToPath / pathToAtom.

import { describe, expect, it } from 'bun:test'
import {
  atomToPath,
  pathToAtom,
} from '@figma-agent-bridge/server/grammar'
import type { FigmaVectorPath } from '@figma-agent-bridge/server/grammar'

describe('pathToAtom — emit canonical atom string', () => {
  it('NONZERO winding rule', () => {
    expect(
      pathToAtom({
        windingRule: 'NONZERO',
        data: 'M0 0 L10 0 Z',
      }),
    ).toBe('path(NONZERO,"M0 0 L10 0 Z")')
  })

  it('EVENODD winding rule', () => {
    expect(
      pathToAtom({
        windingRule: 'EVENODD',
        data: 'M0 0 L10 0 Z',
      }),
    ).toBe('path(EVENODD,"M0 0 L10 0 Z")')
  })

  it('NONE winding rule', () => {
    expect(
      pathToAtom({
        windingRule: 'NONE',
        data: 'M0 0 L10 0 Z',
      }),
    ).toBe('path(NONE,"M0 0 L10 0 Z")')
  })

  it('data string with spaces and decimals', () => {
    expect(
      pathToAtom({
        windingRule: 'NONZERO',
        data: 'M 0 0 L 10.5 0 L 5.25 8.66 Z',
      }),
    ).toBe('path(NONZERO,"M 0 0 L 10.5 0 L 5.25 8.66 Z")')
  })

  it('normalizes comma separators in path data to spaces', () => {
    expect(
      pathToAtom({
        windingRule: 'NONZERO',
        data: 'M0,0 L10,0 Z',
      }),
    ).toBe('path(NONZERO,"M0 0 L10 0 Z")')
  })
})

describe('atomToPath — parse atom string', () => {
  it('NONZERO winding rule', () => {
    expect(
      atomToPath('path(NONZERO,"M0 0 L10 0 Z")'),
    ).toEqual({
      windingRule: 'NONZERO',
      data: 'M0 0 L10 0 Z',
    })
  })

  it('EVENODD winding rule', () => {
    expect(
      atomToPath('path(EVENODD,"M0 0 L10 0 Z")'),
    ).toEqual({
      windingRule: 'EVENODD',
      data: 'M0 0 L10 0 Z',
    })
  })

  it('NONE winding rule', () => {
    expect(atomToPath('path(NONE,"M0 0 L10 0 Z")')).toEqual(
      {
        windingRule: 'NONE',
        data: 'M0 0 L10 0 Z',
      },
    )
  })

  it('data string with spaces and decimals', () => {
    expect(
      atomToPath(
        'path(NONZERO,"M 0 0 L 10.5 0 L 5.25 8.66 Z")',
      ),
    ).toEqual({
      windingRule: 'NONZERO',
      data: 'M 0 0 L 10.5 0 L 5.25 8.66 Z',
    })
  })

  it('throws on non-path atom', () => {
    expect(() => atomToPath('#FF0000')).toThrow(
      'atomToPath',
    )
  })

  it('throws on wrong head', () => {
    expect(() => atomToPath('grid(10)')).toThrow(
      'atomToPath',
    )
  })
})

describe('atomToPath / pathToAtom — round-trip guarantee', () => {
  const cases: string[] = [
    'path(NONZERO,"M0 0 L10 0 Z")',
    'path(EVENODD,"M0 0 L10 0 Z")',
    'path(NONE,"M0 0 L10 0 Z")',
    'path(NONZERO,"M 0 0 L 10.5 0 L 5.25 8.66 Z")',
  ]

  for (const atom of cases) {
    it(`round-trips: ${atom}`, () => {
      expect(pathToAtom(atomToPath(atom))).toBe(atom)
    })
  }
})

describe('FigmaVectorPath type', () => {
  it('accepts all three winding rules (type-level)', () => {
    const paths: FigmaVectorPath[] = [
      { windingRule: 'NONZERO', data: 'M0 0 Z' },
      { windingRule: 'EVENODD', data: 'M0 0 Z' },
      { windingRule: 'NONE', data: 'M0 0 Z' },
    ]
    expect(paths).toHaveLength(3)
  })
})

// ─── per-point corner radii (expression-formats.md, the path() {…} channel) ──
//
// A vector drawn by hand commonly rounds some corners and not others, to
// different radii. The path data cannot say so, and reading one without this
// gives the agent a shape with sharp corners the file does not have.
// Sparse and index-keyed: 500 points with three rounded corners emits three
// entries. Verified live that a vertex's index is the order the data string
// visits its points, subpaths included.
describe('path atom — per-point corners', () => {
  it('parses a sparse corner list', () => {
    expect(
      atomToPath(
        'path(NONE,"M 0 0 L 10 0 Z"){corners=[0:12, 2:4]}',
      ).corners,
    ).toEqual({ 0: 12, 2: 4 })
  })

  it('has no corners key when the attr is absent', () => {
    expect(
      atomToPath('path(NONE,"M 0 0 L 10 0 Z")').corners,
    ).toBeUndefined()
  })

  it('renders a sparse corner list', () => {
    expect(
      pathToAtom({
        windingRule: 'NONE',
        data: 'M 0 0 L 10 0 Z',
        corners: { 0: 12, 2: 4 },
      }),
    ).toBe(
      'path(NONE,"M 0 0 L 10 0 Z"){corners=[0:12,2:4]}',
    )
  })

  it('omits the attr entirely when nothing is rounded', () => {
    expect(
      pathToAtom({
        windingRule: 'NONE',
        data: 'M 0 0 Z',
        corners: {},
      }),
    ).toBe('path(NONE,"M 0 0 Z")')
  })

  it('round-trips the maintainer’s hand-drawn shape', () => {
    const a =
      'path(NONE,"M 0 76.82 L 130.76 0 L 236 150.15 L 66.37 242 Z"){corners=[1:10,2:20]}'
    expect(pathToAtom(atomToPath(a))).toBe(a)
  })

  it('skips a malformed entry rather than throwing', () => {
    // A read must never die mid-serialization on odd input.
    expect(
      atomToPath(
        'path(NONE,"M 0 0 Z"){corners=[bogus, 1:5]}',
      ).corners,
    ).toEqual({ 1: 5 })
  })
})

describe('path() — per-point stroke caps', () => {
  it('parses a sparse cap list', () => {
    expect(
      atomToPath(
        'path(NONE,"M 0 0 L 200 0"){caps=[1:ARROW_LINES]}',
      ).caps,
    ).toEqual({ 1: 'ARROW_LINES' })
  })

  it('renders one, sorted and quoted like the rest', () => {
    expect(
      pathToAtom({
        windingRule: 'NONE',
        data: 'M 0 0 L 200 0',
        caps: { 1: 'ARROW_LINES', 0: 'ROUND' },
      }),
    ).toBe(
      'path(NONE,"M 0 0 L 200 0"){caps=[0:ROUND,1:ARROW_LINES]}',
    )
  })

  it('carries corners and caps together', () => {
    // Attrs are separated by ", " and array items by "," — renderAtom's
    // existing convention, same as dash=[4,4].
    const atom =
      'path(NONE,"M 0 0 L 10 0 L 10 10 Z"){corners=[1:4], caps=[2:SQUARE]}'
    const parsed = atomToPath(atom)
    expect(parsed.corners).toEqual({ 1: 4 })
    expect(parsed.caps).toEqual({ 2: 'SQUARE' })
    expect(pathToAtom(parsed)).toBe(atom)
  })

  // REST's LINE_ARROW is normalized upstream in the reader; anything that
  // reaches the grammar and is still not a Plugin API cap is not a cap.
  it('drops a value that is not a Plugin API StrokeCap', () => {
    expect(
      atomToPath(
        'path(NONE,"M 0 0 Z"){caps=[0:LINE_ARROW, 1:ROUND]}',
      ).caps,
    ).toEqual({ 1: 'ROUND' })
  })

  it('has no caps key when the attr is absent', () => {
    expect(
      atomToPath('path(NONE,"M 0 0 Z")').caps,
    ).toBeUndefined()
  })
})

describe('path() — per-point stroke joins', () => {
  it('parses and renders a sparse join list', () => {
    const atom =
      'path(NONE,"M 0 0 L 10 0 L 10 10"){joins=[1:BEVEL]}'
    const parsed = atomToPath(atom)
    expect(parsed.joins).toEqual({ 1: 'BEVEL' })
    expect(pathToAtom(parsed)).toBe(atom)
  })

  it('carries all three keys at once, in table order', () => {
    const atom =
      'path(NONE,"M 0 0 L 10 0 L 10 10"){corners=[0:2], caps=[1:ROUND], joins=[2:BEVEL]}'
    expect(pathToAtom(atomToPath(atom))).toBe(atom)
  })

  it('drops a value that is not a StrokeJoin', () => {
    expect(
      atomToPath(
        'path(NONE,"M 0 0 Z"){joins=[0:CURVED, 1:MITER]}',
      ).joins,
    ).toEqual({ 1: 'MITER' })
  })

  it('has no joins key when the attr is absent', () => {
    expect(
      atomToPath('path(NONE,"M 0 0 Z")').joins,
    ).toBeUndefined()
  })
})
