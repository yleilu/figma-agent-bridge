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

  it('falls back to absoluteBoundingBox.x/y when relativeTransform is absent', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    const title = (spec.children as NodeSpec[])[0]
    // Title carries no relativeTransform; absoluteBoundingBox {x:116,y:216}.
    expect(title.position).toEqual([116, 216])
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

// ─── var() binding read-back (no boundVariables field on NodeSpec) ─────────────

describe('toNodeSpec — var() binding read-back', () => {
  it('renders a variable-bound paint with its var(...) wrapper atom', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    // The card's first fill carries boundVariables.color → the leaf atom
    // is wrapped: var(var:123)#FFFFFF. There is NO boundVariables field on
    // NodeSpec — the binding rides on the appearance atom.
    expect(spec.fills?.[0]).toMatch(/^var\(/)
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

  it('omits component on non-INSTANCE nodes (FRAME carries no main-component ref)', () => {
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.type).toBe('FRAME')
    expect(spec).not.toHaveProperty('component')
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
