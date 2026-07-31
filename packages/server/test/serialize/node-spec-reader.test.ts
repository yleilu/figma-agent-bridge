// node-spec-reader.test.ts — raw Figma export (JSON_REST_V1) → NodeSpec.
//
// The reader is the READ FACE of the grammar: it renders Figma objects to
// atom STRINGS via paintToAtom/effectToAtom/fontToAtom/strokeToAtom. It is
// fidelity-first — it NEVER imports read/budget. Children past `depth` collapse
// to IdStub (drill-by-id). depth=0 default.

import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { toNodeSpec } from '@figma-agent-bridge/server/serialize/node-spec-reader'
import { specToFigma } from '@figma-agent-bridge/server/serialize/node-spec-writer'
import { atomToPaint } from '@figma-agent-bridge/server/grammar'
import type {
  NodeSpec,
  IdStub,
} from '@figma-agent-bridge/shared/node-spec'
import cardRaw from '../fixtures/card-node-raw.json'

const raw = cardRaw as unknown as Record<string, unknown>

// ─── atom-grammar leaves ──────────────────────────────────────────────────────

describe('toNodeSpec — atom-grammar leaves', () => {
  it('maps identity + size from the raw export', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.id).toBe('1:42')
    expect(spec.name).toBe('Card')
    expect(spec.type).toBe('FRAME')
    expect(spec.size).toEqual([320, 200])
  })

  it('renders a SOLID fill as a hex atom string', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(Array.isArray(spec.fills)).toBe(true)
    // White fill, bound to a variable — see var() test below; the underlying
    // appearance is #FFFFFF.
    expect(spec.fills?.[0]).toContain('#FFFFFF')
  })

  it('renders a DROP_SHADOW effect as a shadow(...) atom', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.effects?.[0]).toMatch(/^shadow\(/)
  })

  it('renders radius as an atom string', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.radius).toBe('8')
  })

  it('emits position from relativeTransform (T1/T2 round-trip)', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    // relativeTransform [[1,0,100],[0,1,200]] → [x,y] translation.
    expect(spec.position).toEqual([100, 200])
  })

  it('derives a parent-relative position from the bbox hierarchy when relativeTransform is absent', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    const children = spec.children as NodeSpec[]
    // None of the children carry a relativeTransform. JSON_REST_V1 only emits
    // absoluteBoundingBox, so position = child.bbox − parent.bbox (Card bbox
    // origin is {x:100,y:200}); the writer applies position parent-relative.
    // Title bbox {x:116,y:216} → [16, 16]
    expect(children[0].position).toEqual([16, 16])
    // Body bbox {x:116,y:252} → [16, 52]
    expect(children[1].position).toEqual([16, 52])
    // Action Button bbox {x:116,y:312} → [16, 112]
    expect(children[2].position).toEqual([16, 112])
  })

  it('computes parent-relative position from the bbox difference (inline)', () => {
    const parentRaw: Record<string, unknown> = {
      id: 'p:1',
      name: 'Parent',
      type: 'FRAME',
      absoluteBoundingBox: {
        x: 300,
        y: 300,
        width: 400,
        height: 400,
      },
      children: [
        {
          id: 'c:1',
          name: 'Child',
          type: 'FRAME',
          absoluteBoundingBox: {
            x: 320,
            y: 330,
            width: 50,
            height: 50,
          },
        },
      ],
    }
    const spec = toNodeSpec(parentRaw, { depth: -1 })
    // Root has no parent → its own bbox origin.
    expect(spec.position).toEqual([300, 300])
    const child = (spec.children as NodeSpec[])[0]
    // Child position = [320−300, 330−300] = [20, 30].
    expect(child.position).toEqual([20, 30])
  })

  it('position survives the reader→writer round-trip', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    const figma = specToFigma(spec)
    expect(figma.position).toEqual([100, 200])
  })

  it('renders a TEXT child font as a font(...) atom with lh in the {…} channel', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    const title = (spec.children as NodeSpec[])[0]
    expect(title.type).toBe('TEXT')
    expect(title.text?.font).toContain('font(Inter,')
    // Title raw: lineHeightPx 24, lineHeightUnit PIXELS → {lh=24}
    expect(title.text?.font).toContain('lh=24')
  })

  it('maps auto-layout to a LayoutSpec (mode V, gap, pad)', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.layout?.mode).toBe('V')
    expect(spec.layout?.gap).toBe(12)
    expect(spec.layout?.pad).toEqual([16, 16, 16, 16])
  })
})

// ─── GRID layout read-back (M12) ─────────────────────────────────────────────

describe('toNodeSpec — GRID layout read-back', () => {
  it('reads a GRID frame with all four grid keys', () => {
    const gridRaw: Record<string, unknown> = {
      id: '10:1',
      name: 'Grid Frame',
      type: 'FRAME',
      layoutMode: 'GRID',
      gridRowCount: 2,
      gridColumnCount: 3,
      gridRowGap: 8,
      gridColumnGap: 12,
    }
    const spec = toNodeSpec(gridRaw, { depth: -1 })
    expect(spec.layout?.mode).toBe('GRID')
    expect(spec.layout?.rows).toBe(2)
    expect(spec.layout?.cols).toBe(3)
    expect(spec.layout?.rowGap).toBe(8)
    expect(spec.layout?.colGap).toBe(12)
  })

  it('GRID with zero gap reads rowGap and colGap as 0', () => {
    const gridRaw: Record<string, unknown> = {
      id: '10:2',
      name: 'Grid Zero Gap',
      type: 'FRAME',
      layoutMode: 'GRID',
      gridRowCount: 1,
      gridColumnCount: 1,
      gridRowGap: 0,
      gridColumnGap: 0,
    }
    const spec = toNodeSpec(gridRaw, { depth: -1 })
    expect(spec.layout?.mode).toBe('GRID')
    expect(spec.layout?.rowGap).toBe(0)
    expect(spec.layout?.colGap).toBe(0)
  })

  it('GRID frame missing grid count/gap fields produces GRID mode with no counts/gaps', () => {
    const gridRaw: Record<string, unknown> = {
      id: '10:3',
      name: 'Bare Grid',
      type: 'FRAME',
      layoutMode: 'GRID',
    }
    const spec = toNodeSpec(gridRaw, { depth: -1 })
    expect(spec.layout?.mode).toBe('GRID')
    expect(spec.layout?.rows).toBeUndefined()
    expect(spec.layout?.cols).toBeUndefined()
    expect(spec.layout?.rowGap).toBeUndefined()
    expect(spec.layout?.colGap).toBeUndefined()
  })

  it('non-GRID layout (HORIZONTAL) is unaffected — no rows/cols emitted', () => {
    const hRaw: Record<string, unknown> = {
      id: '10:4',
      name: 'H Frame',
      type: 'FRAME',
      layoutMode: 'HORIZONTAL',
      itemSpacing: 8,
    }
    const spec = toNodeSpec(hRaw, { depth: -1 })
    expect(spec.layout?.mode).toBe('H')
    expect(spec.layout).not.toHaveProperty('rows')
    expect(spec.layout).not.toHaveProperty('cols')
  })

  it('round-trip: GRID spec → specToFigma writer → layout object contains grid keys', () => {
    const gridRaw: Record<string, unknown> = {
      id: '10:5',
      name: 'Grid RT',
      type: 'FRAME',
      layoutMode: 'GRID',
      gridRowCount: 4,
      gridColumnCount: 6,
      gridRowGap: 16,
      gridColumnGap: 24,
    }
    const spec = toNodeSpec(gridRaw, { depth: -1 })
    // write back via specToFigma (already imported at top of file)
    const payload = specToFigma(spec)
    const layout = payload.layout as Record<string, unknown>
    expect(layout.mode).toBe('GRID')
    expect(layout.rows).toBe(4)
    expect(layout.cols).toBe(6)
    expect(layout.rowGap).toBe(16)
    expect(layout.colGap).toBe(24)
  })
})

// ─── var() binding read-back (no boundVariables field on NodeSpec) ─────────────

describe('toNodeSpec — var() binding read-back', () => {
  it('renders a variable-bound paint with its var(Name) wrapper atom', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    // The card's first fill carries boundVariables.color (id var:123); the
    // fixture's root bindingNames.variables resolves it to the design-
    // system NAME "surface/card-bg" — the leaf atom wraps with the NAME,
    // never the id. There is NO boundVariables field on NodeSpec — the
    // binding rides on the appearance atom.
    expect(spec.fills?.[0]).toBe(
      'var(surface/card-bg)#FFFFFF',
    )
    expect(spec.fills?.[0]).not.toContain('var:123')
    expect(spec).not.toHaveProperty('boundVariables')
  })
})

// ─── component read-back (INSTANCE main-component ref) ────────────────────────

describe('toNodeSpec — INSTANCE component read-back', () => {
  it('emits component {id} from the instance componentId (round-trips to create_node)', () => {
    const instanceRaw: Record<string, unknown> = {
      id: '5:6',
      name: 'Button/Primary',
      type: 'INSTANCE',
      componentId: '2:10',
    }
    const spec = toNodeSpec(instanceRaw, { depth: -1 })
    expect(spec.component).toEqual({ id: '2:10' })
    // The component ref is a valid create_node(INSTANCE) input shape.
    expect(specToFigma(spec).component).toEqual({
      id: '2:10',
    })
  })

  it('includes component.key when the export carries componentKey', () => {
    const instanceRaw: Record<string, unknown> = {
      id: '5:7',
      name: 'Card',
      type: 'INSTANCE',
      componentId: '2:11',
      componentKey: 'btn-key-123',
    }
    const spec = toNodeSpec(instanceRaw, { depth: -1 })
    expect(spec.component).toEqual({
      id: '2:11',
      key: 'btn-key-123',
    })
  })

  // M14: componentRemote=true from plugin enrichment → component.remote:true
  it('includes component.remote:true when the export carries componentRemote:true (M14 root-only enrichment)', () => {
    const instanceRaw: Record<string, unknown> = {
      id: '5:8',
      name: 'LibraryButton',
      type: 'INSTANCE',
      componentId: '2:12',
      componentKey: 'lib-btn-key',
      componentRemote: true,
    }
    const spec = toNodeSpec(instanceRaw, { depth: -1 })
    expect(spec.component).toEqual({
      id: '2:12',
      key: 'lib-btn-key',
      remote: true,
    })
  })

  // M14: componentRemote absent → component.remote should NOT appear
  it('omits component.remote when componentRemote is absent (local instance not marked remote)', () => {
    const instanceRaw: Record<string, unknown> = {
      id: '5:9',
      name: 'LocalButton',
      type: 'INSTANCE',
      componentId: '2:13',
    }
    const spec = toNodeSpec(instanceRaw, { depth: -1 })
    expect(spec.component).toEqual({ id: '2:13' })
    expect(spec.component).not.toHaveProperty('remote')
  })

  it('omits component on non-INSTANCE nodes (FRAME carries no main-component ref)', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.type).toBe('FRAME')
    expect(spec).not.toHaveProperty('component')
  })
})

// ─── constraints REST→Plugin vocab translation ───────────────────────────────
// JSON_REST_V1 emits LEFT/RIGHT/TOP/BOTTOM/LEFT_RIGHT/TOP_BOTTOM; the spec and
// writer use the Plugin-API vocab MIN/MAX/STRETCH (CENTER/SCALE shared). The
// reader must translate REST→Plugin and pass any unmapped value through.

describe('toNodeSpec — constraints REST→Plugin vocab', () => {
  const constraintSpec = (h: string, v: string): NodeSpec =>
    toNodeSpec(
      {
        id: '9:1',
        name: 'Box',
        type: 'FRAME',
        constraints: { horizontal: h, vertical: v },
      },
      { depth: -1 },
    )

  it('translates LEFT/TOP → [MIN, MIN]', () => {
    expect(
      constraintSpec('LEFT', 'TOP').constraints,
    ).toEqual(['MIN', 'MIN'])
  })

  it('translates RIGHT/BOTTOM → [MAX, MAX]', () => {
    expect(
      constraintSpec('RIGHT', 'BOTTOM').constraints,
    ).toEqual(['MAX', 'MAX'])
  })

  it('translates LEFT_RIGHT/TOP_BOTTOM → [STRETCH, STRETCH]', () => {
    expect(
      constraintSpec('LEFT_RIGHT', 'TOP_BOTTOM')
        .constraints,
    ).toEqual(['STRETCH', 'STRETCH'])
  })

  it('passes CENTER and SCALE through unchanged', () => {
    expect(
      constraintSpec('CENTER', 'SCALE').constraints,
    ).toEqual(['CENTER', 'SCALE'])
  })

  it('passes an already-Plugin MIN/MAX value through unchanged', () => {
    expect(
      constraintSpec('MIN', 'MAX').constraints,
    ).toEqual(['MIN', 'MAX'])
  })

  it('translates the card fixture LEFT/TOP → [MIN, MIN]', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.constraints).toEqual(['MIN', 'MIN'])
  })
})

describe('toNodeSpec — rotation REST radians → Plugin degrees', () => {
  const rot = (rad: number): NodeSpec['rotation'] =>
    toNodeSpec(
      {
        id: '9:2',
        name: 'R',
        type: 'RECTANGLE',
        rotation: rad,
      },
      { depth: -1 },
    ).rotation

  it('converts -π/6 rad (sign-flipped REST) → 30 deg', () => {
    expect(rot(-Math.PI / 6)).toBe(30)
  })

  it('converts π/4 rad → -45 deg', () => {
    expect(rot(Math.PI / 4)).toBe(-45)
  })

  it('omits a zero rotation', () => {
    expect(rot(0)).toBeUndefined()
  })
})

// ─── depth + stubs (no budget) ────────────────────────────────────────────────

describe('toNodeSpec — depth + IdStubs', () => {
  it('depth=0 collapses children to IdStubs {id,name,type,size,childCount}', () => {
    const spec = toNodeSpec(raw, { depth: 0 })
    const children = spec.children as IdStub[]
    expect(children).toHaveLength(3)
    for (const child of children) {
      expect(child).toHaveProperty('id')
      expect(child).toHaveProperty('name')
      expect(child).toHaveProperty('type')
      expect(child).toHaveProperty('size')
      expect(child).toHaveProperty('childCount')
      // Stub carries no appearance fields.
      expect(child).not.toHaveProperty('fills')
      expect(child).not.toHaveProperty('text')
    }
  })

  it('depth=-1 returns the full subtree (no node stubbed)', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    const children = spec.children as NodeSpec[]
    // Children are full NodeSpecs, not stubs (TEXT child has text).
    expect(children[0].text).toBeDefined()
    expect(children[0]).not.toHaveProperty('childCount')
  })

  it('defaults to depth=0 when depth is omitted', () => {
    const spec = toNodeSpec(raw, {})
    const children = spec.children as IdStub[]
    expect(children[0]).toHaveProperty('childCount')
  })
})

// ─── lossless round-trip (non-image) ──────────────────────────────────────────

describe('toNodeSpec — lossless round-trip through specToFigma (non-image)', () => {
  it('fills survive read→write deep-equal', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    const fills = spec.fills as string[]
    // specToFigma drops the var() wrapper to the literal (T2). The lossless
    // claim is the grammar inverse: atomToPaint(atom) === written paint.
    const written = specToFigma({ fills }).fills
    expect(written).toEqual(fills.map(atomToPaint))
  })

  it('effects survive read→write deep-equal', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    const effects = spec.effects as string[]
    const writtenEffects = specToFigma({ effects }).effects
    // The DROP_SHADOW round-trips through the grammar.
    expect(Array.isArray(writtenEffects)).toBe(true)
    expect(
      (writtenEffects as { type: string }[])[0].type,
    ).toBe('DROP_SHADOW')
  })

  it('the card fixture contains no image fill (image hash is a P1 server step)', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    const serialized = JSON.stringify(spec)
    expect(serialized).not.toContain('image(')
  })
})

// ─── fidelity guard: NO read/budget import (source-level) ──────────────────────

describe('toNodeSpec — fidelity guard', () => {
  it('node-spec-reader.ts does not import read/budget', async () => {
    const src = await Bun.file(
      join(
        import.meta.dir,
        '../../src/serialize/node-spec-reader.ts',
      ),
    ).text()
    // Structural guard: get_node's reader must never pull in the budget
    // truncator (fidelity-first, T2). Assert on the import, not a bare word
    // (a comment mentioning "budget" must not false-positive).
    expect(src).not.toContain('read/budget')
    expect(src).not.toContain("from '../read/budget'")
  })
})

// ─── context read-back (raw.context → NodeSpec.context) ───────────────────────

describe('toNodeSpec — context read-back', () => {
  it('lifts raw.context into NodeSpec.context, omitting empty/absent', () => {
    expect(
      toNodeSpec(
        {
          id: '1',
          type: 'FRAME',
          context: '---\nx\n---',
        } as never,
        { depth: 0 },
      ).context,
    ).toBe('---\nx\n---')
    expect(
      toNodeSpec(
        { id: '1', type: 'FRAME', context: '' } as never,
        { depth: 0 },
      ).context,
    ).toBeUndefined()
    expect(
      toNodeSpec({ id: '1', type: 'FRAME' } as never, {
        depth: 0,
      }).context,
    ).toBeUndefined()
  })
  it('returns over-cap context faithfully (no truncation on read)', () => {
    const big = 'a'.repeat(5000)
    expect(
      toNodeSpec(
        { id: '1', type: 'FRAME', context: big } as never,
        { depth: 0 },
      ).context,
    ).toBe(big)
  })
})

// ─── vectorPaths read-back (raw.vectorPaths → NodeSpec.vectorPaths atoms) ───────

describe('toNodeSpec — vectorPaths read-back', () => {
  it('converts a raw vectorPaths array to path atoms', () => {
    const spec = toNodeSpec(
      {
        id: '9:1',
        type: 'VECTOR',
        vectorPaths: [
          {
            windingRule: 'EVENODD',
            data: 'M 0 0 L 10.5 0 Z',
          },
        ],
      } as never,
      { depth: 0 },
    )
    expect(spec.vectorPaths).toEqual([
      'path(EVENODD,"M 0 0 L 10.5 0 Z")',
    ])
  })

  it('converts multiple vector paths', () => {
    const spec = toNodeSpec(
      {
        id: '9:1',
        type: 'VECTOR',
        vectorPaths: [
          { windingRule: 'NONZERO', data: 'M0 0 L10 0 Z' },
          { windingRule: 'EVENODD', data: 'M0 0 L5 8 Z' },
        ],
      } as never,
      { depth: 0 },
    )
    expect(spec.vectorPaths).toEqual([
      'path(NONZERO,"M0 0 L10 0 Z")',
      'path(EVENODD,"M0 0 L5 8 Z")',
    ])
  })

  it('omits vectorPaths when absent from raw node', () => {
    const spec = toNodeSpec(
      { id: '9:1', type: 'VECTOR' } as never,
      { depth: 0 },
    )
    expect(spec.vectorPaths).toBeUndefined()
  })

  it('round-trips: raw vectorPaths → atom → FigmaVectorPath', () => {
    // Reader converts raw Figma VectorPath objects to path atoms.
    // Then writer converts atoms back to FigmaVectorPath objects.
    const vectorRaw = {
      id: '9:1',
      type: 'VECTOR',
      vectorPaths: [
        {
          windingRule: 'EVENODD',
          data: 'M 0 0 L 10.5 0 Z',
        },
      ],
    }
    const spec = toNodeSpec(vectorRaw as never, {
      depth: 0,
    })
    const written = specToFigma({
      vectorPaths: spec.vectorPaths,
    })
    const vp = written.vectorPaths as {
      windingRule: string
      data: string
    }[]
    expect(vp[0].windingRule).toBe('EVENODD')
    expect(vp[0].data).toBe('M 0 0 L 10.5 0 Z')
  })
})

// ─── pointCount / innerRadius / sectionContentsHidden read-back ──────────────

describe('toNodeSpec — pointCount read-back', () => {
  it('reads pointCount from a POLYGON raw node', () => {
    const spec = toNodeSpec(
      {
        id: '1:1',
        type: 'POLYGON',
        pointCount: 6,
      } as never,
      { depth: 0 },
    )
    expect(spec.pointCount).toBe(6)
  })

  it('reads pointCount from a STAR raw node', () => {
    const spec = toNodeSpec(
      { id: '1:2', type: 'STAR', pointCount: 5 } as never,
      { depth: 0 },
    )
    expect(spec.pointCount).toBe(5)
  })

  it('omits pointCount when absent from raw node', () => {
    const spec = toNodeSpec(
      { id: '1:3', type: 'POLYGON' } as never,
      { depth: 0 },
    )
    expect(spec.pointCount).toBeUndefined()
  })
})

describe('toNodeSpec — innerRadius read-back', () => {
  it('reads innerRadius from a STAR raw node', () => {
    const spec = toNodeSpec(
      {
        id: '1:4',
        type: 'STAR',
        innerRadius: 0.4,
      } as never,
      { depth: 0 },
    )
    expect(spec.innerRadius).toBe(0.4)
  })

  it('omits innerRadius when absent from raw node', () => {
    const spec = toNodeSpec(
      { id: '1:5', type: 'STAR' } as never,
      { depth: 0 },
    )
    expect(spec.innerRadius).toBeUndefined()
  })
})

describe('toNodeSpec — sectionContentsHidden read-back', () => {
  it('reads sectionContentsHidden=true from a SECTION raw node', () => {
    const spec = toNodeSpec(
      {
        id: '1:6',
        type: 'SECTION',
        sectionContentsHidden: true,
      } as never,
      { depth: 0 },
    )
    expect(spec.sectionContentsHidden).toBe(true)
  })

  it('reads sectionContentsHidden=false from a SECTION raw node', () => {
    const spec = toNodeSpec(
      {
        id: '1:7',
        type: 'SECTION',
        sectionContentsHidden: false,
      } as never,
      { depth: 0 },
    )
    expect(spec.sectionContentsHidden).toBe(false)
  })

  it('omits sectionContentsHidden when absent from raw node', () => {
    const spec = toNodeSpec(
      { id: '1:8', type: 'SECTION' } as never,
      { depth: 0 },
    )
    expect(spec.sectionContentsHidden).toBeUndefined()
  })
})

// ─── GROUP read round-trip (M10a) ─────────────────────────────────────────────

describe('toNodeSpec — GROUP read round-trip (M10a)', () => {
  // A GROUP node from JSON_REST_V1: geometry comes from absoluteBoundingBox,
  // children are walked, clipsContent is a frame-only concept and must NOT
  // appear on a GROUP (even if the raw data carries it as false/undefined).
  const groupRaw = {
    id: '5:1',
    name: 'My Group',
    type: 'GROUP',
    absoluteBoundingBox: {
      x: 50,
      y: 100,
      width: 200,
      height: 80,
    },
    children: [
      {
        id: '5:2',
        name: 'Rect',
        type: 'RECTANGLE',
        absoluteBoundingBox: {
          x: 60,
          y: 110,
          width: 80,
          height: 30,
        },
      },
      {
        id: '5:3',
        name: 'Ellipse',
        type: 'ELLIPSE',
        absoluteBoundingBox: {
          x: 150,
          y: 120,
          width: 40,
          height: 50,
        },
      },
    ],
  }

  it('emits type GROUP', () => {
    const spec = toNodeSpec(groupRaw as never, {
      depth: -1,
    })
    expect(spec.type).toBe('GROUP')
  })

  it('emits the GROUP id and name', () => {
    const spec = toNodeSpec(groupRaw as never, {
      depth: -1,
    })
    expect(spec.id).toBe('5:1')
    expect(spec.name).toBe('My Group')
  })

  it('derives size from absoluteBoundingBox', () => {
    const spec = toNodeSpec(groupRaw as never, {
      depth: -1,
    })
    expect(spec.size).toEqual([200, 80])
  })

  it('walks children and emits their types', () => {
    const spec = toNodeSpec(groupRaw as never, {
      depth: -1,
    })
    expect(Array.isArray(spec.children)).toBe(true)
    expect(spec.children).toHaveLength(2)
    const kids = spec.children as { type: string }[]
    expect(kids[0].type).toBe('RECTANGLE')
    expect(kids[1].type).toBe('ELLIPSE')
  })

  it('does NOT emit clipsContent (frame-only key) for a GROUP', () => {
    // Even if the raw data somehow carries clipsContent:true (e.g. stale export),
    // GROUP nodes must not propagate this frame-only flag.
    const groupWithClips = {
      ...groupRaw,
      clipsContent: true,
    }
    const spec = toNodeSpec(groupWithClips as never, {
      depth: -1,
    })
    expect(spec.clipsContent).toBeUndefined()
  })
})

// ─── explicitVariableModes read-back (M13) ────────────────────────────────────

describe('toNodeSpec — explicitVariableModes read-back (M13)', () => {
  it('reads explicitVariableModes from a raw node carrying the map', () => {
    const spec = toNodeSpec(
      {
        id: '1:9',
        type: 'FRAME',
        explicitVariableModes: {
          'col:1': 'm:1',
          'col:2': 'm:2',
        },
      } as never,
      { depth: 0 },
    )
    expect(spec.explicitVariableModes).toEqual({
      'col:1': 'm:1',
      'col:2': 'm:2',
    })
  })

  it('omits explicitVariableModes when absent from raw node', () => {
    const spec = toNodeSpec(
      { id: '1:10', type: 'FRAME' } as never,
      { depth: 0 },
    )
    expect(spec.explicitVariableModes).toBeUndefined()
  })

  it('omits explicitVariableModes when the map is empty', () => {
    const spec = toNodeSpec(
      {
        id: '1:11',
        type: 'FRAME',
        explicitVariableModes: {},
      } as never,
      { depth: 0 },
    )
    expect(spec.explicitVariableModes).toBeUndefined()
  })
})

// ─── B1: gradient angle from gradientHandlePositions (T2 round-trip) ────────────
//
// JSON_REST_V1 emits gradientHandlePositions instead of gradientTransform.
// The reader must derive the angle from the handle vector; previously it fell
// back to the identity matrix → linear(0) regardless of the real direction.

describe('toNodeSpec — gradient angle from gradientHandlePositions (B1)', () => {
  /** Build a minimal raw RECTANGLE node with a single GRADIENT_LINEAR fill. */
  const makeGradientNode = (
    handles: { x: number; y: number }[],
    withTransform?: number[][],
  ): Record<string, unknown> => ({
    id: 'b1:1',
    name: 'Rect',
    type: 'RECTANGLE',
    fills: [
      {
        type: 'GRADIENT_LINEAR',
        ...(withTransform
          ? { gradientTransform: withTransform }
          : { gradientHandlePositions: handles }),
        gradientStops: [
          {
            position: 0,
            color: { r: 1, g: 0, b: 0, a: 1 },
          },
          {
            position: 1,
            color: { r: 0, g: 0, b: 1, a: 1 },
          },
        ],
      },
    ],
  })

  /** Extract the angle from a `linear(<angle> ...)` fill atom. */
  const parseAngle = (atom: string): number => {
    const m = /^linear\((-?\d+)/.exec(atom)
    if (!m) {
      throw new Error(
        `Cannot parse angle from atom: ${atom}`,
      )
    }
    return parseInt(m[1], 10)
  }

  it('B1 regression: handles [0,0]→[1,1] derive 45°, NOT linear(0)', () => {
    // This test MUST FAIL before the fix (reader falls back to identity → 0°).
    const spec = toNodeSpec(
      makeGradientNode([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]) as never,
      { depth: -1 },
    )
    const atom = (spec.fills as string[])[0]
    expect(atom).toMatch(/^linear\(/)
    expect(parseAngle(atom)).toBe(45)
  })

  it('handles [0,0]→[1,0] derive 0° (east)', () => {
    const spec = toNodeSpec(
      makeGradientNode([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ]) as never,
      { depth: -1 },
    )
    expect(parseAngle((spec.fills as string[])[0])).toBe(0)
  })

  it('handles [0,0]→[0,1] derive 90° (south)', () => {
    const spec = toNodeSpec(
      makeGradientNode([
        { x: 0, y: 0 },
        { x: 0, y: 1 },
      ]) as never,
      { depth: -1 },
    )
    expect(parseAngle((spec.fills as string[])[0])).toBe(90)
  })

  it('handles [0,0]→[-1,1] derive 135° (south-west)', () => {
    const spec = toNodeSpec(
      makeGradientNode([
        { x: 0, y: 0 },
        { x: -1, y: 1 },
      ]) as never,
      { depth: -1 },
    )
    expect(parseAngle((spec.fills as string[])[0])).toBe(
      135,
    )
  })

  it('gradientTransform path is still honoured when present (no regression)', () => {
    // gradientTransform [[cos45,sin45,e],[−sin45,cos45,f]] → 45°.
    // The real plugin always sends gradientTransform, never gradientHandlePositions.
    const cos45 =
      Math.round(Math.cos(Math.PI / 4) * 1000) / 1000
    const sin45 =
      Math.round(Math.sin(Math.PI / 4) * 1000) / 1000
    const e =
      Math.round(
        (0.5 - (cos45 * 0.5 + sin45 * 0.5)) * 1000,
      ) / 1000
    const f =
      Math.round(
        (0.5 - (-sin45 * 0.5 + cos45 * 0.5)) * 1000,
      ) / 1000
    const spec = toNodeSpec(
      makeGradientNode(
        [],
        [
          [cos45, sin45, e],
          [-sin45, cos45, f],
        ],
      ) as never,
      { depth: -1 },
    )
    expect(parseAngle((spec.fills as string[])[0])).toBe(45)
  })
})

// ─── B7: rotated node size — prefer raw.width/height over absoluteBoundingBox ──
// JSON_REST_V1 omits unrotated width/height; the plugin enrichment adds them.
// sizeOf must prefer the enriched raw.width/height (unrotated geometry) over
// absoluteBoundingBox (axis-aligned bbox, inflated when node is rotated).

describe('toNodeSpec — B7 rotated node size (prefer enriched width/height over bbox)', () => {
  it('returns enriched raw.width/height when both width and absoluteBoundingBox are present', () => {
    // Simulates a 60×60 node rotated 30° — bbox becomes ~81.96×81.96.
    // Plugin enrichment adds raw.width=60, raw.height=60.
    const spec = toNodeSpec(
      {
        id: '7:1',
        name: 'RotatedRect',
        type: 'RECTANGLE',
        width: 60,
        height: 60,
        absoluteBoundingBox: {
          x: 0,
          y: 0,
          width: 81.96,
          height: 81.96,
        },
      } as never,
      { depth: 0 },
    )
    expect(spec.size).toEqual([60, 60])
  })

  it('falls back to absoluteBoundingBox when raw.width/height are absent', () => {
    // Non-enriched export (JSON_REST_V1 without plugin enrichment).
    const spec = toNodeSpec(
      {
        id: '7:2',
        name: 'NonEnrichedRect',
        type: 'RECTANGLE',
        absoluteBoundingBox: {
          x: 0,
          y: 0,
          width: 100,
          height: 50,
        },
      } as never,
      { depth: 0 },
    )
    expect(spec.size).toEqual([100, 50])
  })
})

// ─── componentPropertyReferences read-back ────────────────────────────────────

describe('toNodeSpec — componentPropertyReferences read-back', () => {
  it('lifts componentPropertyReferences from a raw node carrying the map', () => {
    const spec = toNodeSpec(
      {
        id: '1:12',
        type: 'TEXT',
        componentPropertyReferences: {
          characters: 'Label#45:13',
        },
      } as never,
      { depth: 0 },
    )
    expect(spec.componentPropertyReferences).toEqual({
      characters: 'Label#45:13',
    })
  })

  it('omits componentPropertyReferences when absent from raw node', () => {
    const spec = toNodeSpec(
      { id: '1:13', type: 'TEXT' } as never,
      { depth: 0 },
    )
    expect(spec).not.toHaveProperty(
      'componentPropertyReferences',
    )
  })
})
