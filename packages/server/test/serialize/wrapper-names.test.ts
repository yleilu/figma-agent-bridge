// wrapper-names.test.ts — the reader renders both wrappers, by NAME, through
// the shared renderer (render-atom.ts's renderWrapper), never by
// hand-concatenating a raw Figma id.
//
// Task 1 (plugin, already landed) emits `bindingNames` on the export ROOT
// only: `{ styles?: {[gramField]: styleName}, variables?: {[varId]: varName} }`.
// This suite asserts the reader consumes it correctly:
//   - a style binding wins over a variable binding on the same leaf
//   - a variable binding renders its NAME, never its id
//   - non-paint leaves (radius, stroke, effects, font) wrap too
//   - an unresolvable binding renders the BARE atom — never falls back to id
//   - a node with no `bindingNames` at all is unchanged
//   - `bindingNames` is never consulted for anything but the export ROOT
//     (T10) — even when a descendant happens to reuse the same variable id

import { describe, expect, it } from 'bun:test'
import { toNodeSpec } from '@figma-agent-bridge/server/serialize/node-spec-reader'

// r=1, g=0, b=170/255 → rgbaToHex rounds to #FF00AA.
const FF00AA = { r: 1, g: 0, b: 170 / 255 }

describe('toNodeSpec — wrapper names (style/var render by name)', () => {
  it('a paint bound to a style renders style(Name)<atom>', () => {
    const raw: Record<string, unknown> = {
      id: '1:1',
      name: 'StyleBoundFill',
      type: 'FRAME',
      fills: [{ type: 'SOLID', color: FF00AA }],
      fillStyleId: 'S:abc123',
      bindingNames: { styles: { fill: 'Brand/Primary' } },
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.fills?.[0]).toBe(
      'style(Brand/Primary)#FF00AA',
    )
  })

  it('a paint bound to a variable renders var(Name)<atom> — the name, not the id', () => {
    const raw: Record<string, unknown> = {
      id: '1:2',
      name: 'VarBoundFill',
      type: 'FRAME',
      fills: [
        {
          type: 'SOLID',
          color: FF00AA,
          boundVariables: {
            color: {
              id: 'VariableID:9:9',
              type: 'VARIABLE_ALIAS',
            },
          },
        },
      ],
      bindingNames: {
        variables: { 'VariableID:9:9': 'brand/accent' },
      },
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.fills?.[0]).toBe('var(brand/accent)#FF00AA')
    expect(spec.fills?.[0]).not.toContain('VariableID')
  })

  it('a style binding wins over a variable binding on the same leaf', () => {
    const raw: Record<string, unknown> = {
      id: '1:2b',
      name: 'BothBoundFill',
      type: 'FRAME',
      fills: [
        {
          type: 'SOLID',
          color: FF00AA,
          boundVariables: {
            color: {
              id: 'VariableID:9:9',
              type: 'VARIABLE_ALIAS',
            },
          },
        },
      ],
      fillStyleId: 'S:abc123',
      bindingNames: {
        styles: { fill: 'Brand/Primary' },
        variables: { 'VariableID:9:9': 'brand/accent' },
      },
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.fills?.[0]).toBe(
      'style(Brand/Primary)#FF00AA',
    )
  })

  it('a non-paint field (radius) bound to a variable renders var(Name)<atom>', () => {
    // JSON_REST_V1's OWN vocabulary nests a corner-radius binding under
    // rectangleCornerRadii.RECTANGLE_TOP_LEFT_CORNER_RADIUS — NOT a flat
    // `topLeftRadius` key like the Plugin API's node.boundVariables.
    // Live-verified (2026-07-31): bind_variable(field:'topLeftRadius') →
    // raw get_node reply carries exactly this nested shape.
    const raw: Record<string, unknown> = {
      id: '1:3',
      name: 'RadiusBound',
      type: 'FRAME',
      cornerRadius: 8,
      boundVariables: {
        rectangleCornerRadii: {
          RECTANGLE_TOP_LEFT_CORNER_RADIUS: {
            id: 'VariableID:7:7',
            type: 'VARIABLE_ALIAS',
          },
        },
      },
      bindingNames: {
        variables: { 'VariableID:7:7': 'radius/medium' },
      },
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.radius).toBe('var(radius/medium)8')
  })

  it('a stroke weight bound to a variable renders var(Name)stroke(...)', () => {
    // Same REST nesting quirk: individualStrokeWeights.BORDER_TOP_WEIGHT
    // (etc.), not a flat `strokeWeight` key. Live-verified (2026-07-31).
    const raw: Record<string, unknown> = {
      id: '1:3b',
      name: 'StrokeWeightBound',
      type: 'FRAME',
      strokeWeight: 4,
      boundVariables: {
        individualStrokeWeights: {
          BORDER_TOP_WEIGHT: {
            id: 'VariableID:8:8',
            type: 'VARIABLE_ALIAS',
          },
        },
      },
      bindingNames: {
        variables: {
          'VariableID:8:8': 'stroke/weight-medium',
        },
      },
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.stroke).toBe(
      'var(stroke/weight-medium)stroke(4)',
    )
  })

  it('a stroke bound to a style renders style(Name)<atom> on each stroke leaf', () => {
    const raw: Record<string, unknown> = {
      id: '1:4',
      name: 'StrokeBound',
      type: 'FRAME',
      strokes: [
        { type: 'SOLID', color: { r: 0, g: 0, b: 0 } },
      ],
      strokeStyleId: 'S:border1',
      bindingNames: {
        styles: { stroke: 'Border/Default' },
      },
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.strokes?.[0]).toBe(
      'style(Border/Default)#000000',
    )
  })

  it('an effects array bound to a style wraps every effect leaf', () => {
    const raw: Record<string, unknown> = {
      id: '1:5',
      name: 'EffectBound',
      type: 'FRAME',
      effects: [
        {
          type: 'DROP_SHADOW',
          radius: 4,
          offset: { x: 0, y: 2 },
          color: { r: 0, g: 0, b: 0, a: 0.25 },
        },
      ],
      effectStyleId: 'S:eff1',
      bindingNames: { styles: { effect: 'Shadow/Card' } },
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.effects?.[0]).toMatch(
      /^style\(Shadow\/Card\)shadow\(/,
    )
  })

  it('a text node bound to a style wraps the font atom', () => {
    const raw: Record<string, unknown> = {
      id: '1:6',
      name: 'TextBound',
      type: 'TEXT',
      characters: 'Hi',
      style: {
        fontFamily: 'Inter',
        fontStyle: 'Regular',
        fontSize: 16,
      },
      textStyleId: 'S:txt1',
      bindingNames: { styles: { text: 'Heading/H1' } },
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.text?.font).toBe(
      'style(Heading/H1)font(Inter,Regular,16)',
    )
  })

  it('a binding absent from bindingNames renders the bare atom — never the id', () => {
    const raw: Record<string, unknown> = {
      id: '1:7',
      name: 'UnresolvedVar',
      type: 'FRAME',
      fills: [
        {
          type: 'SOLID',
          color: FF00AA,
          boundVariables: {
            color: {
              id: 'VariableID:5:5',
              type: 'VARIABLE_ALIAS',
            },
          },
        },
      ],
      // bindingNames present, but doesn't know this particular id — the
      // plugin's own resolver failed/omitted it. Must NOT fall back to id.
      bindingNames: { variables: {} },
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.fills?.[0]).toBe('#FF00AA')
    expect(spec.fills?.[0]).not.toContain('VariableID')
    expect(spec.fills?.[0]).not.toContain('var(')
  })

  it('a node with no bindingNames at all is unchanged', () => {
    const raw: Record<string, unknown> = {
      id: '1:8',
      name: 'NoBindingNames',
      type: 'FRAME',
      fills: [
        {
          type: 'SOLID',
          color: FF00AA,
          boundVariables: {
            color: {
              id: 'VariableID:5:5',
              type: 'VARIABLE_ALIAS',
            },
          },
        },
      ],
      cornerRadius: 8,
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.fills?.[0]).toBe('#FF00AA')
    expect(spec.radius).toBe('8')
  })

  it('T10: bindingNames is never consulted below the export root, even when a descendant reuses the same variable id', () => {
    const raw: Record<string, unknown> = {
      id: 'root',
      name: 'Root',
      type: 'FRAME',
      bindingNames: {
        variables: { 'VariableID:9:9': 'brand/accent' },
      },
      children: [
        {
          id: 'child',
          name: 'Child',
          type: 'FRAME',
          fills: [
            {
              type: 'SOLID',
              color: FF00AA,
              // Same id the ROOT resolved a name for. If bindingNames were
              // (mis)threaded down to children, this would wrongly render
              // var(brand/accent)#FF00AA instead of the bare literal.
              boundVariables: {
                color: {
                  id: 'VariableID:9:9',
                  type: 'VARIABLE_ALIAS',
                },
              },
            },
          ],
        },
      ],
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    const child = spec.children?.[0] as { fills?: string[] }
    expect(child.fills?.[0]).toBe('#FF00AA')
  })
})
