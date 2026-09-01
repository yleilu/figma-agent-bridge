// svg-path.test.ts — B77: the SVG commands Figma refuses, rewritten into the
// ones it takes.
//
// `path(NONE,"M 4 4 H 10 V 10 H 4 Z")` came back as *"vectorPaths rejected by
// Figma: in set_vectorPaths: Failed to convert path. Invalid command at H"*,
// with the node landed and its geometry gone, while `grammar.md` promised that
// "data copied straight out of an SVG file lands as written". On the
// 2026-08-30 build that cost 5 of 12 icons plus every chain glyph a hand
// rewrite.

import { describe, expect, it } from 'bun:test'
import { normalizeSvgCommands } from '@figma-agent-bridge/server/grammar/svg-path'

/** Sample a cubic Bézier at t. */
const bezier = (
  p0: [number, number],
  c1: [number, number],
  c2: [number, number],
  p1: [number, number],
  t: number,
): [number, number] => {
  const u = 1 - t
  const at = (i: 0 | 1): number =>
    u * u * u * p0[i] +
    3 * u * u * t * c1[i] +
    3 * u * t * t * c2[i] +
    t * t * t * p1[i]
  return [at(0), at(1)]
}

/** Every number in a path string. */
const nums = (s: string): number[] =>
  (s.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)

describe('normalizeSvgCommands — the pass-through guarantee', () => {
  it('returns data with nothing to rewrite as the SAME STRING', () => {
    // Byte identity, not equivalence: a read → write round trip must not be
    // perturbed by a normaliser that had no work to do.
    const data = 'M 0 0 L 100 0 L 100 100 Z'
    expect(normalizeSvgCommands(data)).toBe(data)
  })

  it('leaves relative M/L/C/Q alone — Figma takes them', () => {
    const data = 'm 0 0 l 10 0 c 1 2 3 4 5 6 q 1 1 2 2 z'
    expect(normalizeSvgCommands(data)).toBe(data)
  })

  it('returns data it cannot tokenize unchanged, never repaired', () => {
    // path() forwards data it cannot vouch for so that FIGMA's refusal is what
    // the caller sees. A normaliser that started rejecting would move that
    // judgement to the wrong side of the wire.
    for (const bad of [
      'garbage',
      'M 0 0 L',
      'M 0 0 X 1 1',
      'M 0 0 H',
    ]) {
      expect(normalizeSvgCommands(bad)).toBe(bad)
    }
  })
})

describe('normalizeSvgCommands — H and V', () => {
  it('the live repro lands as lines', () => {
    expect(
      normalizeSvgCommands('M 4 4 H 10 V 10 H 4 Z'),
    ).toBe('M 4 4 L 10 4 L 10 10 L 4 10 Z')
  })

  it('relative h and v track the current point', () => {
    expect(
      normalizeSvgCommands('M 4 4 h 6 v 6 h -6 Z'),
    ).toBe('M 4 4 L 10 4 L 10 10 L 4 10 Z')
  })

  it('an implicit repeat is expanded before it is rewritten', () => {
    // `H 10 20` is two horizontal lines, and the second must not be read as a
    // second argument to the first.
    expect(normalizeSvgCommands('M 0 0 H 10 20')).toBe(
      'M 0 0 L 10 0 L 20 0',
    )
  })

  it('a repeated M is an L — and the current point follows it', () => {
    expect(normalizeSvgCommands('M 0 0 5 5 H 10')).toBe(
      'M 0 0 L 5 5 L 10 5',
    )
  })

  it('Z returns the current point to the subpath start', () => {
    // The `H` after the close must measure from [0,0], not from [9,9].
    expect(normalizeSvgCommands('M 0 0 L 9 9 Z H 4')).toBe(
      'M 0 0 L 9 9 Z L 4 0',
    )
  })
})

describe('normalizeSvgCommands — the shorthand curves', () => {
  it('S reflects the previous cubic control point', () => {
    // Previous C ends at (6,6) with second control (5,4); the reflection about
    // the endpoint is (7,8).
    expect(
      normalizeSvgCommands(
        'M 0 0 C 1 2 5 4 6 6 S 9 9 10 10',
      ),
    ).toBe('M 0 0 C 1 2 5 4 6 6 C 7 8 9 9 10 10')
  })

  it('S with no previous cubic uses the current point', () => {
    expect(normalizeSvgCommands('M 2 2 S 5 5 8 8')).toBe(
      'M 2 2 C 2 2 5 5 8 8',
    )
  })

  it('T reflects the previous quadratic control point', () => {
    // Q control (2,4), endpoint (4,0) → reflection (6,-4).
    expect(
      normalizeSvgCommands('M 0 0 Q 2 4 4 0 T 8 0'),
    ).toBe('M 0 0 Q 2 4 4 0 Q 6 -4 8 0')
  })

  it('a command between them breaks the reflection chain', () => {
    // An `L` is not a curve, so the S that follows has no control point to
    // mirror and falls back to the current point (SVG 8.3.6).
    expect(
      normalizeSvgCommands(
        'M 0 0 C 1 1 2 2 3 3 L 4 4 S 6 6 8 8',
      ),
    ).toBe('M 0 0 C 1 1 2 2 3 3 L 4 4 C 4 4 6 6 8 8')
  })
})

describe('normalizeSvgCommands — arcs', () => {
  it('a quarter circle lands on the circle it describes', () => {
    // From (10,0) to (0,10), r=10, sweep=1: the quarter centred on the origin.
    const out = normalizeSvgCommands(
      'M 10 0 A 10 10 0 0 1 0 10',
    )
    expect(out.startsWith('M 10 0 C ')).toBe(true)
    const n = nums(out)
    const [c1x, c1y, c2x, c2y, ex, ey] = n.slice(2)
    expect(ex).toBeCloseTo(0, 6)
    expect(ey).toBeCloseTo(10, 6)
    // The midpoint of the curve is on the circle, which a wrong sweep, a wrong
    // centre or a wrong control-point scale would all break.
    const mid = bezier(
      [10, 0],
      [c1x, c1y],
      [c2x, c2y],
      [ex, ey],
      0.5,
    )
    expect(Math.hypot(mid[0], mid[1])).toBeCloseTo(10, 3)
    // …and it is the SHORT way round, on the +x +y side.
    expect(mid[0]).toBeGreaterThan(0)
    expect(mid[1]).toBeGreaterThan(0)
  })

  it('the sweep flag picks the other circle', () => {
    // Two circles of radius 10 pass through (10,0) and (0,10) — centred on
    // (0,0) and on (10,10). sweep=1 took the first; sweep=0 must take the
    // second, and a normaliser that ignored the flag would return the first
    // again.
    const n = nums(
      normalizeSvgCommands('M 10 0 A 10 10 0 0 0 0 10'),
    )
    const mid = bezier(
      [10, 0],
      [n[2], n[3]],
      [n[4], n[5]],
      [n[6], n[7]],
      0.5,
    )
    expect(
      Math.hypot(mid[0] - 10, mid[1] - 10),
    ).toBeCloseTo(10, 3)
    // …which bows the other way: toward the origin, not away from it.
    expect(Math.hypot(mid[0], mid[1])).toBeLessThan(10)
  })

  it('a large arc is split into several cubics, none over 90°', () => {
    // Three quarters of a circle: one cubic per quarter-turn is the bound.
    const out = normalizeSvgCommands(
      'M 10 0 A 10 10 0 1 1 0 -10',
    )
    const cubics = out.split('C').length - 1
    expect(cubics).toBe(3)
  })

  it('a full-radius-limited arc is scaled up rather than refused', () => {
    // Radii too small to span the endpoints: the spec scales them until they
    // just reach, and the result still ends where it was told to.
    const out = normalizeSvgCommands(
      'M 0 0 A 1 1 0 0 1 10 0',
    )
    const n = nums(out)
    expect(n[n.length - 2]).toBeCloseTo(10, 6)
    expect(n[n.length - 1]).toBeCloseTo(0, 6)
  })

  it('a zero radius is a straight line, exactly', () => {
    expect(
      normalizeSvgCommands('M 0 0 A 0 0 0 0 1 10 10'),
    ).toBe('M 0 0 L 10 10')
  })

  it('a relative arc lands where the absolute one does', () => {
    expect(
      normalizeSvgCommands('M 10 0 a 10 10 0 0 1 -10 10'),
    ).toBe(
      normalizeSvgCommands('M 10 0 A 10 10 0 0 1 0 10'),
    )
  })

  it('the rounded-rect corner an icon actually needs', () => {
    // The shape that forced the hand rewrite: a 24-box with 4px corners.
    const out = normalizeSvgCommands(
      'M 4 0 H 20 A 4 4 0 0 1 24 4 V 20 A 4 4 0 0 1 20 24 H 4 A 4 4 0 0 1 0 20 V 4 A 4 4 0 0 1 4 0 Z',
    )
    expect(out).not.toContain('H')
    expect(out).not.toContain('V')
    expect(out).not.toContain('A')
    expect(out.endsWith('Z')).toBe(true)
    // Four corners, four cubics — each corner is a quarter turn.
    expect(out.split('C').length - 1).toBe(4)
  })
})
