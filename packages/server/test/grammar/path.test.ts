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

  it('accepts the unquoted data form when the fill rule is there', () => {
    expect(
      atomToPath('path(NONZERO,M 12 0 L 24 24 Z)'),
    ).toEqual({
      windingRule: 'NONZERO',
      data: 'M 12 0 L 24 24 Z',
    })
  })

  it('accepts data Figma will refuse — an engine refusal is not a parse failure', () => {
    // `path(NONZERO,"garbage")` PARSES. Figma rejects it, the node lands
    // without the field, and the plugin reports Figma's own error on
    // warnings[] (expression-formats.md). The parser must not pre-empt that.
    expect(atomToPath('path(NONZERO,"garbage")')).toEqual({
      windingRule: 'NONZERO',
      data: 'garbage',
    })
  })

  // B77 — `grammar.md` promises that data copied straight out of an SVG file
  // lands as written, and Figma refuses `H`, `V` and `A`: the live
  // `path(NONE,"M 4 4 H 10 V 10 H 4 Z")` came back as "Failed to convert path.
  // Invalid command at H", node landed, geometry gone. Five of twelve icons
  // plus every chain glyph were rewritten by hand on that build.
  it('rewrites the commands Figma refuses, so the promise holds', () => {
    expect(
      atomToPath('path(NONE,"M 4 4 H 10 V 10 H 4 Z")'),
    ).toEqual({
      windingRule: 'NONE',
      data: 'M 4 4 L 10 4 L 10 10 L 4 10 Z',
    })
  })

  it('rewrites an arc, commas and all — the copy-paste case end to end', () => {
    const { data } = atomToPath(
      'path(NONZERO,"M 10,0 A 10,10 0 0,1 0,10 Z")',
    )
    expect(data).not.toContain('A')
    expect(data.startsWith('M 10 0 C ')).toBe(true)
    expect(data.endsWith('Z')).toBe(true)
  })

  it('leaves data Figma already takes byte-identical', () => {
    // The round-trip guarantee below depends on this: a normaliser with
    // nothing to do must return the string it was given.
    expect(
      atomToPath('path(NONZERO,"M 0 0 L 10 0 Z")').data,
    ).toBe('M 0 0 L 10 0 Z')
  })
})

// ─── B45: an atom that does not parse is rejected, never guessed at ──────────
//
// Every form below used to convert SILENTLY to `{windingRule:'NONZERO',
// data:''}` — Figma drew nothing, the create reported success with an empty
// warnings[], and the node read back `vectorPaths: []`. The sweep's whole
// vector matrix is the table (expression-formats.md, the reject/degrade
// clause).
describe('atomToPath — malformed atoms are INVALID_PARAM', () => {
  const teaches = (fn: () => unknown): void => {
    try {
      fn()
      throw new Error('expected the atom to be rejected')
    } catch (err) {
      expect((err as { code?: string }).code).toBe(
        'INVALID_PARAM',
      )
      // The canonical form, so the message teaches the fix and not only the
      // failure.
      expect((err as Error).message).toContain(
        'path(NONZERO,"M 0 0 L 24 24")',
      )
    }
  }

  it('rejects the one-argument form — the fill rule is missing (the live B45 repro)', () => {
    teaches(() =>
      atomToPath('path(M 12 0 L 24 24 L 0 24 Z)'),
    )
  })

  it('rejects a one-argument QUOTED form for the same reason', () => {
    teaches(() => atomToPath('path("M 12 0 L 24 24 Z")'))
  })

  it('rejects an empty path()', () => {
    teaches(() => atomToPath('path()'))
  })

  it('rejects a first argument that is not a fill rule', () => {
    teaches(() => atomToPath('path(SOLID,"M 0 0 L 24 24")'))
  })

  it('names the three fill rules when the rule is wrong', () => {
    expect(() =>
      atomToPath('path(SOLID,"M 0 0 L 24 24")'),
    ).toThrow('NONZERO, EVENODD or NONE')
  })

  it('rejects a bare d-string — it is not a path atom at all', () => {
    teaches(() => atomToPath('M 0 0 L 24 24 L 0 24 Z'))
  })

  it('rejects a non-path atom', () => {
    teaches(() => atomToPath('#FF0000'))
  })

  it('rejects the wrong head', () => {
    teaches(() => atomToPath('grid(10)'))
  })

  it('rejects path data with no geometry in it', () => {
    teaches(() => atomToPath('path(NONZERO,"")'))
  })

  it('rejects an unbalanced atom as a parameter fault, not a plugin fault', () => {
    teaches(() => atomToPath('path(NONZERO,"M 0 0 Z"'))
  })
})

// The write face promises that commas in the data are normalized to spaces
// (expression-formats.md). The tokenizer splits a head's args on every
// top-level comma, so the SVG-native spelling arrived as four arguments and
// the parser kept `"M0` as the whole shape — a silent misread of the geometry
// the agent asked for. Everything after the fill rule is the data.
describe('atomToPath — comma-separated SVG data', () => {
  it('rejoins quoted data that the tokenizer split on its commas', () => {
    expect(
      atomToPath('path(NONZERO,"M0,0 L10,0 Z")'),
    ).toEqual({
      windingRule: 'NONZERO',
      data: 'M0 0 L10 0 Z',
    })
  })

  it('rejoins unquoted comma data the same way', () => {
    expect(
      atomToPath('path(EVENODD,M0,0 L10,0 Z)'),
    ).toEqual({
      windingRule: 'EVENODD',
      data: 'M0 0 L10 0 Z',
    })
  })

  it('round-trips the rejoined data through the canonical form', () => {
    expect(
      pathToAtom(
        atomToPath('path(NONZERO,"M0,0 L10,0 Z")'),
      ),
    ).toBe('path(NONZERO,"M0 0 L10 0 Z")')
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
