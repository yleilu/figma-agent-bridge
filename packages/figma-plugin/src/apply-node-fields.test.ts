import { expect, test } from 'bun:test'

import {
  applyStrokeGeometry,
  applyExportSettings,
  applyGrids,
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
