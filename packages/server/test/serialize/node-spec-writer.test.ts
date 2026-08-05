// node-spec-writer.test.ts — specToFigma / specToFigmaForCreate
//
// Tests the NodeSpec → FigmaWritePayload converter. This is a PURE
// converter: it emits ONLY keys present in `spec`, never injecting
// defaults. The plugin's applyCommonProperties/applyTextProperties/
// applyPostAppendProperties read the flat payload keys.

import { describe, expect, it } from 'bun:test'
import {
  specToFigma,
  specToFigmaForCreate,
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

  it('var() wrapper is auto-dropped to the resolved literal', () => {
    const result = specToFigma({
      fills: ['var(Brand/Primary)#FF0000'],
    })
    expect(result).toEqual({
      fills: [
        { type: 'SOLID', color: { r: 1, g: 0, b: 0 } },
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

  it('per-side stroke weights collapse to the top side (strokeWeight)', () => {
    const result = specToFigma({
      stroke: 'stroke([2,0,2,0])',
    })
    expect(result).toMatchObject({ strokeWeight: 2 })
  })

  it('per-side stroke with DIFFERING sides pushes a collapse warning onto the sink', () => {
    const warnings: string[] = []
    specToFigma({ stroke: 'stroke([2,0,2,0])' }, warnings)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Per-side stroke')
    expect(warnings[0]).toContain('collapsed')
  })

  it('per-side stroke with EQUAL sides is a lossless collapse — no warning', () => {
    const warnings: string[] = []
    const result = specToFigma(
      { stroke: 'stroke([2,2,2,2])' },
      warnings,
    )
    expect(result).toMatchObject({ strokeWeight: 2 })
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
  it('strips a var() wrapper from a uniform radius', () => {
    expect(
      specToFigma({ radius: 'var(radius/medium)8' }),
    ).toEqual({ radius: 8 })
  })

  it('strips a var() wrapper from a per-corner radius', () => {
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
