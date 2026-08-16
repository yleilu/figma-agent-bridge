// node-spec-writer.test.ts — specToFigma / specToFigmaForCreate
//
// Tests the NodeSpec → FigmaWritePayload converter. `specToFigma` is a PURE
// converter: it emits ONLY keys present in `spec`, never injecting defaults.
// The CREATE wrappers (`specToFigmaForCreate`, `slotEntryToFigma`) are where
// the few creation defaults live — the `name ?? type` fallback and the frame
// layout default. The plugin's applyCommonProperties/applyTextProperties/
// applyPostAppendProperties read the flat payload keys.

import { describe, expect, it } from 'bun:test'
import {
  specToFigma,
  specToFigmaForCreate,
  slotEntryToFigma,
} from '@figma-agent-bridge/server/serialize/node-spec-writer'

// ─── omit-untouched (pure) ───────────────────────────────────────────────────

describe('specToFigma — pure, no defaults', () => {
  it('empty spec produces empty payload', () => {
    expect(specToFigma({})).toEqual({})
  })

  it('single scalar field is the only key emitted', () => {
    expect(specToFigma({ opacity: 0.5 })).toEqual({
      opacity: 0.5,
    })
  })
})

// ─── atom leaf conversions ────────────────────────────────────────────────────

describe('specToFigma — fills', () => {
  it('hex fill atom converts to SOLID paint', () => {
    const result = specToFigma({ fills: ['#FF0000'] })
    expect(result).toEqual({
      fills: [
        { type: 'SOLID', color: { r: 1, g: 0, b: 0 } },
      ],
    })
  })

  it('var() wrapper resolves to the literal AND carries its binding intent (I39)', () => {
    const result = specToFigma({
      fills: ['var(Brand/Primary)#FF0000'],
    })
    expect(result).toEqual({
      fills: [
        { type: 'SOLID', color: { r: 1, g: 0, b: 0 } },
      ],
      bindings: [
        {
          kind: 'var',
          name: 'Brand/Primary',
          field: 'fills',
          index: 0,
        },
      ],
    })
  })
})

describe('specToFigma — strokes (fill paints)', () => {
  it('hex stroke atom converts to SOLID paint', () => {
    const result = specToFigma({ strokes: ['#000000'] })
    expect(result).toHaveProperty('strokes')
    const strokes = result.strokes as unknown[]
    expect(strokes[0]).toMatchObject({ type: 'SOLID' })
  })
})

describe('specToFigma — stroke geometry', () => {
  it('stroke atom emits strokeWeight and strokeAlign', () => {
    const result = specToFigma({
      stroke: 'stroke(2){align=INSIDE}',
    })
    expect(result).toMatchObject({
      strokeWeight: 2,
      strokeAlign: 'INSIDE',
    })
  })

  it('stroke atom with dash emits strokeDash', () => {
    const result = specToFigma({
      stroke: 'stroke(2){align=INSIDE,dash=[4,2]}',
    })
    expect(result).toMatchObject({
      strokeWeight: 2,
      strokeAlign: 'INSIDE',
      strokeDash: [4, 2],
    })
  })

  // B27: per-side weights are APPLIED, not collapsed. The four sides ride the
  // payload as `strokeWeights` and the plugin assigns
  // strokeTopWeight/… (IndividualStrokesMixin). The writer cannot know the
  // target's node type, so it no longer warns here — the feature detection and
  // its warning live where the node is (T7).
  it('per-side stroke weights emit the four sides as strokeWeights', () => {
    const warnings: string[] = []
    const result = specToFigma(
      { stroke: 'stroke([0,0,1,0])' },
      warnings,
    )
    expect(result).toMatchObject({
      strokeWeights: [0, 0, 1, 0],
    })
    // No uniform weight beside it: one owner for the value, so nothing can
    // re-collapse the tuple after the fact.
    expect(result.strokeWeight).toBeUndefined()
    expect(warnings).toHaveLength(0)
  })

  // A five-entry list used to lose its fifth to a destructure and land as a
  // well-formed four-sided stroke — the caller asked for something this
  // surface does not have and was told nothing. Degrade WHOLE instead.
  it.each([
    ['stroke([1,2,3,4,5])', 5],
    ['stroke([1,2,3])', 3],
  ])('a %s tuple degrades whole, with a warning', atom => {
    const warnings: string[] = []
    const result = specToFigma({ stroke: atom }, warnings)
    expect(result.strokeWeights).toBeUndefined()
    expect(result.strokeWeight).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(
      'takes four weights [top,right,bottom,left]',
    )
  })

  it('a non-numeric side degrades whole rather than writing NaN', () => {
    const warnings: string[] = []
    const result = specToFigma(
      { stroke: 'stroke([1,x,1,0])' },
      warnings,
    )
    expect(result.strokeWeight).toBeUndefined()
    expect(result.strokeWeights).toBeUndefined()
    expect(warnings).toHaveLength(1)
  })

  it('per-side stroke with EQUAL sides emits the plain uniform weight', () => {
    const warnings: string[] = []
    const result = specToFigma(
      { stroke: 'stroke([2,2,2,2])' },
      warnings,
    )
    expect(result).toMatchObject({ strokeWeight: 2 })
    expect(result.strokeWeights).toBeUndefined()
    expect(warnings).toHaveLength(0)
  })

  it('omitting the warnings sink keeps the exact same payload (pure converter)', () => {
    expect(
      specToFigma({ stroke: 'stroke([2,0,2,0])' }),
    ).toEqual(
      specToFigma({ stroke: 'stroke([2,0,2,0])' }, []),
    )
  })
})

describe('specToFigma — effects', () => {
  it('shadow effect atom converts to DROP_SHADOW', () => {
    const result = specToFigma({
      effects: ['shadow(0,2,4,#000000)'],
    })
    expect(result).toHaveProperty('effects')
    const effects = result.effects as { type: string }[]
    expect(effects[0].type).toBe('DROP_SHADOW')
  })
})

describe('specToFigma — radius', () => {
  // Regression (d76be0d): that commit taught the reader to emit binding
  // wrappers — `var(radius/medium)8` — on radius among other fields. Every
  // other wrapped atom is stripped inside parseAtom, but radius is parsed by
  // hand, so Number('var(radius/medium)8') was NaN → JSON null on the wire,
  // which Figma rejects ("Expected number, received null", verified live). A
  // read-modify-write on any token-bound node failed outright — precisely the
  // design-system workflow T9 exists to encourage.
  it('resolves a var()-wrapped uniform radius to its number (and binds it — I39)', () => {
    expect(
      specToFigma({ radius: 'var(radius/medium)8' }),
    ).toEqual({
      radius: 8,
      bindings: [
        {
          kind: 'var',
          name: 'radius/medium',
          field: 'cornerRadius',
        },
      ],
    })
  })

  // A per-corner radius keeps the old strip-behaviour on purpose: Figma's one
  // cornerRadius binding covers all four corners, so binding here would square
  // the corners this tuple says are different (I39 — the loss is warned about).
  it('resolves a var()-wrapped per-corner radius to its tuple, unbound', () => {
    expect(
      specToFigma({
        radius: 'var(radius/medium)[8,8,0,0]',
      }),
    ).toEqual({ radius: [8, 8, 0, 0] })
  })

  it('uniform radius string converts to number', () => {
    expect(specToFigma({ radius: '8' })).toEqual({
      radius: 8,
    })
  })

  it('corner-tuple radius string converts to number array', () => {
    expect(specToFigma({ radius: '[8,8,0,0]' })).toEqual({
      radius: [8, 8, 0, 0],
    })
  })

  it('bare number radius is accepted (no s.trim crash)', () => {
    expect(specToFigma({ radius: 12 })).toEqual({
      radius: 12,
    })
  })
})

describe('specToFigma — blend', () => {
  it('blend renames to blendMode', () => {
    expect(specToFigma({ blend: 'MULTIPLY' })).toEqual({
      blendMode: 'MULTIPLY',
    })
  })
})

describe('specToFigma — layout', () => {
  it('layout spec maps gap→spacing, pad→padding, mode/align pass-through', () => {
    const result = specToFigma({
      layout: {
        mode: 'V',
        gap: 8,
        pad: [4, 4, 4, 4],
        align: ['MIN', 'MIN'],
      },
    })
    expect(result).toHaveProperty('layout')
    const layout = result.layout as Record<string, unknown>
    expect(layout.mode).toBe('V')
    expect(layout.spacing).toBe(8)
    expect(layout.padding).toEqual([4, 4, 4, 4])
    expect(layout.align).toEqual(['MIN', 'MIN'])
  })

  it('layout with wrap passes wrap through', () => {
    const result = specToFigma({
      layout: { mode: 'H', wrap: true },
    })
    const layout = result.layout as Record<string, unknown>
    expect(layout.wrap).toBe(true)
  })

  it('GRID mode passes mode through', () => {
    const result = specToFigma({ layout: { mode: 'GRID' } })
    const layout = result.layout as Record<string, unknown>
    expect(layout.mode).toBe('GRID')
  })

  it('GRID mode with all grid keys emits rows/cols/rowGap/colGap', () => {
    const result = specToFigma({
      layout: {
        mode: 'GRID',
        rows: 2,
        cols: 3,
        rowGap: 8,
        colGap: 12,
      },
    })
    const layout = result.layout as Record<string, unknown>
    expect(layout.mode).toBe('GRID')
    expect(layout.rows).toBe(2)
    expect(layout.cols).toBe(3)
    expect(layout.rowGap).toBe(8)
    expect(layout.colGap).toBe(12)
  })

  it('partial GRID (rows+rowGap only) emits only present keys', () => {
    const result = specToFigma({
      layout: { mode: 'GRID', rows: 4, rowGap: 16 },
    })
    const layout = result.layout as Record<string, unknown>
    expect(layout.rows).toBe(4)
    expect(layout.rowGap).toBe(16)
    expect('cols' in layout).toBe(false)
    expect('colGap' in layout).toBe(false)
  })

  it('non-GRID mode with grid keys emits a warning', () => {
    const warnings: string[] = []
    specToFigma(
      { layout: { mode: 'H', rows: 2 } as never },
      warnings,
    )
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toMatch(/rows|GRID/i)
  })
})

describe('specToFigma — text', () => {
  it('text.font atom converts to parsed font object', () => {
    const result = specToFigma({
      text: { content: 'Hi', font: 'font(Inter,Bold,32)' },
    })
    expect(result).toHaveProperty('text')
    const text = result.text as Record<string, unknown>
    expect(text.font).toEqual({
      family: 'Inter',
      style: 'Bold',
      size: 32,
    })
    expect(text.content).toBe('Hi')
  })

  it('text.color atom converts to paint', () => {
    const result = specToFigma({
      text: {
        content: 'Hi',
        font: 'font(Inter,Regular,16)',
        color: '#000000',
      },
    })
    const text = result.text as Record<string, unknown>
    expect(text.color).toMatchObject({ type: 'SOLID' })
  })

  it('lifts lh/ls from the font atom into text.lineHeight/text.letterSpacing ({value,unit})', () => {
    const result = specToFigma({
      text: {
        content: 'Hi',
        font: 'font(Inter,SemiBold,18){lh=24,ls=0.5}',
      },
    })
    const text = result.text as Record<string, unknown>
    // Font object carries family/style/size only — lh/ls are lifted out.
    expect(text.font).toEqual({
      family: 'Inter',
      style: 'SemiBold',
      size: 18,
    })
    // Plugin reads text.lineHeight / text.letterSpacing as {value, unit}.
    expect(text.lineHeight).toEqual({
      value: 24,
      unit: 'PIXELS',
    })
    expect(text.letterSpacing).toEqual({
      value: 0.5,
      unit: 'PIXELS',
    })
  })

  it('lifts a percent line-height from the font atom', () => {
    const result = specToFigma({
      text: {
        content: 'Hi',
        font: 'font(Inter,Regular,16){lh=150%}',
      },
    })
    const text = result.text as Record<string, unknown>
    expect(text.lineHeight).toEqual({
      value: 150,
      unit: 'PERCENT',
    })
  })

  it('omits lineHeight/letterSpacing when the font atom has none', () => {
    const result = specToFigma({
      text: {
        content: 'Hi',
        font: 'font(Inter,Regular,16)',
      },
    })
    const text = result.text as Record<string, unknown>
    expect(text.lineHeight).toBeUndefined()
    expect(text.letterSpacing).toBeUndefined()
    expect(text).not.toHaveProperty('lh')
    expect(text).not.toHaveProperty('ls')
  })

  // A PARTIAL text patch is the whole point of a patch: `{text:{content}}`
  // renames the copy and leaves the type alone. `font` was converted
  // UNCONDITIONALLY whenever `text` was present, while every sibling field was
  // guarded — so the partial patch died in the converter with
  // "undefined is not an object (evaluating 'raw.trim')".
  it('accepts a text patch with NO font — content only', () => {
    const result = specToFigma({
      text: { content: 'Updated copy' },
    })
    const text = result.text as Record<string, unknown>
    expect(text.content).toBe('Updated copy')
    // Nothing about the font is asserted downstream: omitted means untouched.
    expect(text).not.toHaveProperty('font')
    expect(text).not.toHaveProperty('lineHeight')
    expect(text).not.toHaveProperty('letterSpacing')
  })

  it('accepts a text patch with NO content — a font/colour-only restyle', () => {
    const result = specToFigma({
      text: {
        font: 'font(Inter,Bold,32)',
        color: '#FF0000',
      },
    })
    const text = result.text as Record<string, unknown>
    expect(text).not.toHaveProperty('content')
    expect(text.font).toEqual({
      family: 'Inter',
      style: 'Bold',
      size: 32,
    })
    expect(text.color).toMatchObject({ type: 'SOLID' })
  })

  it('lifts lh/ls on per-range runs as well', () => {
    const result = specToFigma({
      text: {
        content: 'Hi there',
        font: 'font(Inter,Regular,16)',
        runs: [
          {
            at: [0, 2],
            font: 'font(Inter,Bold,16){lh=20}',
          },
        ],
      },
    })
    const text = result.text as Record<string, unknown>
    const runs = text.runs as Record<string, unknown>[]
    expect(runs[0].font).toEqual({
      family: 'Inter',
      style: 'Bold',
      size: 16,
    })
    expect(runs[0].lineHeight).toEqual({
      value: 20,
      unit: 'PIXELS',
    })
  })
})

describe('specToFigma — grids', () => {
  it('grid atoms convert via atomToGrid', () => {
    const result = specToFigma({
      grids: ['columns(12,60,16)'],
    })
    expect(result).toHaveProperty('grids')
    const grids = result.grids as { pattern: string }[]
    expect(grids[0].pattern).toBe('COLUMNS')
  })
})

// ─── pass-through fields ──────────────────────────────────────────────────────

describe('specToFigma — pass-through fields', () => {
  it('name passes through', () => {
    expect(specToFigma({ name: 'Card' })).toEqual({
      name: 'Card',
    })
  })

  it('size passes through', () => {
    expect(specToFigma({ size: [200, 100] })).toEqual({
      size: [200, 100],
    })
  })

  it('position passes through', () => {
    expect(specToFigma({ position: [10, 20] })).toEqual({
      position: [10, 20],
    })
  })

  it('opacity passes through', () => {
    expect(specToFigma({ opacity: 0.8 })).toEqual({
      opacity: 0.8,
    })
  })

  it('rotation passes through', () => {
    expect(specToFigma({ rotation: 45 })).toEqual({
      rotation: 45,
    })
  })

  it('visible passes through', () => {
    expect(specToFigma({ visible: false })).toEqual({
      visible: false,
    })
  })

  it('clipsContent passes through', () => {
    expect(specToFigma({ clipsContent: true })).toEqual({
      clipsContent: true,
    })
  })

  it('sizing passes through', () => {
    expect(
      specToFigma({ sizing: ['HUG', 'FIXED'] }),
    ).toEqual({
      sizing: ['HUG', 'FIXED'],
    })
  })

  it('layoutPositioning passes through', () => {
    expect(
      specToFigma({ layoutPositioning: 'ABSOLUTE' }),
    ).toEqual({
      layoutPositioning: 'ABSOLUTE',
    })
  })

  it('minWidth/maxWidth/minHeight/maxHeight pass through', () => {
    expect(
      specToFigma({
        minWidth: 100,
        maxWidth: 400,
        minHeight: 50,
        maxHeight: null,
      }),
    ).toEqual({
      minWidth: 100,
      maxWidth: 400,
      minHeight: 50,
      maxHeight: null,
    })
  })

  it('constraints passes through', () => {
    expect(
      specToFigma({ constraints: ['MIN', 'CENTER'] }),
    ).toEqual({ constraints: ['MIN', 'CENTER'] })
  })

  it('constraints [MIN,STRETCH] passes through as the array', () => {
    expect(
      specToFigma({ constraints: ['MIN', 'STRETCH'] }),
    ).toEqual({ constraints: ['MIN', 'STRETCH'] })
  })

  it('component by local id passes through (INSTANCE by-id path)', () => {
    expect(
      specToFigma({ component: { id: '2:10' } }),
    ).toEqual({ component: { id: '2:10' } })
  })

  it('component by published key passes through (INSTANCE by-key path)', () => {
    expect(
      specToFigma({ component: { key: 'btn-key-123' } }),
    ).toEqual({ component: { key: 'btn-key-123' } })
  })

  it('component with properties passes through verbatim (exact keys; #11 resolver out of scope)', () => {
    expect(
      specToFigma({
        component: {
          id: '2:10',
          properties: { Label: 'Save', Disabled: false },
        },
      }),
    ).toEqual({
      component: {
        id: '2:10',
        properties: { Label: 'Save', Disabled: false },
      },
    })
  })

  // M14: component.remote is a read-emitted hint that must pass through the
  // writer so the plugin's INSTANCE create path can prefer key-import when remote.
  it('component.remote:true passes through the writer (M14 remote hint)', () => {
    expect(
      specToFigma({
        component: {
          id: '2:12',
          key: 'lib-btn-key',
          remote: true,
        },
      }),
    ).toEqual({
      component: {
        id: '2:12',
        key: 'lib-btn-key',
        remote: true,
      },
    })
  })

  it('passes context through unchanged (round-trip)', () => {
    expect(
      specToFigma({
        context: '---\npurpose: x\n---\n',
      } as never),
    ).toMatchObject({ context: '---\npurpose: x\n---\n' })
    expect(specToFigma({} as never).context).toBeUndefined()
  })
})

// ─── specToFigmaForCreate ─────────────────────────────────────────────────────

describe('specToFigmaForCreate', () => {
  it('carries the type discriminator through (plugin createSingleNode switches on it)', () => {
    // specToFigma is a property-patch converter and never emits `type`; the
    // CREATE wrapper must add it back or the plugin cannot pick the node kind.
    const result = specToFigmaForCreate({ type: 'ELLIPSE' })
    expect(result.type).toBe('ELLIPSE')
  })

  it('uses type as name fallback when name is absent', () => {
    const result = specToFigmaForCreate({ type: 'FRAME' })
    expect(result.name).toBe('FRAME')
  })

  it('preserves explicit name when present', () => {
    const result = specToFigmaForCreate({
      type: 'FRAME',
      name: 'Card',
    })
    expect(result.name).toBe('Card')
  })

  it('still converts atoms (e.g. fills)', () => {
    const result = specToFigmaForCreate({
      type: 'RECTANGLE',
      fills: ['#FF0000'],
    })
    expect(result).toHaveProperty('fills')
    const fills = result.fills as { type: string }[]
    expect(fills[0].type).toBe('SOLID')
  })
})

// ─── creation layout default (B29) ────────────────────────────────────────────
//
// A created FRAME stacks. The default fills a SILENCE only: any layout the spec
// states — `NONE` included — is what the plugin receives.

describe('specToFigmaForCreate — creation layout default', () => {
  it('a FRAME that states no layout is created as a vertical stack', () => {
    expect(
      specToFigmaForCreate({ type: 'FRAME' }).layout,
    ).toEqual({ mode: 'V' })
  })

  it('an explicit layout passes through untouched', () => {
    expect(
      specToFigmaForCreate({
        type: 'FRAME',
        layout: { mode: 'H', gap: 8 },
      }).layout,
    ).toEqual({ mode: 'H', spacing: 8 })
  })

  it('layout NONE is the opt-out — absolute, not the default', () => {
    expect(
      specToFigmaForCreate({
        type: 'FRAME',
        layout: { mode: 'NONE' },
      }).layout,
    ).toEqual({ mode: 'NONE' })
  })

  it('a SLOT asked for by create_node takes the same default', () => {
    expect(
      specToFigmaForCreate({ type: 'SLOT' }).layout,
    ).toEqual({ mode: 'V' })
  })

  it('every other node type is untouched', () => {
    for (const type of [
      'TEXT',
      'RECTANGLE',
      'ELLIPSE',
      'LINE',
      'POLYGON',
      'STAR',
      'VECTOR',
      'SECTION',
      'SLICE',
      'INSTANCE',
    ] as const) {
      expect(
        specToFigmaForCreate({ type }).layout,
      ).toBeUndefined()
    }
  })

  it('the default is creation-only — the patch converter still injects nothing', () => {
    // update_node's omitted `layout` means "leave untouched", and an existing
    // absolute frame must never be converted behind the agent's back.
    expect(
      specToFigma({ type: 'FRAME' } as never).layout,
    ).toBeUndefined()
  })

  it('each create gets its own layout object (no shared mutable default)', () => {
    const a = specToFigmaForCreate({ type: 'FRAME' })
    const b = specToFigmaForCreate({ type: 'FRAME' })
    expect(a.layout).not.toBe(b.layout)
  })
})

// ─── the injected layout pins a stated size (B29) ─────────────────────────────
//
// Figma's auto-layout hugs by default, so the injected layout would otherwise
// SHRINK a frame that stated its size — live: a FRAME created at [300,200] with
// one child read back [300,30], sizing ["FIXED","HUG"]. The default may add an
// arrangement; it may not discard a field the caller stated.

describe('specToFigmaForCreate — the default never shrinks a sized frame', () => {
  it('a stated size with no sizing is pinned FIXED', () => {
    const out = specToFigmaForCreate({
      type: 'FRAME',
      size: [300, 200],
    })
    expect(out.layout).toEqual({ mode: 'V' })
    expect(out.sizing).toEqual(['FIXED', 'FIXED'])
  })

  it('an explicit sizing is left alone — the caller already answered', () => {
    expect(
      specToFigmaForCreate({
        type: 'FRAME',
        size: [300, 200],
        sizing: ['FILL', 'HUG'],
      }).sizing,
    ).toEqual(['FILL', 'HUG'])
  })

  it('no size stated, no sizing invented — hug is right for a container that named no height', () => {
    const out = specToFigmaForCreate({ type: 'FRAME' })
    expect(out.layout).toEqual({ mode: 'V' })
    expect(out.sizing).toBeUndefined()
  })

  it('an explicit layout owns its own sizing — nothing is pinned', () => {
    const out = specToFigmaForCreate({
      type: 'FRAME',
      size: [300, 200],
      layout: { mode: 'H' },
    })
    expect(out.layout).toEqual({ mode: 'H' })
    expect(out.sizing).toBeUndefined()
  })

  it('mode NONE stays absolute — no layout injected, so no sizing either', () => {
    const out = specToFigmaForCreate({
      type: 'FRAME',
      size: [300, 200],
      layout: { mode: 'NONE' },
    })
    expect(out.layout).toEqual({ mode: 'NONE' })
    expect(out.sizing).toBeUndefined()
  })

  it('a non-frame type takes neither half of the default', () => {
    const out = specToFigmaForCreate({
      type: 'RECTANGLE',
      size: [300, 200],
    })
    expect(out.layout).toBeUndefined()
    expect(out.sizing).toBeUndefined()
  })
})

// ─── slotEntryToFigma ────────────────────────────────────────────────────────

describe('slotEntryToFigma — creation layout default', () => {
  it('an entry that states no layout is created as a vertical stack', () => {
    expect(
      slotEntryToFigma({ name: 'Body', fills: ['#FFF'] }),
    ).toMatchObject({
      name: 'Body',
      layout: { mode: 'V' },
    })
  })

  it('a bare name is exactly {name} — and takes the same default', () => {
    expect(slotEntryToFigma('Body')).toEqual({
      name: 'Body',
      layout: { mode: 'V' },
    })
  })

  it('an explicit layout passes through untouched', () => {
    expect(
      slotEntryToFigma({
        name: 'Row',
        layout: { mode: 'H', gap: 12 },
      }).layout,
    ).toEqual({ mode: 'H', spacing: 12 })
  })

  it('layout NONE is the opt-out here too', () => {
    expect(
      slotEntryToFigma({
        name: 'Free',
        layout: { mode: 'NONE' },
      }).layout,
    ).toEqual({ mode: 'NONE' })
  })

  it('a stated size is pinned FIXED, on the same terms as a frame', () => {
    const out = slotEntryToFigma({
      name: 'Body',
      size: [320, 480],
    })
    expect(out.layout).toEqual({ mode: 'V' })
    expect(out.sizing).toEqual(['FIXED', 'FIXED'])
  })

  it('a stated sizing is left alone', () => {
    expect(
      slotEntryToFigma({
        name: 'Body',
        size: [320, 480],
        sizing: ['FILL', 'FILL'],
      }).sizing,
    ).toEqual(['FILL', 'FILL'])
  })

  it('an entry that states its own layout owns its sizing too', () => {
    const out = slotEntryToFigma({
      name: 'Row',
      size: [320, 48],
      layout: { mode: 'H' },
    })
    expect(out.sizing).toBeUndefined()
  })

  it('a bare name states no size, so nothing is pinned', () => {
    expect(slotEntryToFigma('Body').sizing).toBeUndefined()
  })
})

// ─── vectorPaths ─────────────────────────────────────────────────────────────

describe('specToFigma — vectorPaths', () => {
  it('converts path atoms to FigmaVectorPath objects', () => {
    const result = specToFigma({
      vectorPaths: ['path(EVENODD,"M0 0 L10 0 Z")'],
    })
    expect(result).toHaveProperty('vectorPaths')
    const vp = result.vectorPaths as {
      windingRule: string
      data: string
    }[]
    expect(vp[0].windingRule).toBe('EVENODD')
    expect(vp[0].data).toBe('M0 0 L10 0 Z')
  })

  it('converts multiple path atoms', () => {
    const result = specToFigma({
      vectorPaths: [
        'path(NONZERO,"M0 0 L10 0 Z")',
        'path(EVENODD,"M0 0 L5 8 Z")',
      ],
    })
    const vp = result.vectorPaths as {
      windingRule: string
      data: string
    }[]
    expect(vp).toHaveLength(2)
    expect(vp[0].windingRule).toBe('NONZERO')
    expect(vp[1].windingRule).toBe('EVENODD')
  })

  it('omits vectorPaths when absent from spec', () => {
    const result = specToFigma({ type: 'VECTOR' } as never)
    expect(result.vectorPaths).toBeUndefined()
  })

  // B45: the entry that does not parse takes the WHOLE write down, before any
  // payload exists. It used to convert to an empty data string, which Figma
  // accepted and drew as nothing.
  it('rejects a fill-rule-less entry as INVALID_PARAM, converting nothing', () => {
    try {
      specToFigma({
        vectorPaths: [
          'path(NONZERO,"M0 0 L10 0 Z")',
          'path(M 12 0 L 24 24 Z)',
        ],
      })
      throw new Error('expected the write to be rejected')
    } catch (err) {
      expect((err as { code?: string }).code).toBe(
        'INVALID_PARAM',
      )
    }
  })
})

// ─── pointCount / innerRadius / sectionContentsHidden (plain pass-through) ───

describe('specToFigma — pointCount', () => {
  it('emits pointCount as-is when set', () => {
    const result = specToFigma({ pointCount: 6 } as never)
    expect(result.pointCount).toBe(6)
  })

  it('omits pointCount when absent from spec', () => {
    const result = specToFigma({ type: 'POLYGON' } as never)
    expect(result.pointCount).toBeUndefined()
  })
})

describe('specToFigma — innerRadius', () => {
  it('emits innerRadius as-is when set', () => {
    const result = specToFigma({
      innerRadius: 0.4,
    } as never)
    expect(result.innerRadius).toBe(0.4)
  })

  it('omits innerRadius when absent from spec', () => {
    const result = specToFigma({ type: 'STAR' } as never)
    expect(result.innerRadius).toBeUndefined()
  })
})

describe('specToFigma — sectionContentsHidden', () => {
  it('emits sectionContentsHidden as-is when set to true', () => {
    const result = specToFigma({
      sectionContentsHidden: true,
    } as never)
    expect(result.sectionContentsHidden).toBe(true)
  })

  it('emits sectionContentsHidden=false when set to false', () => {
    const result = specToFigma({
      sectionContentsHidden: false,
    } as never)
    expect(result.sectionContentsHidden).toBe(false)
  })

  it('omits sectionContentsHidden when absent from spec', () => {
    const result = specToFigma({ type: 'SECTION' } as never)
    expect(result.sectionContentsHidden).toBeUndefined()
  })
})
