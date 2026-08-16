// wrapper-names.test.ts — the reader renders both wrappers, by NAME, through
// the shared renderer (render-atom.ts's renderWrapper), never by
// hand-concatenating a raw Figma id.
//
// The plugin emits `bindingNames` on every node a read returns COMPLETE:
// `{ styles?: {[gramField]: styleName}, variables?: {[varId]: varName} }`.
// This suite asserts the reader consumes it correctly:
//   - a STYLED array field is the scalar reference, not a list of wrapped
//     leaves: `style(Name)[atom, atom]` (B47 — a styled field is a reference)
//   - a variable binding renders its NAME, never its id
//   - non-paint leaves (radius, stroke, effects, font) wrap too
//   - an unresolvable binding renders the BARE atom — never falls back to id
//   - a node with no `bindingNames` at all is unchanged
//   - `bindingNames` is read off EACH node's own raw (B23) — a descendant
//     wraps its own bindings, and inherits none from an ancestor

import { describe, expect, it } from 'bun:test'
import { toNodeSpec } from '@figma-agent-bridge/server/serialize/node-spec-reader'

// r=1, g=0, b=170/255 → rgbaToHex rounds to #FF00AA.
const FF00AA = { r: 1, g: 0, b: 170 / 255 }

describe('toNodeSpec — wrapper names (style/var render by name)', () => {
  it('a fills bound to a style is the SCALAR reference with its resolved list', () => {
    const raw: Record<string, unknown> = {
      id: '1:1',
      name: 'StyleBoundFill',
      type: 'FRAME',
      fills: [{ type: 'SOLID', color: FF00AA }],
      fillStyleId: 'S:abc123',
      bindingNames: { styles: { fill: 'Brand/Primary' } },
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.fills).toBe('style(Brand/Primary)[#FF00AA]')
  })

  // The brackets are ALWAYS there, so the form is parsed unconditionally
  // rather than sniffed — and a style holding two paints emits both, in order,
  // comma-space separated.
  it('a two-paint style emits both entries in one bracketed list', () => {
    const raw: Record<string, unknown> = {
      id: '1:1b',
      name: 'TwoPaintStyle',
      type: 'FRAME',
      fills: [
        { type: 'SOLID', color: FF00AA },
        {
          type: 'SOLID',
          color: { r: 0, g: 0, b: 0 },
          opacity: 0.5,
        },
      ],
      fillStyleId: 'S:abc123',
      bindingNames: { styles: { fill: 'Glass/Fill' } },
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.fills).toBe(
      'style(Glass/Fill)[#FF00AA, #00000080]',
    )
  })

  it('an UNSTYLED fills is still the array of atoms it has always been', () => {
    const raw: Record<string, unknown> = {
      id: '1:1c',
      name: 'PlainFill',
      type: 'FRAME',
      fills: [{ type: 'SOLID', color: FF00AA }],
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.fills).toEqual(['#FF00AA'])
  })

  it('no entry inside a styled list carries a wrapper of its own', () => {
    // The paint is ALSO variable-bound. The style owns the field, so it is
    // named once outside the list and the entries stay bare — otherwise a
    // read would emit two sources for one value.
    const raw: Record<string, unknown> = {
      id: '1:1d',
      name: 'StyleOverVar',
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
    expect(spec.fills).toBe('style(Brand/Primary)[#FF00AA]')
  })

  it('a grids bound to a style is the scalar reference too (the fourth slot)', () => {
    const raw: Record<string, unknown> = {
      id: '1:1e',
      name: 'GridBound',
      type: 'FRAME',
      layoutGrids: [
        {
          pattern: 'COLUMNS',
          alignment: 'STRETCH',
          count: 12,
          gutterSize: 24,
          offset: 0,
        },
      ],
      gridStyleId: 'S:grid1',
      bindingNames: {
        styles: { grid: 'Layout/12col' },
      },
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.grids).toBe(
      'style(Layout/12col)[columns(12,0,24)]',
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

  it('a UNIFORM per-corner radius with no flat cornerRadius still renders var(Name)<scalar>', () => {
    // B21. `bind_variable(field:'cornerRadius')` on a FRAME binds all four
    // corners; Figma then reports the value ONLY as a uniform
    // rectangleCornerRadii group and OMITS the flat `cornerRadius` key.
    // The reader used to derive its scalar from the per-corner array only
    // when the corners DIFFERED, so this shape produced no base at all and
    // the atom was dropped — losing the value AND the binding.
    const raw: Record<string, unknown> = {
      id: '1:3c',
      name: 'UniformRadiusBound',
      type: 'FRAME',
      rectangleCornerRadii: [8, 8, 8, 8],
      boundVariables: {
        rectangleCornerRadii: {
          RECTANGLE_TOP_LEFT_CORNER_RADIUS: {
            id: 'VariableID:7:7',
            type: 'VARIABLE_ALIAS',
          },
          RECTANGLE_TOP_RIGHT_CORNER_RADIUS: {
            id: 'VariableID:7:7',
            type: 'VARIABLE_ALIAS',
          },
          RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: {
            id: 'VariableID:7:7',
            type: 'VARIABLE_ALIAS',
          },
          RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: {
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
      strokes: [
        { type: 'SOLID', color: { r: 0, g: 0, b: 0 } },
      ],
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

  it('a strokes bound to a style is the scalar reference', () => {
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
    expect(spec.strokes).toBe(
      'style(Border/Default)[#000000]',
    )
  })

  it('an effects bound to a style is the scalar reference — always a list, even for one effect', () => {
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
    expect(spec.effects).toBe(
      'style(Shadow/Card)[shadow(0,2,4,#00000040)]',
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

  // B23: a descendant the read returns COMPLETE carries its own
  // `bindingNames`, so it renders its own wrapper — but only its own. The
  // root's names are never inherited: a child that reuses the same variable
  // id and carries no bindingNames of its own still renders the bare literal,
  // because the plugin resolved no name for it.
  it('a descendant renders the wrapper from its OWN bindingNames', () => {
    const raw: Record<string, unknown> = {
      id: 'root',
      name: 'Root',
      type: 'FRAME',
      children: [
        {
          id: 'child',
          name: 'Child',
          type: 'FRAME',
          bindingNames: {
            variables: { 'VariableID:9:9': 'brand/accent' },
          },
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
        },
      ],
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    const child = spec.children?.[0] as { fills?: string[] }
    expect(child.fills?.[0]).toBe(
      'var(brand/accent)#FF00AA',
    )
  })

  it('a descendant with no bindingNames of its own never inherits the root’s', () => {
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

  // B23 at a BOUNDED depth, which is the depth agents actually read at. The two
  // tests above ask for `depth: -1`, and "every level" is the one setting that
  // cannot tell a complete descendant from a lucky one. A `depth: 2` read has a
  // boundary, and the node that matters sits one level ABOVE it: an instance
  // sublayer, addressed by the compound id an instance mints, carrying both a
  // var() wrapper and a field JSON_REST_V1 has no column for. Both must be
  // there, and the level below must still be a stub — enrichment that reached
  // past the boundary would be paid for and thrown away.
  it('a depth-2 read serves its DEEPEST full node complete — wrapper and all', () => {
    const raw: Record<string, unknown> = {
      id: '1:100',
      name: 'Screen',
      type: 'FRAME',
      children: [
        {
          id: '1:200',
          name: 'Card',
          type: 'INSTANCE',
          children: [
            {
              // An instance sublayer: the id Figma composes for it, not a
              // plain scene-node id.
              id: 'I1:200;1:300',
              name: 'Icon',
              type: 'VECTOR',
              bindingNames: {
                variables: {
                  'VariableID:9:9': 'brand/accent',
                },
              },
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
              // REST serializes no vector geometry; the plugin patches it back
              // on. A descendant that got no patch reads as an empty shape.
              vectorPaths: [
                { windingRule: 'NONZERO', data: 'M 0 0' },
              ],
              children: [
                {
                  id: 'I1:200;1:400',
                  name: 'Glyph',
                  type: 'VECTOR',
                },
              ],
            },
          ],
        },
      ],
    }
    const spec = toNodeSpec(raw, { depth: 2 })
    const sublayer = spec.children?.[0]?.children?.[0] as {
      id?: string
      fills?: string[]
      vectorPaths?: unknown[]
      children?: { childCount?: number }[]
    }
    expect(sublayer.id).toBe('I1:200;1:300')
    // The wrapper — the channel REST cannot carry at all, because only the
    // plugin resolves a variable id to its name.
    expect(sublayer.fills?.[0]).toBe(
      'var(brand/accent)#FF00AA',
    )
    // …and the geometry, likewise patched on rather than exported.
    expect(sublayer.vectorPaths).toHaveLength(1)
    // The level past the boundary is a stub, not a second full node.
    expect(sublayer.children?.[0]).toHaveProperty(
      'childCount',
    )
    expect(sublayer.children?.[0]).not.toHaveProperty(
      'fills',
    )
  })
})
