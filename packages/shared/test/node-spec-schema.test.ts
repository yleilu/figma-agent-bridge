// packages/shared/test/node-spec-schema.test.ts
import { describe, expect, it } from 'bun:test'
import type { z } from 'zod'
import {
  nodeSpecSchema,
  partialNodeSpecSchema,
  treeNodeSpecSchema,
  layoutSpecSchema,
  textSpecSchema,
  exportSettingSchema,
} from '@figma-agent-bridge/shared/node-spec-schema'
import type {
  NodeSpec,
  LayoutSpec,
  TextSpec,
  ExportSetting,
  TreeNodeSpec,
} from '@figma-agent-bridge/shared/node-spec'

// --- compile-time: schema infer === hand-written type ---
// If a field drifts between node-spec.ts and node-spec-schema.ts this
// fails `bun run typecheck` (the suite is the gate, like ws-schemas).
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <
    T,
  >() => T extends B ? 1 : 2
    ? true
    : false
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time assertion only
const assertEqual = <Constraint extends true>(): void =>
  undefined

assertEqual<
  Equal<z.infer<typeof layoutSpecSchema>, LayoutSpec>
>()
assertEqual<
  Equal<z.infer<typeof textSpecSchema>, TextSpec>
>()
assertEqual<
  Equal<z.infer<typeof exportSettingSchema>, ExportSetting>
>()
assertEqual<
  Equal<z.infer<typeof nodeSpecSchema>, NodeSpec>
>()

// --- a representative full NodeSpec: a card with auto-layout, text,
// fills atoms, stroke/effects atoms, export presets, and children. ---
const card: NodeSpec = {
  type: 'FRAME',
  name: 'Card',
  id: '12:34',
  size: [320, 180],
  position: [0, 0],
  layoutPositioning: 'AUTO',
  layout: {
    mode: 'V',
    gap: 8,
    pad: [16, 16, 16, 16],
    align: ['MIN', 'MIN'],
    wrap: false,
  },
  sizing: ['FIXED', 'HUG'],
  constraints: ['MIN', 'MIN'],
  minWidth: 200,
  maxWidth: null,
  minHeight: null,
  maxHeight: null,
  fills: [
    'solid(#FFFFFF)',
    'linear(135, #3B82F6@0, #1D4ED8@100){op=0.08}',
  ],
  strokes: ['#E5E7EB'],
  stroke: 'stroke(1, {align=INSIDE})',
  effects: ['shadow(0,4,12,#0000001A){spread=0}'],
  radius: '12',
  opacity: 1,
  rotation: 0,
  blend: 'NORMAL',
  visible: true,
  clipsContent: true,
  grids: ['columns(12,32,auto){align=STRETCH, offset=16}'],
  exportSettings: [
    {
      format: 'PNG',
      suffix: '@2x',
      constraint: ['SCALE', 2],
    },
  ],
  children: [
    {
      type: 'TEXT',
      name: 'Title',
      text: {
        content: 'Monthly report',
        font: 'style(Heading/H3)font(Inter,SemiBold,18){lh=24}',
        color: '#111827',
        align: 'LEFT',
        runs: [
          {
            at: [0, 7],
            font: 'font(Inter,Bold,18)',
            color: '#FF0000',
          },
        ],
      },
    },
    {
      type: 'TEXT',
      name: 'Caption',
      text: {
        content: 'Updated today',
        font: 'font(Inter,Regular,13)',
        color: '#6B7280',
      },
    },
  ],
}

describe('nodeSpecSchema', () => {
  it('validates a representative full card spec', () => {
    const r = nodeSpecSchema.safeParse(card)
    expect(r.success).toBe(true)
  })

  it('round-trips deep-equal (no field dropped, no default injected) — T2', () => {
    // DoD §1.6 / plan §1.5: parse must not strip a field or inject a
    // default — a future .default()/.transform()/.strip() on any field
    // would break the round-trip law (T2) while every safeParse test
    // above stayed green.
    expect(nodeSpecSchema.parse(card)).toStrictEqual(card)
  })

  it('parses an INSTANCE with component ref + overrides + component props', () => {
    const instance: NodeSpec = {
      type: 'INSTANCE',
      name: 'Button/Primary',
      id: '5:6',
      size: [120, 40],
      component: {
        id: '2:10',
        properties: { Label: 'Save', Disabled: false },
      },
      componentProperties: {
        Label: 'Save',
        Disabled: false,
      },
      variantProperties: {
        Size: 'Large',
        State: 'Default',
      },
      overrides: [
        {
          path: 'Label',
          field: 'characters',
          value: 'Save changes',
        },
      ],
    }
    expect(nodeSpecSchema.safeParse(instance).success).toBe(
      true,
    )
  })

  it('parses an INSTANCE with a component ref by published key', () => {
    const instance: NodeSpec = {
      type: 'INSTANCE',
      name: 'Card',
      component: { key: 'btn-key-123' },
    }
    expect(nodeSpecSchema.safeParse(instance).success).toBe(
      true,
    )
  })

  it('rejects a malformed spec (missing type)', () => {
    const bad = { name: 'No type', size: [10, 10] }
    expect(nodeSpecSchema.safeParse(bad).success).toBe(
      false,
    )
  })

  it('rejects a malformed leaf (fills not an array of strings)', () => {
    const bad = { type: 'FRAME', fills: [{ color: 'red' }] }
    expect(nodeSpecSchema.safeParse(bad).success).toBe(
      false,
    )
  })

  it('rejects a malformed layout mode', () => {
    const bad = {
      type: 'FRAME',
      layout: { mode: 'DIAGONAL' },
    }
    expect(nodeSpecSchema.safeParse(bad).success).toBe(
      false,
    )
  })

  it('accepts optional string context and rejects non-string', () => {
    expect(
      nodeSpecSchema.safeParse({
        type: 'FRAME',
        name: 'x',
        context: '---\n',
      }).success,
    ).toBe(true)
    expect(
      nodeSpecSchema.safeParse({
        type: 'FRAME',
        name: 'x',
        context: 123,
      }).success,
    ).toBe(false)
    expect(
      nodeSpecSchema.safeParse({ type: 'FRAME', name: 'x' })
        .success,
    ).toBe(true) // omitted ok
  })
})

describe('partialNodeSpecSchema (update_node)', () => {
  it('accepts a single-field patch (fills only)', () => {
    const r = partialNodeSpecSchema.safeParse({
      fills: ['#0A0A0A'],
    })
    expect(r.success).toBe(true)
  })

  it('accepts an empty patch', () => {
    expect(
      partialNodeSpecSchema.safeParse({}).success,
    ).toBe(true)
  })

  it('accepts a patch omitting type (type is optional here)', () => {
    const r = partialNodeSpecSchema.safeParse({
      name: 'Renamed',
      opacity: 0.5,
    })
    expect(r.success).toBe(true)
  })

  it('still rejects a malformed value in a patch', () => {
    const r = partialNodeSpecSchema.safeParse({
      opacity: 'half',
    })
    expect(r.success).toBe(false)
  })
})

describe('treeNodeSpecSchema (recursive)', () => {
  it('validates nested children', () => {
    const tree: TreeNodeSpec = {
      type: 'FRAME',
      name: 'Root',
      children: [
        {
          type: 'FRAME',
          name: 'Row',
          children: [{ type: 'TEXT', name: 'Leaf' }],
        },
      ],
    }
    expect(treeNodeSpecSchema.safeParse(tree).success).toBe(
      true,
    )
  })

  it('validates a { ref } pool reference', () => {
    expect(
      treeNodeSpecSchema.safeParse({ ref: 'card' }).success,
    ).toBe(true)
  })

  it('validates an { id } clone reference', () => {
    expect(
      treeNodeSpecSchema.safeParse({ id: '12:34' }).success,
    ).toBe(true)
  })

  it('rejects a malformed nested child', () => {
    const bad = {
      type: 'FRAME',
      children: [{ name: 'no type' }],
    }
    expect(treeNodeSpecSchema.safeParse(bad).success).toBe(
      false,
    )
  })
})

describe('sub-schemas', () => {
  it('layoutSpecSchema validates a NONE mode (auto-layout off)', () => {
    expect(
      layoutSpecSchema.safeParse({ mode: 'NONE' }).success,
    ).toBe(true)
  })

  it('layoutSpecSchema validates GRID mode with all grid keys', () => {
    expect(
      layoutSpecSchema.safeParse({
        mode: 'GRID',
        rows: 2,
        cols: 3,
        rowGap: 8,
        colGap: 12,
      }).success,
    ).toBe(true)
  })

  it('layoutSpecSchema validates GRID mode with no grid keys (bare grid)', () => {
    expect(
      layoutSpecSchema.safeParse({ mode: 'GRID' }).success,
    ).toBe(true)
  })

  it('layoutSpecSchema rejects negative rowGap (nonnegative constraint)', () => {
    expect(
      layoutSpecSchema.safeParse({
        mode: 'GRID',
        rowGap: -1,
      }).success,
    ).toBe(false)
  })

  it('layoutSpecSchema rejects non-integer rows (int constraint)', () => {
    expect(
      layoutSpecSchema.safeParse({
        mode: 'GRID',
        rows: 1.5,
      }).success,
    ).toBe(false)
  })

  it('layoutSpecSchema rejects zero rows (positive constraint)', () => {
    expect(
      layoutSpecSchema.safeParse({
        mode: 'GRID',
        rows: 0,
      }).success,
    ).toBe(false)
  })

  it('textSpecSchema requires content + font', () => {
    expect(
      textSpecSchema.safeParse({
        content: 'Hi',
        font: 'font(Inter,Regular,14)',
      }).success,
    ).toBe(true)
    expect(
      textSpecSchema.safeParse({ content: 'Hi' }).success,
    ).toBe(false)
  })

  it('exportSettingSchema validates a preset', () => {
    expect(
      exportSettingSchema.safeParse({
        format: 'SVG',
      }).success,
    ).toBe(true)
    expect(
      exportSettingSchema.safeParse({
        format: 'GIF',
      }).success,
    ).toBe(false)
  })
})

describe('nodeSpecSchema — vectorPaths field', () => {
  it('accepts a VECTOR spec with vectorPaths as string atoms', () => {
    const r = nodeSpecSchema.safeParse({
      type: 'VECTOR',
      vectorPaths: ['path(NONZERO,"M0 0 L10 0 Z")'],
    })
    expect(r.success).toBe(true)
  })

  it('the vectorPaths field survives schema parse unchanged (T2)', () => {
    const spec = {
      type: 'VECTOR',
      vectorPaths: ['path(NONZERO,"M0 0 L10 0 Z")'],
    }
    const parsed = nodeSpecSchema.parse(spec)
    expect(parsed.vectorPaths).toEqual([
      'path(NONZERO,"M0 0 L10 0 Z")',
    ])
  })

  it('accepts FRAME spec with vectorPaths omitted (optional field)', () => {
    const r = nodeSpecSchema.safeParse({ type: 'FRAME' })
    expect(r.success).toBe(true)
  })

  it('rejects vectorPaths where elements are not strings', () => {
    const r = nodeSpecSchema.safeParse({
      type: 'VECTOR',
      vectorPaths: [
        { windingRule: 'NONZERO', data: 'M0 0' },
      ],
    })
    expect(r.success).toBe(false)
  })
})
