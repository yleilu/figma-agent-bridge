import { expect, test } from 'bun:test'

import {
  applyStrokeGeometry,
  applyStrokeWeights,
  applyExportSettings,
  applyGrids,
  capabilityWarnings,
} from './apply-node-fields'

// ─── applyStrokeGeometry ───────────────────────────────────────────────────

test('applyStrokeGeometry: assigns cap/join/miter when the target carries them', () => {
  const node = {
    strokeCap: 'NONE',
    strokeJoin: 'MITER',
    strokeMiterLimit: 4,
  }
  applyStrokeGeometry(node, {
    strokeCap: 'ROUND',
    strokeJoin: 'ROUND',
    strokeMiterLimit: 10,
  })
  expect(node.strokeCap).toBe('ROUND')
  expect(node.strokeJoin).toBe('ROUND')
  expect(node.strokeMiterLimit).toBe(10)
})

test('applyStrokeGeometry: T7 no-op — nothing assigned, nothing thrown, when the target lacks the properties', () => {
  const node = {}
  expect(() =>
    applyStrokeGeometry(node, {
      strokeCap: 'ROUND',
      strokeJoin: 'ROUND',
      strokeMiterLimit: 10,
    }),
  ).not.toThrow()
  expect(node).toEqual({})
})

test('applyStrokeGeometry: undefined spec values leave existing node values untouched (omission ≠ clear)', () => {
  const node = {
    strokeCap: 'SQUARE',
    strokeJoin: 'BEVEL',
    strokeMiterLimit: 6,
  }
  applyStrokeGeometry(node, {})
  expect(node.strokeCap).toBe('SQUARE')
  expect(node.strokeJoin).toBe('BEVEL')
  expect(node.strokeMiterLimit).toBe(6)
})

test('applyStrokeGeometry: each field is independent — a target missing only one property still gets the others', () => {
  const node: { strokeCap: unknown; strokeJoin: unknown } = {
    strokeCap: 'NONE',
    strokeJoin: 'MITER',
  }
  applyStrokeGeometry(node, {
    strokeCap: 'ROUND',
    strokeJoin: 'ROUND',
    strokeMiterLimit: 10,
  })
  expect(node.strokeCap).toBe('ROUND')
  expect(node.strokeJoin).toBe('ROUND')
  expect('strokeMiterLimit' in node).toBe(false)
})

// ─── applyStrokeWeights (B27) ──────────────────────────────────────────────
//
// `stroke([0,0,1,0])` — a bottom-only divider — is the commonest rule in
// table/list design, and collapsing it to the top side made it weight 0, i.e.
// invisible. Figma carries the four sides on frame-like and RECTANGLE nodes
// (IndividualStrokesMixin); everything else keeps the collapse, now WHERE the
// node type is known (T7).

test('applyStrokeWeights: assigns all four sides when the target carries them', () => {
  const node = {
    strokeWeight: 1,
    strokeTopWeight: 1,
    strokeRightWeight: 1,
    strokeBottomWeight: 1,
    strokeLeftWeight: 1,
  }
  const warnings: string[] = []
  applyStrokeWeights(node, [0, 0, 1, 0], warnings)
  expect(node.strokeTopWeight).toBe(0)
  expect(node.strokeRightWeight).toBe(0)
  expect(node.strokeBottomWeight).toBe(1)
  expect(node.strokeLeftWeight).toBe(0)
  expect(warnings).toHaveLength(0)
})

test('applyStrokeWeights: a target without per-side support collapses to the top side and says so', () => {
  const node: {
    type: string
    strokeWeight: number
  } = { type: 'VECTOR', strokeWeight: 1 }
  const warnings: string[] = []
  applyStrokeWeights(node, [0, 0, 1, 0], warnings)
  expect(node.strokeWeight).toBe(0)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain(
    'collapsed to a single strokeWeight',
  )
  expect(warnings[0]).toContain('VECTOR')
})

test('applyStrokeWeights: a target with no stroke weight at all warns and assigns nothing', () => {
  const node = { type: 'SLICE' }
  const warnings: string[] = []
  expect(() =>
    applyStrokeWeights(node, [0, 0, 1, 0], warnings),
  ).not.toThrow()
  expect(node).toEqual({ type: 'SLICE' })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('SLICE')
})

test('applyStrokeWeights: an absent spec key leaves every side untouched (omission ≠ clear)', () => {
  const node = {
    strokeTopWeight: 3,
    strokeRightWeight: 3,
    strokeBottomWeight: 3,
    strokeLeftWeight: 3,
  }
  applyStrokeWeights(node, undefined, [])
  expect(node.strokeTopWeight).toBe(3)
  expect(node.strokeBottomWeight).toBe(3)
})

test('applyStrokeWeights: a malformed tuple is ignored, not half-applied', () => {
  const node = {
    strokeTopWeight: 3,
    strokeRightWeight: 3,
    strokeBottomWeight: 3,
    strokeLeftWeight: 3,
  }
  const warnings: string[] = []
  applyStrokeWeights(node, [1, 2] as never, warnings)
  expect(node.strokeTopWeight).toBe(3)
  expect(warnings).toHaveLength(1)
})

// ─── applyExportSettings ────────────────────────────────────────────────────

test('applyExportSettings: assigns when the target carries exportSettings', () => {
  const node: { exportSettings: unknown } = {
    exportSettings: [],
  }
  const settings = [
    { format: 'PNG', suffix: '@2x', constraint: { type: 'SCALE', value: 2 } },
  ]
  applyExportSettings(node, settings)
  expect(node.exportSettings).toEqual(settings)
})

test('applyExportSettings: T7 no-op — nothing assigned, nothing thrown, when the target lacks exportSettings', () => {
  const node = {}
  expect(() =>
    applyExportSettings(node, [{ format: 'PNG' }]),
  ).not.toThrow()
  expect(node).toEqual({})
})

test('applyExportSettings: undefined settings leaves an existing node value untouched (omission ≠ clear)', () => {
  const existing = [{ format: 'SVG' }]
  const node: { exportSettings: unknown } = {
    exportSettings: existing,
  }
  applyExportSettings(node, undefined)
  expect(node.exportSettings).toBe(existing)
})

test('applyExportSettings: revives the wire-format constraint tuple to Figma\'s {type,value} object', () => {
  const node: { exportSettings: unknown } = {
    exportSettings: [],
  }
  applyExportSettings(node, [
    { format: 'PNG', suffix: '@2x', constraint: ['SCALE', 2] },
  ])
  expect(node.exportSettings).toEqual([
    {
      format: 'PNG',
      suffix: '@2x',
      constraint: { type: 'SCALE', value: 2 },
    },
  ])
})

test('applyExportSettings: a setting with no constraint passes through untouched', () => {
  const node: { exportSettings: unknown } = {
    exportSettings: [],
  }
  applyExportSettings(node, [{ format: 'SVG' }])
  expect(node.exportSettings).toEqual([{ format: 'SVG' }])
})

// ─── applyGrids ─────────────────────────────────────────────────────────────

test('applyGrids: assigns to layoutGrids (not grids) when the target carries it', () => {
  const node: { layoutGrids: unknown } = { layoutGrids: [] }
  const grids = [{ pattern: 'COLUMNS', count: 12 }]
  applyGrids(node, grids)
  expect(node.layoutGrids).toBe(grids)
  expect('grids' in node).toBe(false)
})

test('applyGrids: T7 no-op — nothing assigned, nothing thrown, when the target lacks layoutGrids', () => {
  const node = {}
  expect(() =>
    applyGrids(node, [{ pattern: 'COLUMNS', count: 12 }]),
  ).not.toThrow()
  expect(node).toEqual({})
})

test('applyGrids: undefined grids leaves an existing node value untouched (omission ≠ clear)', () => {
  const existing = [{ pattern: 'ROWS', count: 4 }]
  const node: { layoutGrids: unknown } = {
    layoutGrids: existing,
  }
  applyGrids(node, undefined)
  expect(node.layoutGrids).toBe(existing)
})

// ─── capabilityWarnings ─────────────────────────────────────────────────────

test('capabilityWarnings: says nothing when the node carries every field asked for', () => {
  const node = {
    type: 'FRAME',
    layoutMode: 'NONE',
    fills: [],
    opacity: 1,
  }
  expect(
    capabilityWarnings(node, {
      layout: { mode: 'V' },
      fills: [],
      opacity: 0.5,
    }),
  ).toEqual([])
})

test('capabilityWarnings: names each dropped field and the node type that dropped it', () => {
  const slot = { type: 'SLOT', fills: [] }
  expect(
    capabilityWarnings(slot, {
      fills: [],
      layout: { mode: 'V' },
      text: { content: 'hi' },
    }),
  ).toEqual([
    'layout ignored — not supported on a SLOT node',
    'text ignored — not supported on a SLOT node',
  ])
})

test('capabilityWarnings: a text struct on a non-TEXT node is named, not silently dropped', () => {
  // applyTextProperties runs only for TEXT, so without this row the whole
  // struct vanishes with no reply to show for it.
  expect(
    capabilityWarnings({ type: 'RECTANGLE' }, {
      text: { content: 'hi' },
    }),
  ).toEqual([
    'text ignored — not supported on a RECTANGLE node',
  ])
  expect(
    capabilityWarnings(
      { type: 'TEXT', characters: '' },
      { text: { content: 'hi' } },
    ),
  ).toEqual([])
})

test('capabilityWarnings: an omitted field is never warned about (omission ≠ request)', () => {
  expect(capabilityWarnings({ type: 'SLICE' }, {})).toEqual(
    [],
  )
})
