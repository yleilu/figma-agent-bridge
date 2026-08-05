// wrapper-no-raw-id.test.ts — regression guard (SWEEP-X4): a rendered wrapper
// must NEVER contain a raw Figma id. This is the bug wrapper-names.test.ts's
// suite fixes — a style/variable binding either names its source or stays
// bare; it must never fall back to `style(S:...)`/`var(VariableID:...)`.

import { describe, expect, it } from 'bun:test'
import { toNodeSpec } from '@figma-agent-bridge/server/serialize/node-spec-reader'

// Matches a wrapper carrying a raw runtime id instead of a resolved name:
// var(VariableID:...) or style(S:...).
const RAW_ID = /(?:var|style)\((?:VariableID:|S:)/

describe('wrapper-no-raw-id guard', () => {
  it('liveness: the matcher fires on the shape it exists to forbid', () => {
    expect(RAW_ID.test('var(VariableID:1:2)#FFF')).toBe(true)
    expect(RAW_ID.test('style(S:1:2:0)#FFF')).toBe(true)
    expect(RAW_ID.test('var(radius/medium)8')).toBe(false)
    expect(RAW_ID.test('style(Brand/Primary)#FF00AA')).toBe(
      false,
    )
  })

  it('a fully-resolved Task 2 read carries no raw id anywhere', () => {
    const raw: Record<string, unknown> = {
      id: '1:1',
      name: 'Guard',
      type: 'FRAME',
      fills: [
        {
          type: 'SOLID',
          color: { r: 1, g: 0, b: 170 / 255 },
        },
      ],
      fillStyleId: 'S:abc123',
      strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
      strokeStyleId: 'S:border1',
      effects: [
        {
          type: 'DROP_SHADOW',
          radius: 4,
          offset: { x: 0, y: 2 },
          color: { r: 0, g: 0, b: 0, a: 0.25 },
        },
      ],
      effectStyleId: 'S:eff1',
      cornerRadius: 8,
      // REST-nested corner-radius binding shape (live-verified 2026-07-31) —
      // see node-spec-reader.ts's nodeBoundVariables doc comment.
      boundVariables: {
        rectangleCornerRadii: {
          RECTANGLE_TOP_LEFT_CORNER_RADIUS: {
            id: 'VariableID:7:7',
            type: 'VARIABLE_ALIAS',
          },
        },
      },
      bindingNames: {
        styles: {
          fill: 'Brand/Primary',
          stroke: 'Border/Default',
          effect: 'Shadow/Card',
        },
        variables: { 'VariableID:7:7': 'radius/medium' },
      },
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    const serialized = JSON.stringify(spec)
    expect(RAW_ID.test(serialized)).toBe(false)
    // Sanity: the wrappers DID render (the guard isn't vacuously passing
    // because nothing wrapped at all).
    expect(serialized).toContain('style(Brand/Primary)')
    expect(serialized).toContain('style(Border/Default)')
    expect(serialized).toContain('style(Shadow/Card)')
    expect(serialized).toContain('var(radius/medium)')
  })

  it('an UNRESOLVED binding renders bare (no wrapper) — never the id', () => {
    // Same shape, but bindingNames omits the radius id entirely (the
    // plugin's resolver couldn't name it). Must NOT fall back to the id.
    const raw: Record<string, unknown> = {
      id: '1:2',
      name: 'GuardUnresolved',
      type: 'FRAME',
      cornerRadius: 8,
      boundVariables: {
        rectangleCornerRadii: {
          RECTANGLE_TOP_LEFT_CORNER_RADIUS: {
            id: 'VariableID:9:9',
            type: 'VARIABLE_ALIAS',
          },
        },
      },
      bindingNames: { variables: {} },
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.radius).toBe('8')
    expect(RAW_ID.test(JSON.stringify(spec))).toBe(false)
  })
})
