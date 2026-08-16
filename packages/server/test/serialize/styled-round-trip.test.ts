// styled-round-trip.test.ts — every styled emission is writable verbatim, and
// writing it back changes nothing (T2, B47).
//
// The property, stated once and run over every styled slot: take a raw export
// whose field is style-governed, read it, write the emitted atom straight back,
// and the write must (a) apply the SAME style, (b) write no literals of its own
// — the style owns the field — and (c) warn about nothing at all, because the
// list the read emitted is by definition what the style supplies.

import { describe, expect, it } from 'bun:test'
import { toNodeSpec } from '@figma-agent-bridge/server/serialize/node-spec-reader'
import { specToFigma } from '@figma-agent-bridge/server/serialize/node-spec-writer'
import {
  resolveStyleReferences,
  type StyleCatalogue,
  type StyleTable,
} from '@figma-agent-bridge/server/serialize/style-refs'
import {
  readStyledField,
  type StyledField,
} from '@figma-agent-bridge/server/serialize/styled-fields'

const SOLID = (
  r: number,
  g: number,
  b: number,
  a = 1,
): Record<string, unknown> => ({
  type: 'SOLID',
  color: { r, g, b, a },
})

/**
 * The file the reference resolves against: the style holds EXACTLY what the
 * read said it holds. Built from the emission itself, which is the whole claim
 * under test — a read that reported something else would fail (c).
 */
const fileFor = (
  emission: string,
  field: StyledField,
  category: string,
): StyleCatalogue => {
  const value = readStyledField(field, emission)
  if (value.kind !== 'reference') {
    throw new Error(
      `the read emitted a literal list for ${field}: ${emission}`,
    )
  }
  const table: StyleTable = new Map([
    [
      value.name,
      [
        {
          name: value.name,
          category,
          atoms: value.rideAlong,
        },
      ],
    ],
  ])
  return { table: () => Promise.resolve(table) }
}

type Case = {
  what: string
  field: StyledField
  slot: string
  category: string
  raw: Record<string, unknown>
  emission: string
}

const CASES: Case[] = [
  {
    what: 'a one-paint fill style',
    field: 'fills',
    slot: 'fill',
    category: 'paint',
    raw: {
      id: '1:1',
      type: 'FRAME',
      fills: [SOLID(0.078, 0.106, 0.18, 0.6)],
      fillStyleId: 'S:1',
      bindingNames: { styles: { fill: 'Glass/Fill' } },
    },
    emission: 'style(Glass/Fill)[#141B2E99]',
  },
  {
    what: 'a two-paint fill style',
    field: 'fills',
    slot: 'fill',
    category: 'paint',
    raw: {
      id: '1:2',
      type: 'FRAME',
      fills: [SOLID(1, 0, 0), SOLID(0, 1, 0)],
      fillStyleId: 'S:1',
      bindingNames: { styles: { fill: 'Duo/Fill' } },
    },
    emission: 'style(Duo/Fill)[#FF0000, #00FF00]',
  },
  {
    what: 'a stroke style',
    field: 'strokes',
    slot: 'stroke',
    category: 'paint',
    raw: {
      id: '1:3',
      type: 'FRAME',
      strokes: [SOLID(0, 0, 0)],
      strokeStyleId: 'S:2',
      bindingNames: {
        styles: { stroke: 'Border/Default' },
      },
    },
    emission: 'style(Border/Default)[#000000]',
  },
  {
    what: 'a one-effect style (the always-list form)',
    field: 'effects',
    slot: 'effect',
    category: 'effect',
    raw: {
      id: '1:4',
      type: 'FRAME',
      effects: [{ type: 'BACKGROUND_BLUR', radius: 24 }],
      effectStyleId: 'S:3',
      bindingNames: { styles: { effect: 'AB/Blur' } },
    },
    emission: 'style(AB/Blur)[bg-blur(24)]',
  },
  {
    what: 'a two-effect style',
    field: 'effects',
    slot: 'effect',
    category: 'effect',
    raw: {
      id: '1:5',
      type: 'FRAME',
      effects: [
        { type: 'BACKGROUND_BLUR', radius: 24 },
        {
          type: 'DROP_SHADOW',
          radius: 24,
          offset: { x: 0, y: 8 },
          color: { r: 0, g: 0, b: 0, a: 0.4 },
        },
      ],
      effectStyleId: 'S:3',
      bindingNames: { styles: { effect: 'AB/Stack' } },
    },
    emission:
      'style(AB/Stack)[bg-blur(24), shadow(0,8,24,#00000066)]',
  },
  {
    what: 'a grid style',
    field: 'grids',
    slot: 'grid',
    category: 'grid',
    raw: {
      id: '1:6',
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
      gridStyleId: 'S:4',
      bindingNames: { styles: { grid: 'Layout/12col' } },
    },
    emission: 'style(Layout/12col)[columns(12,0,24)]',
  },
]

describe('styled slots round-trip verbatim', () => {
  for (const c of CASES) {
    it(`${c.what}: reads as the reference with its resolved list`, () => {
      const spec = toNodeSpec(c.raw, { depth: -1 })
      expect(spec[c.field]).toBe(c.emission)
    })

    it(`${c.what}: writing the emission back applies the style and no literals`, async () => {
      const spec = toNodeSpec(c.raw, { depth: -1 })
      const emission = spec[c.field] as string
      const warnings: string[] = []
      const payload = specToFigma(
        { [c.field]: emission },
        warnings,
      )
      await resolveStyleReferences(
        payload,
        fileFor(emission, c.field, c.category),
        warnings,
      )
      // (b) the style owns the field — nothing is written into it directly
      const written =
        c.field === 'grids' ? 'grids' : c.field
      expect(written in payload).toBe(false)
      // (a) the same style, by name, on the same slot
      expect(payload.bindings).toEqual([
        {
          kind: 'style',
          name: emission.slice(
            'style('.length,
            emission.indexOf(')'),
          ),
          field: c.slot,
        },
      ])
      // (c) a no-op says nothing
      expect(warnings).toEqual([])
    })
  }

  it('an UNSTYLED slot still emits its array — the literal path is untouched', () => {
    const spec = toNodeSpec(
      {
        id: '2:1',
        type: 'FRAME',
        fills: [SOLID(1, 0, 0)],
        effects: [{ type: 'BACKGROUND_BLUR', radius: 24 }],
        layoutGrids: [
          {
            pattern: 'COLUMNS',
            alignment: 'STRETCH',
            count: 12,
            gutterSize: 24,
            offset: 0,
          },
        ],
      },
      { depth: -1 },
    )
    expect(spec.fills).toEqual(['#FF0000'])
    expect(spec.effects).toEqual(['bg-blur(24)'])
    expect(spec.grids).toEqual(['columns(12,0,24)'])
  })

  // The composite case: a TEXT node whose FILL SLOT is style-governed. `fills`
  // and `text.color` are two spellings of that one slot, so the read emits both
  // — the array field as the REFERENCE, the scalar slot as the wrapper on its
  // atom — and the write-back must dedupe them into ONE binding, keep the
  // scalar literal the scalar-slot rule requires, and warn about nothing.
  it('a TEXT node with a styled fill slot round-trips both spellings as one binding', async () => {
    const raw = {
      id: '3:1',
      type: 'TEXT',
      characters: 'Hi',
      style: {
        fontFamily: 'Inter',
        fontStyle: 'Regular',
        fontSize: 16,
      },
      fills: [SOLID(0.231, 0.51, 0.965)],
      fillStyleId: 'S:1',
      bindingNames: { styles: { fill: 'Brand/Primary' } },
    }
    const spec = toNodeSpec(raw, { depth: -1 })
    expect(spec.fills).toBe('style(Brand/Primary)[#3B82F6]')
    expect(spec.text?.color).toBe(
      'style(Brand/Primary)#3B82F6',
    )

    const warnings: string[] = []
    const payload = specToFigma(
      {
        fills: spec.fills,
        text: {
          content: spec.text?.content ?? '',
          font: spec.text?.font ?? '',
          color: spec.text?.color,
        },
      },
      warnings,
    )
    await resolveStyleReferences(
      payload,
      fileFor(spec.fills as string, 'fills', 'paint'),
      warnings,
    )
    expect('fills' in payload).toBe(false)
    // The scalar slot keeps its literal — the array field is the reference.
    expect(
      (payload.text as { color?: unknown }).color,
    ).toBeDefined()
    // ONE binding, not two: the two spellings reach the same slot.
    expect(payload.bindings).toEqual([
      {
        kind: 'style',
        name: 'Brand/Primary',
        field: 'fill',
      },
    ])
    expect(warnings).toEqual([])
  })

  it('the scalar slots are untouched: text.font keeps the wrapper-on-its-atom form', () => {
    const spec = toNodeSpec(
      {
        id: '2:2',
        type: 'TEXT',
        characters: 'Hi',
        style: {
          fontFamily: 'Inter',
          fontStyle: 'Bold',
          fontSize: 32,
        },
        fills: [SOLID(1, 0, 0)],
        textStyleId: 'S:9',
        bindingNames: { styles: { text: 'Heading/H1' } },
      },
      { depth: -1 },
    )
    expect(spec.text?.font).toBe(
      'style(Heading/H1)font(Inter,Bold,32)',
    )
    // …and writing it back still resolves the font AND carries the binding.
    const payload = specToFigma({
      text: {
        content: 'Hi',
        font: spec.text?.font as string,
      },
    })
    expect(
      (payload.text as Record<string, unknown>).font,
    ).toEqual({
      family: 'Inter',
      style: 'Bold',
      size: 32,
    })
    expect(payload.bindings).toEqual([
      { kind: 'style', name: 'Heading/H1', field: 'text' },
    ])
  })

  it('var() is untouched: it wraps an ENTRY inside a literal array', () => {
    const spec = toNodeSpec(
      {
        id: '2:3',
        type: 'FRAME',
        fills: [
          {
            ...SOLID(0.078, 0.106, 0.18),
            boundVariables: {
              color: {
                id: 'VariableID:1:1',
                type: 'VARIABLE_ALIAS',
              },
            },
          },
          SOLID(1, 1, 1, 0.125),
        ],
        bindingNames: {
          variables: { 'VariableID:1:1': 'surface/2' },
        },
      },
      { depth: -1 },
    )
    expect(spec.fills).toEqual([
      'var(surface/2)#141B2E',
      '#FFFFFF20',
    ])
    const payload = specToFigma({ fills: spec.fills })
    expect(payload.fills).toHaveLength(2)
    expect(payload.bindings).toEqual([
      {
        kind: 'var',
        name: 'surface/2',
        field: 'fills',
        index: 0,
      },
    ])
  })
})
