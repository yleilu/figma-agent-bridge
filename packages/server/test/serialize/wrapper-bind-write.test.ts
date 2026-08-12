// wrapper-bind-write.test.ts — an inline var()/style() wrapper carries its
// BINDING INTENT through the write converter (I39).
//
// The write face used to strip the wrapper and keep only the literal: the
// appearance landed, the token name was discarded, and the only way to bind was
// a second `bind_variable`/`apply_style` call per node per field. Measured on a
// real build that meant 11.1% of paints were bound while 964 of 965 raw values
// were EXACT token values — the correct path cost more than the wrong one.
//
// So the converter now emits a `bindings[]` alongside the converted literal:
// each entry names the wrapper KIND, the design-system NAME, and the field the
// plugin's own bind_variable/apply_style handler binds (the routes come from
// those handlers, not from a list invented here). The literal is unchanged —
// binding is additive.

import { describe, expect, it } from 'bun:test'
import { specToFigma } from '@figma-agent-bridge/server/serialize/node-spec-writer'

describe('write-face wrapper bindings — var()', () => {
  it('a var() fill keeps its literal AND carries the binding intent by name', () => {
    const out = specToFigma({
      fills: ['var(surface/2)#141B2E'],
    })
    // the literal still lands exactly as before
    expect(out.fills).toEqual([
      {
        type: 'SOLID',
        color: { r: 0.078, g: 0.106, b: 0.18 },
      },
    ])
    // …and the NAME survives conversion
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'surface/2',
        field: 'fills',
        index: 0,
      },
    ])
  })

  it('binds per PAINT — each index carries its own name', () => {
    const out = specToFigma({
      fills: ['var(a/one)#111111', 'var(b/two)#222222'],
    })
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'a/one',
        field: 'fills',
        index: 0,
      },
      {
        kind: 'var',
        name: 'b/two',
        field: 'fills',
        index: 1,
      },
    ])
  })

  it('an unwrapped paint beside a wrapped one contributes no binding', () => {
    const out = specToFigma({
      fills: ['#000000', 'var(b/two)#222222'],
    })
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'b/two',
        field: 'fills',
        index: 1,
      },
    ])
  })

  it('a var() stroke paint binds the strokes field', () => {
    const out = specToFigma({
      strokes: ['var(border/subtle)#E5E7EB'],
    })
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'border/subtle',
        field: 'strokes',
        index: 0,
      },
    ])
  })

  it('a var() stroke ATOM binds strokeWeight (the scalar the reader wraps)', () => {
    const out = specToFigma({
      stroke: 'var(stroke/weight-medium)stroke(4)',
    })
    expect(out.strokeWeight).toBe(4)
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'stroke/weight-medium',
        field: 'strokeWeight',
      },
    ])
  })

  // A per-side stroke must NOT bind, for the reason a per-corner radius must
  // not (below): `setBoundVariable('strokeWeight')` sets ALL FOUR sides at once
  // — it reads back as four individualStrokeWeights entries aliasing one
  // variable — so the binding would square the tuple the literal just applied
  // and turn a bottom rule into a full box. Reachable the moment the reader
  // can emit `var(border/rule)stroke([0,0,1,0])` (B27).
  it('a var() per-side stroke keeps the four sides and drops the binding, with a warning', () => {
    const warnings: string[] = []
    const out = specToFigma(
      { stroke: 'var(border/rule)stroke([0,0,1,0])' },
      warnings,
    )
    expect(out.strokeWeights).toEqual([0, 0, 1, 0])
    expect(out.bindings).toBeUndefined()
    expect(warnings).toEqual([
      'var(border/rule) on a per-side stroke: a single binding cannot ' +
        'express per-side weights — literal applied unbound',
    ])
  })

  it('the same wrapper on a UNIFORM stroke still binds — only the tuple shape degrades', () => {
    const warnings: string[] = []
    const out = specToFigma(
      { stroke: 'var(border/rule)stroke(1)' },
      warnings,
    )
    expect(out.strokeWeight).toBe(1)
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'border/rule',
        field: 'strokeWeight',
      },
    ])
    expect(warnings).toEqual([])
  })

  it('a var() radius binds cornerRadius and still resolves to its number', () => {
    const out = specToFigma({
      radius: 'var(radius/medium)8',
    })
    expect(out.radius).toBe(8)
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'radius/medium',
        field: 'cornerRadius',
      },
    ])
  })

  // A per-corner radius must NOT bind: Figma has one cornerRadius field and
  // binding it sets all four corners (it reads back as rectangleCornerRadii ×4
  // — node-spec-reader's live-verified note), which would square the corners
  // the tuple says are different. The read already collapsed WHICH corner was
  // bound, so nothing faithful can be restored: geometry wins, loudly (T7).
  it('a var() per-corner radius keeps the four corners and drops the binding, with a warning', () => {
    const warnings: string[] = []
    const out = specToFigma(
      { radius: 'var(radius/medium)[8,8,0,0]' },
      warnings,
    )
    expect(out.radius).toEqual([8, 8, 0, 0])
    expect(out.bindings).toBeUndefined()
    expect(warnings).toEqual([
      'var(radius/medium) on a per-corner radius: a single binding cannot ' +
        'express per-corner values — literal applied unbound',
    ])
  })

  it('the same wrapper on a UNIFORM radius still binds — only the tuple shape degrades', () => {
    const warnings: string[] = []
    const out = specToFigma(
      { radius: 'var(radius/medium)8' },
      warnings,
    )
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'radius/medium',
        field: 'cornerRadius',
      },
    ])
    expect(warnings).toEqual([])
  })

  it("a var() text colour binds the text node's FIRST fill, never the whole array", () => {
    const out = specToFigma({
      text: {
        content: 'Hi',
        color: 'var(text/primary)#111827',
      },
    })
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'text/primary',
        field: 'fills',
        index: 0,
      },
    ])
  })

  it('text.color dedupes against an explicit fills[0] wrapper — one binding, not two', () => {
    const out = specToFigma({
      fills: ['var(text/primary)#111827'],
      text: {
        content: 'Hi',
        color: 'var(text/primary)#111827',
      },
    })
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'text/primary',
        field: 'fills',
        index: 0,
      },
    ])
  })
})

describe('write-face wrapper bindings — style()', () => {
  it('a style() fill binds the fill style once, not once per paint', () => {
    const out = specToFigma({
      fills: [
        'style(Brand/Primary)#FF00AA',
        'style(Brand/Primary)#FF00AA',
      ],
    })
    expect(out.bindings).toEqual([
      {
        kind: 'style',
        name: 'Brand/Primary',
        field: 'fill',
      },
    ])
  })

  it('a style() stroke paint binds the stroke style', () => {
    const out = specToFigma({
      strokes: ['style(Border/Subtle)#E5E7EB'],
    })
    expect(out.bindings).toEqual([
      {
        kind: 'style',
        name: 'Border/Subtle',
        field: 'stroke',
      },
    ])
  })

  it('a style() effect binds the effect style', () => {
    const out = specToFigma({
      effects: [
        'style(Elevation/1)shadow(0,4,12,#0000001A)',
      ],
    })
    expect(out.bindings).toEqual([
      {
        kind: 'style',
        name: 'Elevation/1',
        field: 'effect',
      },
    ])
  })

  it('a style() font binds the text style and still resolves the font', () => {
    const out = specToFigma({
      text: {
        content: 'Monthly report',
        font: 'style(Heading/H3)font(Inter,SemiBold,18){lh=24}',
      },
    })
    expect(
      (out.text as Record<string, unknown>).font,
    ).toEqual({
      family: 'Inter',
      style: 'SemiBold',
      size: 18,
    })
    expect(out.bindings).toEqual([
      {
        kind: 'style',
        name: 'Heading/H3',
        field: 'text',
      },
    ])
  })
})

describe('write-face wrapper bindings — degrades (T7)', () => {
  it('a wrapper on a field with no binding route warns and still writes the literal', () => {
    const warnings: string[] = []
    const out = specToFigma(
      {
        effects: ['var(shadow/lg)shadow(0,4,12,#0000001A)'],
      },
      warnings,
    )
    expect(out.bindings).toBeUndefined()
    expect(out.effects).toBeDefined()
    expect(warnings).toEqual([
      'var(shadow/lg) on effects: this surface has no binding route for that field — literal applied unbound',
    ])
  })

  it('one warning per distinct wrapper, however many atoms repeat it', () => {
    const warnings: string[] = []
    specToFigma(
      {
        effects: [
          'var(shadow/lg)shadow(0,4,12,#0000001A)',
          'var(shadow/lg)shadow(0,8,24,#0000001A)',
          'var(shadow/lg)shadow(0,1,2,#0000001A)',
        ],
      },
      warnings,
    )
    expect(warnings).toHaveLength(1)
  })

  it("a per-range run colour warns — the surface binds a node's fills, not a range", () => {
    const warnings: string[] = []
    specToFigma(
      {
        text: {
          content: 'Hi',
          runs: [
            {
              at: [0, 2],
              color: 'var(text/accent)#FF00AA',
            },
          ],
        },
      },
      warnings,
    )
    expect(warnings).toEqual([
      'var(text/accent) on text.runs[].color: this surface has no binding route for that field — literal applied unbound',
    ])
  })

  it('no wrapper anywhere emits no bindings key at all (pure-emit contract)', () => {
    const warnings: string[] = []
    const out = specToFigma(
      { fills: ['#FF0000'], radius: 8 },
      warnings,
    )
    expect('bindings' in out).toBe(false)
    expect(warnings).toEqual([])
  })

  it('a wrapper with no value is still an error (the literal always follows)', () => {
    expect(() =>
      specToFigma({ fills: ['var(surface/2)'] }),
    ).toThrow(/has no value/)
  })
})
