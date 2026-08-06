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

  it('renders a uniform per-corner group as the scalar even with no flat cornerRadius', () => {
    // B21's underlying shape: Figma reports a uniform corner radius solely
    // as rectangleCornerRadii and omits `cornerRadius`. Four equal corners
    // are one radius — the atom is the scalar, not a 4-tuple.
    const spec = toNodeSpec(
      {
        id: '9:1',
        name: 'UniformRadius',
        type: 'FRAME',
        rectangleCornerRadii: [8, 8, 8, 8],
      },
      { depth: -1 },
    )
    expect(spec.radius).toBe('8')
  })

  it('elides an all-zero per-corner group (T4 default)', () => {
    const spec = toNodeSpec(
      {
        id: '9:2',
        name: 'NoRadius',
        type: 'FRAME',
        rectangleCornerRadii: [0, 0, 0, 0],
      },
      { depth: -1 },
    )
    expect(spec.radius).toBeUndefined()
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

  it('reads pad on a GRID frame (padding is not H/V-only)', () => {
    const gridRaw: Record<string, unknown> = {
      id: '10:5',
      name: 'Padded Grid',
      type: 'FRAME',
      layoutMode: 'GRID',
      gridRowCount: 2,
      gridColumnCount: 2,
      paddingTop: 10,
      paddingRight: 20,
      paddingBottom: 30,
      paddingLeft: 40,
    }
    const spec = toNodeSpec(gridRaw, { depth: -1 })
    expect(spec.layout?.mode).toBe('GRID')
    expect(spec.layout?.pad).toEqual([10, 20, 30, 40])
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

// ─── issue-5: full gradient geometry from 3 handles (tf attr) ─────────────────
//
// JSON_REST_V1 always sends 3 gradientHandlePositions (start/end/width for
// LINEAR; center/major/minor for RADIAL, ANGULAR, DIAMOND). These fixtures
// are NOT hand-derived — they were captured live against the real Figma
// plugin (write a known {tf=[...]}, read back the raw handles Figma computed
// for it). A pure rotation (or, for radial/angular/diamond, the identity
// transform) must keep reading back WITHOUT a tf attr; anything with skew or
// non-uniform scale must carry {tf=[a,b,c,d,e,f]} or the geometry is silently
// flattened (the bug this fixes).
//
// FLOAT_TOLERANCE mirrors figma-paint.test.ts: round3's 3-decimal precision.
const FLOAT_TOLERANCE = 1e-3

describe('toNodeSpec — full gradient geometry from 3 handles (issue-5)', () => {
  const makeNode = (
    type:
      | 'GRADIENT_LINEAR'
      | 'GRADIENT_RADIAL'
      | 'GRADIENT_ANGULAR'
      | 'GRADIENT_DIAMOND',
    handles: { x: number; y: number }[],
  ): Record<string, unknown> => ({
    id: 'issue5:1',
    name: 'Rect',
    type: 'RECTANGLE',
    fills: [
      {
        type,
        gradientHandlePositions: handles,
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

  const atomOf = (
    type: Parameters<typeof makeNode>[0],
    handles: { x: number; y: number }[],
  ): string => {
    const spec = toNodeSpec(
      makeNode(type, handles) as never,
      {
        depth: -1,
      },
    )
    return (spec.fills as string[])[0]
  }

  const expectGradientTransformClose = (
    atom: string,
    expected: number[][],
  ): void => {
    const paint = atomToPaint(atom)
    if (
      paint.type !== 'GRADIENT_LINEAR' &&
      paint.type !== 'GRADIENT_RADIAL' &&
      paint.type !== 'GRADIENT_ANGULAR' &&
      paint.type !== 'GRADIENT_DIAMOND'
    ) {
      throw new Error('expected a gradient paint')
    }
    const t = paint.gradientTransform
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 3; j++) {
        expect(
          Math.abs(t[i][j] - expected[i][j]),
        ).toBeLessThanOrEqual(FLOAT_TOLERANCE)
      }
    }
  }

  it('LINEAR identity handles -> linear(0, ...) with NO tf', () => {
    const atom = atomOf('GRADIENT_LINEAR', [
      { x: 0, y: 0.5 },
      { x: 1, y: 0.5 },
      { x: 0, y: 1 },
    ])
    expect(atom).toStartWith('linear(0')
    expect(atom).not.toContain('tf=')
  })

  it('LINEAR rot90 handles -> linear(90, ...) with NO tf', () => {
    const atom = atomOf('GRADIENT_LINEAR', [
      { x: 0.5, y: 0 },
      { x: 0.5, y: 1 },
      { x: 0, y: 0 },
    ])
    expect(atom).toStartWith('linear(90')
    expect(atom).not.toContain('tf=')
  })

  it('LINEAR skew+scale handles (proven-live bug case) -> carries tf and round-trips', () => {
    const atom = atomOf('GRADIENT_LINEAR', [
      { x: -0.32352941447166406, y: 0.20588234430469043 },
      { x: 2.0294117784984795, y: -0.3823529539378455 },
      { x: -0.7647058991103022, y: 0.9411764561511243 },
    ])
    expect(atom).toContain('tf=')
    expectGradientTransformClose(atom, [
      [0.5, 0.3, 0.1],
      [0.2, 0.8, 0.4],
    ])
  })

  it('RADIAL identity handles -> radial(...) with NO tf', () => {
    const atom = atomOf('GRADIENT_RADIAL', [
      { x: 0.5, y: 0.5 },
      { x: 1, y: 0.5 },
      { x: 0.5, y: 1 },
    ])
    expect(atom).toStartWith('radial(')
    expect(atom).not.toContain('tf=')
  })

  it('RADIAL custom center/radius geometry -> carries tf and round-trips', () => {
    const atom = atomOf('GRADIENT_RADIAL', [
      { x: 0.5, y: 0.5 },
      { x: 1.5, y: 0.5 },
      { x: 0.5, y: 1.5 },
    ])
    expect(atom).toContain('tf=')
    expectGradientTransformClose(atom, [
      [0.5, 0, 0.25],
      [0, 0.5, 0.25],
    ])
  })

  it('ANGULAR custom geometry -> carries tf and round-trips', () => {
    const atom = atomOf('GRADIENT_ANGULAR', [
      { x: 0.8529411820134077, y: -0.08823530481657754 },
      { x: 2.0294117784984795, y: -0.3823529539378455 },
      { x: 0.4117646973747698, y: 0.6470588070298563 },
    ])
    expect(atom).toContain('tf=')
    expectGradientTransformClose(atom, [
      [0.5, 0.3, 0.1],
      [0.2, 0.8, 0.4],
    ])
  })

  it('DIAMOND custom geometry -> carries tf and round-trips', () => {
    const atom = atomOf('GRADIENT_DIAMOND', [
      { x: 0.8529411820134077, y: -0.08823530481657754 },
      { x: 2.0294117784984795, y: -0.3823529539378455 },
      { x: 0.4117646973747698, y: 0.6470588070298563 },
    ])
    expect(atom).toContain('tf=')
    expectGradientTransformClose(atom, [
      [0.5, 0.3, 0.1],
      [0.2, 0.8, 0.4],
    ])
  })

  it('DIAMOND identity handles -> diamond(...) with NO tf', () => {
    const atom = atomOf('GRADIENT_DIAMOND', [
      { x: 0.5, y: 0.5 },
      { x: 1, y: 0.5 },
      { x: 0.5, y: 1 },
    ])
    expect(atom).toStartWith('diamond(')
    expect(atom).not.toContain('tf=')
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

// ─── stroke geometry read-back: cap/join/miter into the stroke atom ──────────
//
// strokeCap is present in JSON_REST_V1; strokeJoin / strokeMiterLimit are NOT
// (plugin-enriched — see exportNodeDocument in code.ts). The reader must fold
// all three into the ONE stroke(...) atom's {…} channel via strokeToAtom, same
// as align/dash already do.

// Every fixture in this block carries a real stroke paint. The atom reports the
// STROKE's geometry, so a strokeless fixture emits no atom at all and these
// assertions would be vacuous — they were, until the gate below was added.
const aStroke = [
  { type: 'SOLID', color: { r: 0, g: 0, b: 0 } },
]

describe('toNodeSpec — stroke cap/join/miter read-back', () => {
  it('reads strokeCap into the stroke atom {cap=…}', () => {
    const spec = toNodeSpec(
      {
        id: '2:1',
        type: 'RECTANGLE',
        strokes: aStroke,
        strokeWeight: 2,
        strokeCap: 'ROUND',
      } as never,
      { depth: 0 },
    )
    expect(spec.stroke).toBe('stroke(2){cap=ROUND}')
  })

  // Figma spells the two arrow caps one way in a REST export and another in the
  // Plugin API. A read that passes REST's name through returns a spec the very
  // next create_node rejects — verified live against Figma before this existed.
  it.each([
    ['LINE_ARROW', 'ARROW_LINES'],
    ['TRIANGLE_ARROW', 'ARROW_EQUILATERAL'],
  ])(
    'rewrites REST cap %s to the writable %s',
    (rest, plugin) => {
      const spec = toNodeSpec(
        {
          id: '2:1a',
          type: 'VECTOR',
          strokes: aStroke,
          strokeWeight: 2,
          strokeCap: rest,
        } as never,
        { depth: 0 },
      )
      expect(spec.stroke).toBe(`stroke(2){cap=${plugin}}`)
    },
  )

  it('leaves a cap that already has one spelling alone', () => {
    for (const cap of ['ROUND', 'SQUARE']) {
      const spec = toNodeSpec(
        {
          id: '2:1b',
          type: 'VECTOR',
          strokes: aStroke,
          strokeWeight: 2,
          strokeCap: cap,
        } as never,
        { depth: 0 },
      )
      expect(spec.stroke).toBe(`stroke(2){cap=${cap}}`)
    }
  })

  it('omits cap when strokeCap is the Figma default NONE', () => {
    const spec = toNodeSpec(
      {
        id: '2:2',
        type: 'RECTANGLE',
        strokes: aStroke,
        strokeWeight: 2,
        strokeCap: 'NONE',
      } as never,
      { depth: 0 },
    )
    expect(spec.stroke).toBe('stroke(2)')
  })

  it('reads strokeJoin and strokeMiterLimit when NON-default', () => {
    const spec = toNodeSpec(
      {
        id: '2:3',
        type: 'RECTANGLE',
        strokes: aStroke,
        strokeWeight: 2,
        strokeJoin: 'ROUND',
        strokeMiterLimit: 8,
      } as never,
      { depth: 0 },
    )
    expect(spec.stroke).toBe(
      'stroke(2){join=ROUND, miter=8}',
    )
  })

  // This test used to assert `stroke(2){join=MITER, miter=4}` — the default
  // noise itself — which locked the defect in place. expression-formats.md:276
  // says a key is "only emitted when non-default (T4)", and the spec's worked
  // example of a read (:286) is `stroke(1, {align=INSIDE})`, carrying neither.
  // Eliding a default is lossless: the writer sends nothing and Figma keeps the
  // same value, so the round-trip is unaffected.
  it('omits join/miter at their Figma defaults (MITER/4)', () => {
    const spec = toNodeSpec(
      {
        id: '2:3b',
        type: 'RECTANGLE',
        strokes: aStroke,
        strokeWeight: 2,
        strokeJoin: 'MITER',
        strokeMiterLimit: 4,
      } as never,
      { depth: 0 },
    )
    expect(spec.stroke).toBe('stroke(2)')
  })

  it('combines align/cap/join/miter/dash into the one canonical atom', () => {
    const spec = toNodeSpec(
      {
        id: '2:4',
        type: 'RECTANGLE',
        strokes: aStroke,
        strokeWeight: 2,
        strokeAlign: 'INSIDE',
        strokeCap: 'ROUND',
        strokeJoin: 'BEVEL',
        strokeMiterLimit: 8,
        dashPattern: [4, 4],
      } as never,
      { depth: 0 },
    )
    expect(spec.stroke).toBe(
      'stroke(2){align=INSIDE, cap=ROUND, join=BEVEL, miter=8, dash=[4,4]}',
    )
  })

  it('omits cap/join/miter when absent (no {…} channel at all)', () => {
    const spec = toNodeSpec(
      {
        id: '2:5',
        type: 'RECTANGLE',
        strokes: aStroke,
        strokeWeight: 3,
      } as never,
      { depth: 0 },
    )
    expect(spec.stroke).toBe('stroke(3)')
  })

  it('the stroke atom survives a read → write round-trip', () => {
    const spec = toNodeSpec(
      {
        id: '2:6',
        type: 'RECTANGLE',
        strokes: aStroke,
        strokeWeight: 2,
        strokeAlign: 'INSIDE',
        strokeCap: 'ROUND',
        strokeJoin: 'BEVEL',
        strokeMiterLimit: 8,
      } as never,
      { depth: 0 },
    )
    const written = specToFigma({
      stroke: spec.stroke,
    }) as {
      strokeWeight: number
      strokeAlign: string
      strokeCap: string
      strokeJoin: string
      strokeMiterLimit: number
    }
    expect(written.strokeWeight).toBe(2)
    expect(written.strokeAlign).toBe('INSIDE')
    expect(written.strokeCap).toBe('ROUND')
    expect(written.strokeJoin).toBe('BEVEL')
    expect(written.strokeMiterLimit).toBe(8)
  })

  // A DEFAULT-valued key round-trips by absence, which is why eliding it is
  // lossless: the read omits it, the write sends nothing for it, and Figma
  // keeps the same value it already had. This is the half the old assertion
  // could not distinguish, because it round-tripped MITER/4 explicitly.
  it('a default-valued stroke round-trips as absence, not as loss', () => {
    const spec = toNodeSpec(
      {
        id: '2:7',
        type: 'RECTANGLE',
        strokes: aStroke,
        strokeWeight: 2,
        strokeAlign: 'INSIDE',
        strokeJoin: 'MITER',
        strokeMiterLimit: 4,
      } as never,
      { depth: 0 },
    )
    expect(spec.stroke).toBe('stroke(2){align=INSIDE}')

    const written = specToFigma({
      stroke: spec.stroke,
    }) as Record<string, unknown>
    // Nothing is sent for join/miter — Figma keeps MITER/4 untouched.
    expect(written.strokeJoin).toBeUndefined()
    expect(written.strokeMiterLimit).toBeUndefined()
    expect(written.strokeAlign).toBe('INSIDE')
  })
})

// ─── a strokeless node has no stroke GEOMETRY ────────────────────────────────
//
// Figma keeps a default strokeWeight (and strokeAlign) on every node whether or
// not a stroke exists, so gating the atom on `strokeWeight > 0` alone put
// `stroke(1){align=INSIDE}` on every FRAME, RECTANGLE and TEXT ever read — 33
// characters per node describing a stroke that is not there (T4 cost, T7
// honesty). expression-formats.md frames the atom as "the stroke's GEOMETRY":
// no stroke, no geometry.

describe('toNodeSpec — stroke geometry needs a stroke', () => {
  it('emits no stroke atom when the node has no strokes key at all', () => {
    const spec = toNodeSpec(
      {
        id: '2:8',
        type: 'FRAME',
        strokeWeight: 1,
        strokeAlign: 'INSIDE',
      } as never,
      { depth: 0 },
    )
    expect(spec.stroke).toBeUndefined()
    expect('stroke' in spec).toBe(false)
  })

  it('emits no stroke atom when strokes is an empty array', () => {
    const spec = toNodeSpec(
      {
        id: '2:9',
        type: 'VECTOR',
        strokes: [],
        strokeWeight: 1,
      } as never,
      { depth: 0 },
    )
    expect(spec.stroke).toBeUndefined()
    expect('stroke' in spec).toBe(false)
  })

  it('still emits the full atom when a real stroke paint is present', () => {
    const spec = toNodeSpec(
      {
        id: '2:10',
        type: 'RECTANGLE',
        strokes: aStroke,
        strokeWeight: 2,
        strokeAlign: 'INSIDE',
        strokeCap: 'ROUND',
        strokeJoin: 'BEVEL',
        strokeMiterLimit: 8,
        dashPattern: [4, 4],
      } as never,
      { depth: 0 },
    )
    expect(spec.strokes).toEqual(['#000000'])
    expect(spec.stroke).toBe(
      'stroke(2){align=INSIDE, cap=ROUND, join=BEVEL, miter=8, dash=[4,4]}',
    )
  })

  // A hidden stroke is still a stroke — the node HAS one, it is just not
  // painted. paintArray deliberately keeps `{vis=false}` rather than filtering
  // it, and the geometry must follow the same rule.
  it('keeps the geometry when the only stroke is hidden', () => {
    const spec = toNodeSpec(
      {
        id: '2:11',
        type: 'RECTANGLE',
        strokes: [
          {
            type: 'SOLID',
            visible: false,
            color: { r: 0, g: 0, b: 1, a: 1 },
          },
        ],
        strokeWeight: 2,
      } as never,
      { depth: 0 },
    )
    expect(spec.strokes).toEqual(['#0000FF{vis=false}'])
    expect(spec.stroke).toBe('stroke(2)')
  })

  // The write face is independent of the read gate: a spec that supplies
  // `stroke` must still apply, including alongside `strokes` in the SAME spec.
  it('the write path still applies stroke, with and without strokes', () => {
    const geomOnly = specToFigma({
      stroke: 'stroke(2){align=INSIDE}',
    }) as Record<string, unknown>
    expect(geomOnly.strokeWeight).toBe(2)
    expect(geomOnly.strokeAlign).toBe('INSIDE')

    const both = specToFigma({
      strokes: ['#000000'],
      stroke: 'stroke(2){align=INSIDE}',
    }) as Record<string, unknown>
    expect(both.strokeWeight).toBe(2)
    expect(both.strokeAlign).toBe('INSIDE')
    expect(both.strokes).toEqual([
      { type: 'SOLID', color: { r: 0, g: 0, b: 0 } },
    ])
  })
})

// ─── exportSettings read-back (raw.exportSettings → NodeSpec.exportSettings) ──
//
// The raw/Figma constraint shape is an OBJECT {type, value}; the NodeSpec/
// grammar shape is the tuple ['SCALE'|'WIDTH'|'HEIGHT', number] — the mirror
// of the revive applyExportSettings does on the way in (apply-node-fields.ts).

describe('toNodeSpec — exportSettings read-back', () => {
  it('converts a raw export preset with a SCALE constraint to the tuple form', () => {
    const spec = toNodeSpec(
      {
        id: '3:1',
        type: 'FRAME',
        exportSettings: [
          {
            format: 'PNG',
            suffix: '@2x',
            constraint: { type: 'SCALE', value: 2 },
          },
        ],
      } as never,
      { depth: 0 },
    )
    expect(spec.exportSettings).toEqual([
      {
        format: 'PNG',
        suffix: '@2x',
        constraint: ['SCALE', 2],
      },
    ])
  })

  it('converts a WIDTH constraint and omits an empty suffix', () => {
    const spec = toNodeSpec(
      {
        id: '3:2',
        type: 'FRAME',
        exportSettings: [
          {
            format: 'SVG',
            suffix: '',
            constraint: { type: 'WIDTH', value: 512 },
          },
        ],
      } as never,
      { depth: 0 },
    )
    expect(spec.exportSettings).toEqual([
      { format: 'SVG', constraint: ['WIDTH', 512] },
    ])
  })

  it('handles multiple presets and a preset with no constraint', () => {
    const spec = toNodeSpec(
      {
        id: '3:3',
        type: 'FRAME',
        exportSettings: [
          { format: 'JPG' },
          {
            format: 'PDF',
            constraint: { type: 'HEIGHT', value: 100 },
          },
        ],
      } as never,
      { depth: 0 },
    )
    expect(spec.exportSettings).toEqual([
      { format: 'JPG' },
      { format: 'PDF', constraint: ['HEIGHT', 100] },
    ])
  })

  it('omits exportSettings when absent or empty on the raw node', () => {
    expect(
      toNodeSpec({ id: '3:4', type: 'FRAME' } as never, {
        depth: 0,
      }).exportSettings,
    ).toBeUndefined()
    expect(
      toNodeSpec(
        {
          id: '3:5',
          type: 'FRAME',
          exportSettings: [],
        } as never,
        { depth: 0 },
      ).exportSettings,
    ).toBeUndefined()
  })

  it('exportSettings survives a read → write round-trip (mirrors applyExportSettings revive)', () => {
    const spec = toNodeSpec(
      {
        id: '3:6',
        type: 'FRAME',
        exportSettings: [
          {
            format: 'PNG',
            suffix: '@2x',
            constraint: { type: 'SCALE', value: 2 },
          },
        ],
      } as never,
      { depth: 0 },
    )
    const written = specToFigma({
      exportSettings: spec.exportSettings,
    })
    expect(written.exportSettings).toEqual([
      {
        format: 'PNG',
        suffix: '@2x',
        constraint: ['SCALE', 2],
      },
    ])
  })
})

// ─── layoutGrids read-back (raw.layoutGrids → NodeSpec.grids) ────────────────
//
// Figma's own property is layoutGrids; the NodeSpec/grammar field is grids.
// Each raw LayoutGrid converts to a grid atom via the existing gridToAtom
// (the inverse of the writer's atomToGrid, already in grammar/heads/grid.ts).

describe('toNodeSpec — layoutGrids read-back', () => {
  it('converts a COLUMNS layoutGrid to a columns(...) atom', () => {
    const spec = toNodeSpec(
      {
        id: '4:1',
        type: 'FRAME',
        layoutGrids: [
          {
            pattern: 'COLUMNS',
            alignment: 'STRETCH',
            count: 12,
            gutterSize: 32,
            offset: 16,
          },
        ],
      } as never,
      { depth: 0 },
    )
    expect(spec.grids).toEqual([
      'columns(12,0,32){offset=16}',
    ])
  })

  it('converts a GRID pattern layoutGrid to a grid(...) atom', () => {
    const spec = toNodeSpec(
      {
        id: '4:2',
        type: 'FRAME',
        layoutGrids: [{ pattern: 'GRID', sectionSize: 8 }],
      } as never,
      { depth: 0 },
    )
    expect(spec.grids).toEqual(['grid(8)'])
  })

  it('converts a ROWS layoutGrid with non-STRETCH alignment + sectionSize', () => {
    const spec = toNodeSpec(
      {
        id: '4:3',
        type: 'FRAME',
        layoutGrids: [
          {
            pattern: 'ROWS',
            alignment: 'MIN',
            count: 4,
            gutterSize: 10,
            sectionSize: 20,
            offset: 0,
          },
        ],
      } as never,
      { depth: 0 },
    )
    expect(spec.grids).toEqual(['rows(4,20,10){align=MIN}'])
  })

  it('handles multiple grids on one node', () => {
    const spec = toNodeSpec(
      {
        id: '4:4',
        type: 'FRAME',
        layoutGrids: [
          {
            pattern: 'COLUMNS',
            alignment: 'STRETCH',
            count: 12,
            gutterSize: 20,
            offset: 0,
          },
          { pattern: 'GRID', sectionSize: 10 },
        ],
      } as never,
      { depth: 0 },
    )
    expect(spec.grids).toEqual([
      'columns(12,0,20)',
      'grid(10)',
    ])
  })

  it('maps a raw auto-count of -1 (what the live plugin actually sends) to columns(auto,...)', () => {
    // Live-verified: creating columns(auto,60,20){align=MIN} and reading it
    // back off the real plugin yields raw layoutGrids count -1, not Infinity
    // (JSON can't carry Infinity anyway, so Figma never actually sends it).
    const spec = toNodeSpec(
      {
        id: '4:8',
        type: 'FRAME',
        layoutGrids: [
          {
            pattern: 'COLUMNS',
            alignment: 'MIN',
            count: -1,
            gutterSize: 20,
            sectionSize: 60,
            offset: 0,
          },
        ],
      } as never,
      { depth: 0 },
    )
    expect(spec.grids).toEqual([
      'columns(auto,60,20){align=MIN}',
    ])
  })

  it('omits grids when layoutGrids is absent or empty', () => {
    expect(
      toNodeSpec({ id: '4:5', type: 'FRAME' } as never, {
        depth: 0,
      }).grids,
    ).toBeUndefined()
    expect(
      toNodeSpec(
        {
          id: '4:6',
          type: 'FRAME',
          layoutGrids: [],
        } as never,
        { depth: 0 },
      ).grids,
    ).toBeUndefined()
  })

  it('round-trips through specToFigma (grids atom → complete Figma LayoutGrid)', () => {
    const spec = toNodeSpec(
      {
        id: '4:7',
        type: 'FRAME',
        layoutGrids: [
          {
            pattern: 'COLUMNS',
            alignment: 'STRETCH',
            count: 12,
            gutterSize: 32,
            offset: 16,
          },
        ],
      } as never,
      { depth: 0 },
    )
    const written = specToFigma({ grids: spec.grids })
    expect(written.grids).toEqual([
      {
        pattern: 'COLUMNS',
        alignment: 'STRETCH',
        count: 12,
        gutterSize: 32,
        offset: 16,
      },
    ])
  })
})

// ─── IMAGE paint read-back (rot/tile/op/blend/vis) ────────────────────────────
//
// Live-verified: writing image(HASH){scale=TILE, rot=90, tile=0.5, op=0.6,
// blend=MULTIPLY} and reading it back used to drop rot/tile/op/blend,
// surviving only scale=TILE. The raw JSON_REST_V1 export DOES carry
// scalingFactor/rotation/opacity/blendMode/visible for an IMAGE paint (this
// fixture mirrors the live-captured raw shape) — rawToFigmaPaint just
// discarded them.
describe('toNodeSpec — IMAGE paint read-back (rot/tile/op/blend/vis)', () => {
  it('carries scalingFactor, rotation, opacity and blendMode into the image(...) atom', () => {
    const spec = toNodeSpec(
      {
        id: '5:1',
        type: 'RECTANGLE',
        fills: [
          {
            type: 'IMAGE',
            imageRef: 'deadbeef',
            scaleMode: 'TILE',
            scalingFactor: 0.5,
            rotation: 90,
            opacity: 0.6,
            blendMode: 'MULTIPLY',
          },
        ],
      } as never,
      { depth: 0 },
    )
    const fill = spec.fills?.[0] ?? ''
    expect(fill).toContain('image(deadbeef)')
    expect(fill).toContain('scale=TILE')
    expect(fill).toContain('tile=0.5')
    expect(fill).toContain('rot=90')
    expect(fill).toContain('op=0.6')
    expect(fill).toContain('blend=MULTIPLY')
  })

  it('omits rotation when it is the Figma default (0)', () => {
    const spec = toNodeSpec(
      {
        id: '5:2',
        type: 'RECTANGLE',
        fills: [
          {
            type: 'IMAGE',
            imageRef: 'deadbeef',
            rotation: 0,
          },
        ],
      } as never,
      { depth: 0 },
    )
    expect(spec.fills?.[0]).not.toContain('rot=')
  })

  // B11. JSON_REST_V1 spells the Plugin API's CROP as STRETCH — and STRETCH is
  // not an ImagePaint.scaleMode at all, so passing it through hands the agent a
  // value its own next write cannot mean (T2). FILL/FIT/TILE are spelled the
  // same on both sides; FILL is additionally Figma's default and stays elided
  // (T4). Asserting the emitted VALUE, not merely that a round-trip is
  // accepted: the write face copies `scale` into `scaleMode` with no enum
  // check, so an acceptance assertion passes with the bug present.
  it.each([
    ['STRETCH', 'CROP'],
    ['FILL', 'FILL'],
    ['FIT', 'FIT'],
    ['TILE', 'TILE'],
  ])(
    'reads REST scaleMode %s as the writable %s',
    (rest, plugin) => {
      const spec = toNodeSpec(
        {
          id: '5:3',
          type: 'RECTANGLE',
          fills: [
            {
              type: 'IMAGE',
              imageRef: 'deadbeef',
              scaleMode: rest,
            },
          ],
        } as never,
        { depth: 0 },
      )
      const fill = spec.fills?.[0] ?? ''
      expect(fill).toContain('image(deadbeef)')
      if (plugin === 'FILL') {
        expect(fill).not.toContain('scale=')
      } else {
        expect(fill).toContain(`{scale=${plugin}}`)
      }
      // …and the atom parses back to that same mode.
      const paint = atomToPaint(fill)
      if (paint.type !== 'IMAGE') {
        throw new Error(
          `expected an IMAGE paint, got ${paint.type}`,
        )
      }
      expect(paint.scaleMode ?? 'FILL').toBe(plugin)
    },
  )
})

// ─── hidden paints survive the read ───────────────────────────────────────────
//
// A paint with `visible: false` is STATE, not absence. Dropping it from the
// read makes a read-modify-write destroy it: the agent echoes back the fills
// it was shown, and the hidden one — never shown — is gone. The grammar
// already carries the state (`{vis=false}`, expression-formats.md) and the
// write face already parses it, so the read has no excuse to filter.
describe('toNodeSpec — hidden paints survive the read', () => {
  it('emits a hidden fill as {vis=false}, in order, alongside the visible one', () => {
    const spec = toNodeSpec(
      {
        id: '6:1',
        type: 'RECTANGLE',
        fills: [
          {
            type: 'SOLID',
            visible: false,
            color: { r: 1, g: 0, b: 0, a: 1 },
          },
          {
            type: 'SOLID',
            color: { r: 0, g: 1, b: 0, a: 1 },
          },
        ],
      } as never,
      { depth: 0 },
    )
    expect(spec.fills).toEqual([
      '#FF0000{vis=false}',
      '#00FF00',
    ])
  })

  it('does not read back as fill-less when the only fill is hidden', () => {
    const spec = toNodeSpec(
      {
        id: '6:2',
        type: 'RECTANGLE',
        fills: [
          {
            type: 'SOLID',
            visible: false,
            color: { r: 1, g: 0, b: 0, a: 1 },
          },
        ],
      } as never,
      { depth: 0 },
    )
    expect(spec.fills).toEqual(['#FF0000{vis=false}'])
  })

  it('keeps a hidden stroke too', () => {
    const spec = toNodeSpec(
      {
        id: '6:3',
        type: 'RECTANGLE',
        strokes: [
          {
            type: 'SOLID',
            visible: false,
            color: { r: 0, g: 0, b: 1, a: 1 },
          },
        ],
      } as never,
      { depth: 0 },
    )
    expect(spec.strokes).toEqual(['#0000FF{vis=false}'])
  })

  it('round-trips a hidden fill back through the write face', () => {
    const spec = toNodeSpec(
      {
        id: '6:4',
        type: 'RECTANGLE',
        fills: [
          {
            type: 'SOLID',
            visible: false,
            color: { r: 1, g: 0, b: 0, a: 1 },
          },
        ],
      } as never,
      { depth: 0 },
    )
    const paint = atomToPaint(
      (spec.fills as string[])[0],
    ) as { visible?: boolean }
    expect(paint.visible).toBe(false)
  })
})

// ─── an unmappable paint is announced, never silently dropped ─────────────────
//
// The reader cannot render VIDEO / PATTERN / SHADER paints yet. Dropping them
// is survivable; dropping them SILENTLY is not — the agent is handed a fills
// array that looks complete (T7: never hide what the surface could not do).
describe('toNodeSpec — unmappable paints warn', () => {
  it('warns, naming the paint type, when a fill cannot be rendered', () => {
    const spec = toNodeSpec(
      {
        id: '7:1',
        type: 'RECTANGLE',
        fills: [
          { type: 'VIDEO', videoHash: 'abc' },
          {
            type: 'SOLID',
            color: { r: 0, g: 1, b: 0, a: 1 },
          },
        ],
      } as never,
      { depth: 0 },
    )
    expect(spec.fills).toEqual(['#00FF00'])
    expect(spec.warnings?.length).toBe(1)
    expect(spec.warnings?.[0]).toContain('VIDEO')
    expect(spec.warnings?.[0]).toContain('fills')
  })

  it('warns on an unmappable stroke, naming strokes', () => {
    const spec = toNodeSpec(
      {
        id: '7:2',
        type: 'RECTANGLE',
        strokes: [{ type: 'PATTERN', sourceNodeId: '1:1' }],
      } as never,
      { depth: 0 },
    )
    expect(spec.strokes).toBeUndefined()
    expect(spec.warnings?.[0]).toContain('PATTERN')
    expect(spec.warnings?.[0]).toContain('strokes')
  })

  it('emits no warnings field when every paint mapped', () => {
    const spec = toNodeSpec(
      {
        id: '7:3',
        type: 'RECTANGLE',
        fills: [
          {
            type: 'SOLID',
            color: { r: 0, g: 1, b: 0, a: 1 },
          },
        ],
      } as never,
      { depth: 0 },
    )
    expect('warnings' in spec).toBe(false)
  })
})

// ─── overrides report field NAMES, never a value ──────────────────────────────
//
// Figma's override record is `{id, overriddenFields}` — names only. The reader
// used to pad every entry with `value: ''`, which reads as "this override sets
// the field to blank". A live instance with its text overridden to a real
// string returned seven entries, every one `value: ""`. The field is
// report-only (expression-formats.md): it says WHICH fields differ, and the
// value is read from the node struct itself.
describe('toNodeSpec — overrides carry field names only', () => {
  it('emits path + field and no value key at all', () => {
    const spec = toNodeSpec(
      {
        id: '8:1',
        type: 'INSTANCE',
        overrides: [
          {
            id: 'I8:1;9:2',
            overriddenFields: ['characters', 'fills'],
          },
        ],
      } as never,
      { depth: 0 },
    )
    expect(spec.overrides).toEqual([
      { path: 'I8:1;9:2', field: 'characters' },
      { path: 'I8:1;9:2', field: 'fills' },
    ])
    for (const entry of spec.overrides ?? []) {
      // `in`, not toBeUndefined() — a present-but-undefined key still
      // serializes into the reply shape and must fail here.
      expect('value' in entry).toBe(false)
    }
  })

  it('omits overrides entirely when the raw export has none', () => {
    const spec = toNodeSpec(
      {
        id: '8:2',
        type: 'INSTANCE',
        overrides: [],
      } as never,
      { depth: 0 },
    )
    expect('overrides' in spec).toBe(false)
  })
})

// The mirror of the hidden-fill defect: effectArray filtered `visible !== false`,
// so a designer's hidden shadow vanished from the read and a read-modify-write
// deleted it. The grammar spells a hidden effect (`{vis=false}`, per
// expression-formats.md), so there was never anything to compress away.
describe('toNodeSpec — hidden effects survive the read', () => {
  const shadow = (visible?: boolean) => ({
    type: 'DROP_SHADOW',
    radius: 8,
    color: { r: 0, g: 0, b: 0, a: 0.25 },
    offset: { x: 0, y: 4 },
    ...(visible === false ? { visible: false } : {}),
  })

  it('keeps a hidden effect, marked vis=false, in order', () => {
    const spec = toNodeSpec(
      {
        id: '1:1',
        name: 'N',
        type: 'RECTANGLE',
        effects: [shadow(false), shadow()],
      } as never,
      { depth: 0 },
    )
    expect(spec.effects).toEqual([
      'shadow(0,4,8,#00000040){vis=false}',
      'shadow(0,4,8,#00000040)',
    ])
  })

  it('does not drop a node whose only effect is hidden', () => {
    const spec = toNodeSpec(
      {
        id: '1:1',
        name: 'N',
        type: 'RECTANGLE',
        effects: [shadow(false)],
      } as never,
      { depth: 0 },
    )
    expect(spec.effects).toEqual([
      'shadow(0,4,8,#00000040){vis=false}',
    ])
  })
})

// ─── text.runs (B15) ─────────────────────────────────────────────────────────
//
// `runs` is not a JSON_REST_V1 field — the plugin projects
// getStyledTextSegments into it (figma-plugin/src/text-runs.ts). Until that
// enrichment existed, runSpecs read a key nothing ever produced, so this whole
// half of the grammar was dead on arrival. These fixtures are the projection's
// own output shape.

describe('toNodeSpec — text.runs', () => {
  const mixedText = (
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id: '1:1',
    name: 'Mixed',
    type: 'TEXT',
    characters: 'Hello world',
    style: {
      fontFamily: 'Inter',
      fontStyle: 'Regular',
      fontSize: 12,
    },
    runs: [
      {
        at: [0, 5],
        style: {
          fontFamily: 'Inter',
          fontStyle: 'Bold',
          fontSize: 16,
        },
        color: [
          { type: 'SOLID', color: { r: 1, g: 0, b: 0 } },
        ],
      },
      {
        at: [5, 11],
        style: {
          fontFamily: 'Inter',
          fontStyle: 'Regular',
          fontSize: 12,
        },
      },
    ],
    ...extra,
  })

  it('renders each run as font/colour atoms scoped by at', () => {
    const spec = toNodeSpec(mixedText() as never, {
      depth: 0,
    })
    expect(spec.text?.runs).toEqual([
      {
        at: [0, 5],
        font: 'font(Inter,Bold,16)',
        color: '#FF0000',
      },
      { at: [5, 11], font: 'font(Inter,Regular,12)' },
    ])
  })

  it('carries lh/ls on the run font atom', () => {
    const spec = toNodeSpec(
      mixedText({
        runs: [
          {
            at: [0, 5],
            style: {
              fontFamily: 'Inter',
              fontStyle: 'Bold',
              fontSize: 16,
              lineHeightUnit: 'PIXELS',
              lineHeightPx: 24,
              letterSpacing: 0.5,
            },
          },
        ],
      }) as never,
      { depth: 0 },
    )
    expect(spec.text?.runs?.[0].font).toBe(
      'font(Inter,Bold,16){lh=24, ls=0.5}',
    )
  })

  it('emits no runs key for an ordinary single-style text', () => {
    const spec = toNodeSpec(
      mixedText({ runs: undefined }) as never,
      { depth: 0 },
    )
    expect(spec.text?.runs).toBeUndefined()
    expect(spec.warnings).toBeUndefined()
  })

  // T10: the plugin caps the projection. A short list is never allowed to look
  // like the whole truth.
  it('warns rather than truncating silently when the cap bit', () => {
    const spec = toNodeSpec(
      mixedText({ runsOmitted: 148 }) as never,
      { depth: 0 },
    )
    expect(spec.text?.runs).toHaveLength(2)
    expect(spec.warnings?.[0]).toContain('148')
    expect(spec.warnings?.[0]).toContain('text.runs')
  })

  it('a run the writer round-trips is the one the reader emitted', () => {
    const spec = toNodeSpec(mixedText() as never, {
      depth: 0,
    })
    const out = specToFigma(spec) as Record<string, unknown>
    const text = out.text as Record<string, unknown>
    const runs = text.runs as Record<string, unknown>[]
    expect(runs[0].at).toEqual([0, 5])
    expect(runs[0].font).toEqual({
      family: 'Inter',
      style: 'Bold',
      size: 16,
    })
    expect(runs[0].color).toMatchObject({
      type: 'SOLID',
      color: { r: 1, g: 0, b: 0 },
    })
  })
})
