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

// ─── B44 — the layout spacing scalars bind too ────────────────────────────────
//
// The layout half was the residual of B21: `radiusAtom` was fixed and the
// spacing fields were never covered. Figma binds `itemSpacing`, the two grid
// gaps and each padding SIDE as independent node fields, so each carries its
// own wrapper and `pad` binds by POSITION.
describe('write-face wrapper bindings — layout (B44)', () => {
  it('a var() gap keeps the literal AND carries the binding', () => {
    const out = specToFigma({
      layout: { mode: 'H', gap: 'var(space/8)8' },
    })
    expect(out.layout).toEqual({ mode: 'H', spacing: 8 })
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'space/8',
        field: 'itemSpacing',
      },
    ])
  })

  it('pad binds per SIDE, by position; the unbound sides stay literal', () => {
    const out = specToFigma({
      layout: {
        mode: 'V',
        pad: ['var(space/8)8', 16, 'var(space/8)8', 16],
      },
    })
    expect(
      (out.layout as { padding: number[] }).padding,
    ).toEqual([8, 16, 8, 16])
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'space/8',
        field: 'paddingTop',
      },
      {
        kind: 'var',
        name: 'space/8',
        field: 'paddingBottom',
      },
    ])
  })

  it('binds the two GRID gaps by their own spellings', () => {
    const out = specToFigma({
      layout: {
        mode: 'GRID',
        rowGap: 'var(space/8)8',
        colGap: 'var(space/16)16',
      },
    })
    expect(out.layout).toEqual({
      mode: 'GRID',
      rowGap: 8,
      colGap: 16,
    })
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'space/8',
        field: 'gridRowGap',
      },
      {
        kind: 'var',
        name: 'space/16',
        field: 'gridColumnGap',
      },
    ])
  })

  it('a style() on a gap warns — a style cannot own one', () => {
    const warnings: string[] = []
    const out = specToFigma(
      { layout: { mode: 'H', gap: 'style(Spacing/8)8' } },
      warnings,
    )
    expect(out.layout).toEqual({ mode: 'H', spacing: 8 })
    expect(out.bindings).toBeUndefined()
    expect(warnings).toEqual([
      'style(Spacing/8) on layout.gap: this surface has no binding route for that field — literal applied unbound',
    ])
  })

  // A malformed atom has no literal half to fall back on, so it is refused
  // before the write leaves the server (the atomToStroke precedent, B38).
  // Passing NaN on crosses the wire as `null` and dies on Figma's validator.
  it('a gap that states no number is INVALID_PARAM', () => {
    for (const bad of [
      { mode: 'H' as const, gap: 'var(space/8)wide' },
      { mode: 'H' as const, gap: 'wide' },
      {
        mode: 'V' as const,
        pad: [8, 'var(space/8)huge', 8, 8] as [
          number,
          string,
          number,
          number,
        ],
      },
    ]) {
      let caught: { code?: string; message?: string } = {}
      try {
        specToFigma({ layout: bad })
      } catch (err) {
        caught = err as { code?: string; message?: string }
      }
      expect(caught.code).toBe('INVALID_PARAM')
      expect(caught.message).toContain('takes a number')
    }
  })
})

describe('write-face wrapper bindings — style()', () => {
  // A style OWNS its field, so the reference is one binding and NO literal:
  // assigning the field directly is what detaches the style. `owns`/`rideAlong`
  // are the server-side halves style-refs.ts resolves and then strips.
  it('a scalar fills reference binds the fill style and writes no paints', () => {
    const out = specToFigma({
      fills: 'style(Brand/Primary)[#FF00AA]',
    })
    expect('fills' in out).toBe(false)
    expect(out.bindings).toEqual([
      {
        kind: 'style',
        name: 'Brand/Primary',
        field: 'fill',
        owns: true,
        rideAlong: ['#FF00AA'],
      },
    ])
  })

  it('a style() stroke reference binds the stroke style and writes no paints', () => {
    const out = specToFigma({
      strokes: ['style(Border/Subtle)#E5E7EB'],
    })
    expect('strokes' in out).toBe(false)
    expect(out.bindings).toEqual([
      {
        kind: 'style',
        name: 'Border/Subtle',
        field: 'stroke',
        owns: true,
        rideAlong: ['#E5E7EB'],
      },
    ])
  })

  it('a style() effect reference binds the effect style and writes no effects', () => {
    const out = specToFigma({
      effects: [
        'style(Elevation/1)shadow(0,4,12,#0000001A)',
      ],
    })
    expect('effects' in out).toBe(false)
    expect(out.bindings).toEqual([
      {
        kind: 'style',
        name: 'Elevation/1',
        field: 'effect',
        owns: true,
        rideAlong: ['shadow(0,4,12,#0000001A)'],
      },
    ])
  })

  it('a style() grid reference binds the grid style (the fourth slot)', () => {
    const out = specToFigma({
      grids: 'style(Layout/12col)[columns(12,0,24)]',
    })
    expect('grids' in out).toBe(false)
    expect(out.bindings).toEqual([
      {
        kind: 'style',
        name: 'Layout/12col',
        field: 'grid',
        owns: true,
        rideAlong: ['columns(12,0,24)'],
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

// ---------------------------------------------------------------------------
// I59 — a gradient binds PER STOP
// ---------------------------------------------------------------------------
//
// A gradient's colours are per stop, and so are its tokens: a two-colour banner
// is two design-system decisions. The atom-level wrapper cannot express that —
// one wrapper on `linear(...)` claims a single variable owns both ends — so the
// stop is the one head argument that carries a wrapper of its own, and each one
// becomes its own binding on the same paint.
describe('write-face wrapper bindings — gradient stops (I59)', () => {
  it('carries one binding per bound stop, naming the paint and the stop', () => {
    const out = specToFigma({
      fills: [
        'linear(135, var(brand/violet)#7C3AED@0, var(brand/cyan)#22D3EE@100)',
      ],
    })
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'brand/violet',
        field: 'fills',
        index: 0,
        stop: 0,
      },
      {
        kind: 'var',
        name: 'brand/cyan',
        field: 'fills',
        index: 0,
        stop: 1,
      },
    ])
  })

  it('applies the literal colours unchanged — binding is additive', () => {
    const out = specToFigma({
      fills: [
        'linear(90, var(brand/violet)#7C3AED@0, #FFFFFF@100)',
      ],
    })
    const paint = (
      out.fills as {
        gradientStops: { position: number }[]
      }[]
    )[0]
    expect(paint.gradientStops).toHaveLength(2)
    expect(paint.gradientStops[0].position).toBe(0)
    expect(paint.gradientStops[1].position).toBe(1)
    // Only the stop that names a variable binds.
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'brand/violet',
        field: 'fills',
        index: 0,
        stop: 0,
      },
    ])
  })

  it('numbers the stops of a linear gradient past its ANGLE argument', () => {
    // `linear(135, …)` has the angle as arg 0; stop 0 is the first COLOUR.
    // Numbering from the argument list would bind the wrong end of every
    // linear gradient in the file.
    const out = specToFigma({
      fills: [
        'linear(135, #FFFFFF@0, var(brand/cyan)#22D3EE@100)',
      ],
    })
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'brand/cyan',
        field: 'fills',
        index: 0,
        stop: 1,
      },
    ])
  })

  it('binds a stop on a strokes gradient too, by paint index', () => {
    const out = specToFigma({
      strokes: [
        '#111111',
        'radial(var(surface/glow)#FFFFFF@0, #00000000@100)',
      ],
    })
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'surface/glow',
        field: 'strokes',
        index: 1,
        stop: 0,
      },
    ])
  })

  it('a paint-level wrapper and a stop wrapper are different bindings', () => {
    const out = specToFigma({
      fills: [
        'var(brand/base)#7C3AED',
        'linear(0, var(brand/violet)#7C3AED@0, #FFFFFF@100)',
      ],
    })
    expect(out.bindings).toEqual([
      {
        kind: 'var',
        name: 'brand/base',
        field: 'fills',
        index: 0,
      },
      {
        kind: 'var',
        name: 'brand/violet',
        field: 'fills',
        index: 1,
        stop: 0,
      },
    ])
  })

  it('an unbound gradient carries no bindings at all', () => {
    const out = specToFigma({
      fills: ['linear(135, #FF0000@0, #0000FF@100)'],
    })
    expect('bindings' in out).toBe(false)
  })
})
