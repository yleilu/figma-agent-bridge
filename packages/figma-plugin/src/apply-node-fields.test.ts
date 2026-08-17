import { expect, test } from 'bun:test'

import {
  applySize,
  applySizeVerified,
  applyStrokeGeometry,
  applyStrokeWeights,
  applyExportSettings,
  applyGrids,
  capabilityWarnings,
  discardedPositionsWarning,
  statedPositionWarning,
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

test('capabilityWarnings: B45 — path data patched onto a node that carries none is named', () => {
  // update_node's vectorPaths arm applies only where the node HAS the field.
  // Everywhere else the geometry has nowhere to go, and the drop is this row.
  expect(
    capabilityWarnings({ type: 'RECTANGLE' }, {
      vectorPaths: [{ windingRule: 'NONZERO', data: 'M0 0' }],
    }),
  ).toEqual([
    'vectorPaths ignored — not supported on a RECTANGLE node',
  ])
  expect(
    capabilityWarnings(
      { type: 'VECTOR', vectorPaths: [] },
      {
        vectorPaths: [
          { windingRule: 'NONZERO', data: 'M0 0' },
        ],
      },
    ),
  ).toEqual([])
})

test('capabilityWarnings: an omitted field is never warned about (omission ≠ request)', () => {
  expect(capabilityWarnings({ type: 'SLICE' }, {})).toEqual(
    [],
  )
})

// ─── applySize (B46) ────────────────────────────────────────────────────────

/**
 * A fake node whose `resize` behaves the way one Figma target does. `takes`
 * decides whether the call lands, so one factory covers the node that resizes,
 * the node that silently refuses, and the node that throws.
 */
const sizeNode = (
  overrides: Record<string, unknown> = {},
  takes: 'yes' | 'no' | 'throw' = 'yes',
): Record<string, unknown> => {
  const node: Record<string, unknown> = {
    type: 'RECTANGLE',
    name: 'Bar',
    width: 40,
    height: 20,
    resize(w: number, h: number) {
      if (takes === 'throw') {
        throw new Error('nope')
      }
      if (takes === 'yes') {
        node.width = w
        node.height = h
      }
    },
    ...overrides,
  }
  return node
}

test('applySize: resizes the node and says nothing when the size lands', () => {
  const warnings: string[] = []
  const node = sizeNode()
  applySizeVerified(node, [60, 30], warnings)
  expect(node.width).toBe(60)
  expect(node.height).toBe(30)
  expect(warnings).toEqual([])
})

test('applySize: an omitted size is not a request — nothing resized, nothing warned', () => {
  const warnings: string[] = []
  const node = sizeNode()
  applySizeVerified(node, undefined, warnings)
  expect(node.width).toBe(40)
  expect(warnings).toEqual([])
})

test('applySize: a target with no resize method is named, not silently skipped', () => {
  const warnings: string[] = []
  applySizeVerified({ type: 'PAGE' }, [60, 30], warnings)
  expect(warnings).toEqual([
    'size ignored — a PAGE node cannot be resized',
  ])
})

test('applySize: B46 — a size Figma accepts and ignores is reported, not returned as success', () => {
  const warnings: string[] = []
  const node = sizeNode({}, 'no')
  applySizeVerified(node, [60, 30], warnings)
  expect(node.width).toBe(40)
  expect(warnings.length).toBe(1)
  expect(warnings[0]).toContain('size not applied')
  expect(warnings[0]).toContain('asked [60, 30]')
  expect(warnings[0]).toContain('reads [40, 20]')
})

test('applySize: B46 — an instance sublayer names the instance it sits in', () => {
  const warnings: string[] = []
  const node = sizeNode(
    {
      parent: {
        type: 'FRAME',
        name: 'Row',
        parent: { type: 'INSTANCE', name: 'Card' },
      },
    },
    'no',
  )
  applySizeVerified(node, [60, 30], warnings)
  expect(warnings[0]).toContain(
    'sublayer of the instance "Card"',
  )
  expect(warnings[0]).toContain(
    'Resize the main component',
  )
})

test('applySize: B46 — a flexible auto-layout axis is named with the sizing that owns it', () => {
  const warnings: string[] = []
  const node = sizeNode(
    {
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'FIXED',
      // An instance ancestor as well: the axis is the actionable cause, so it
      // is the one reported.
      parent: { type: 'INSTANCE', name: 'Card' },
    },
    'no',
  )
  applySizeVerified(node, [60, 30], warnings)
  expect(warnings[0]).toContain(
    'Auto-layout owns the width (layoutSizingHorizontal: FILL)',
  )
  expect(warnings[0]).not.toContain('sublayer')
})

test('applySize: B46 — a self-sizing text node names its autoResize', () => {
  const warnings: string[] = []
  const node = sizeNode(
    { type: 'TEXT', textAutoResize: 'HEIGHT' },
    'no',
  )
  applySizeVerified(node, [60, 30], warnings)
  expect(warnings[0]).toContain('textAutoResize: HEIGHT')
  // The advice names a field the surface HAS. `text.autoResize` is not one —
  // the write face emits no such key, so an agent following it would get an
  // unknown-key warning and no fix.
  expect(warnings[0]).toContain(
    'sizing:["FIXED","FIXED"]',
  )
})

test('applySize: a refusal that throws degrades to one warning, keeping the rest of the patch', () => {
  const warnings: string[] = []
  const node = sizeNode({}, 'throw')
  expect(() =>
    applySizeVerified(node, [60, 30], warnings),
  ).not.toThrow()
  expect(warnings).toEqual([
    'size rejected by Figma: Error: nope',
  ])
})

test('applySize: resizeWithoutConstraints is the second chance, and a size it lands warns nothing', () => {
  const warnings: string[] = []
  const node = sizeNode({}, 'no')
  node.resizeWithoutConstraints = (
    w: number,
    h: number,
  ): void => {
    node.width = w
    node.height = h
  }
  applySizeVerified(node, [60, 30], warnings)
  expect(node.width).toBe(60)
  expect(warnings).toEqual([])
})

test('applySize: a second-chance throw still reports the mismatch rather than escaping', () => {
  const warnings: string[] = []
  const node = sizeNode({}, 'no')
  node.resizeWithoutConstraints = (): void => {
    throw new Error('also nope')
  }
  expect(() =>
    applySizeVerified(node, [60, 30], warnings),
  ).not.toThrow()
  expect(warnings.length).toBe(1)
  expect(warnings[0]).toContain('size not applied')
})

test('applySize: the create arm is unchanged — no read-back, and a throw still stands', () => {
  const warnings: string[] = []
  const ignored = sizeNode({}, 'no')
  applySize(ignored, [60, 30], warnings)
  expect(warnings).toEqual([])
  expect(() =>
    applySize(sizeNode({}, 'throw'), [60, 30], warnings),
  ).toThrow('nope')
})

test('applySizeVerified: a node that exposes no width/height is not accused of refusing', () => {
  const warnings: string[] = []
  const node: Record<string, unknown> = {
    type: 'SLOT',
    resize() {},
  }
  applySizeVerified(node, [60, 30], warnings)
  expect(warnings).toEqual([])
})

test('applySizeVerified: a sub-0.01px difference is float noise, not a discard', () => {
  const warnings: string[] = []
  const node = sizeNode({}, 'no')
  applySizeVerified(node, [40.005, 20], warnings)
  expect(warnings).toEqual([])
})

// The `sizing` interaction. `applySizeVerified` runs AFTER the patch's `sizing`
// has landed on the node, so these two model the node as it IS at that moment,
// which is the whole point of moving the call.

test('applySizeVerified: B46(a) — a size patched together with a FIXED pin lands, and warns nothing', () => {
  // The node hugged when the patch arrived. `sizing:['FIXED','FIXED']` is
  // applied first now, so by the time the size is written the node takes it.
  // Before the reorder this re-emitted the very warning the patch had already
  // acted on, and still left the size unlanded — three calls for one change.
  const warnings: string[] = []
  const node = sizeNode({
    layoutSizingHorizontal: 'FIXED',
    layoutSizingVertical: 'FIXED',
  })
  applySizeVerified(node, [300, 200], warnings, {
    statedSizing: ['FIXED', 'FIXED'],
  })
  expect(node.width).toBe(300)
  expect(node.height).toBe(200)
  expect(warnings).toEqual([])
})

test('applySizeVerified: B46(b) — a size patched together with FILL is reported, not silently handed back', () => {
  // The self-contradicting patch. The axis is the caller's own doing, so the
  // remedy clause must NOT tell them to pin it — they refused that in the same
  // call. Before the reorder this passed the read-back and returned
  // `warnings: []` while `sizing` took the width away afterwards.
  const warnings: string[] = []
  const node = sizeNode(
    {
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'FIXED',
    },
    'no',
  )
  applySizeVerified(node, [60, 30], warnings, {
    statedSizing: ['FILL', 'FIXED'],
  })
  expect(warnings.length).toBe(1)
  expect(warnings[0]).toContain('size not applied')
  expect(warnings[0]).toContain(
    'This patch set the width (layoutSizingHorizontal: FILL) itself',
  )
  expect(warnings[0]).toContain('the sizing wins')
  expect(warnings[0]).not.toContain('Pin it with')
})

test('applySizeVerified: a pre-existing FILL axis still gets the pin advice', () => {
  // Same node, but the patch said nothing about sizing — so the advice is
  // actionable and stays.
  const warnings: string[] = []
  const node = sizeNode(
    { layoutSizingHorizontal: 'FILL' },
    'no',
  )
  applySizeVerified(node, [60, 30], warnings)
  expect(warnings[0]).toContain(
    'Pin it with sizing:["FIXED","FIXED"]',
  )
  expect(warnings[0]).not.toContain('This patch set')
})

// ─── statedPositionWarning (B35) ────────────────────────────────────────────

const stacked = { layoutMode: 'VERTICAL' }

test('statedPositionWarning: B35 — a position an auto-layout parent restacked is named, with where it landed', () => {
  const warning = statedPositionWarning(
    [150, 90],
    { name: 'Card', x: 0, y: 0 },
    stacked,
  )
  expect(warning).toContain('position [150, 90] ignored')
  expect(warning).toContain('"Card"')
  expect(warning).toContain('layoutPositioning:ABSOLUTE')
  expect(warning).toContain('It landed at [0, 0].')
})

test('discardedPositionsWarning: B35 — the sweep repro is ONE warning naming both children', () => {
  // Two children at [150,90] and [10,10] restacked to [0,0] and [0,20]. A third
  // child whose flow slot IS where it asked to be has nothing to report and is
  // not counted.
  const warning = discardedPositionsWarning(stacked, [
    { position: [150, 90], node: { name: 'A', x: 0, y: 0 } },
    { position: [10, 10], node: { name: 'B', x: 0, y: 20 } },
    { position: [0, 40], node: { name: 'C', x: 0, y: 40 } },
  ])
  expect(warning).toContain('2 stated positions ignored')
  expect(warning).toContain('"A" [150, 90] → [0, 0]')
  expect(warning).toContain('"B" [10, 10] → [0, 20]')
  expect(warning).not.toContain('"C"')
  expect(warning).toContain('layoutPositioning:ABSOLUTE')
})

test('discardedPositionsWarning: T4 — fifty children cost one line and a count, not fifty lines', () => {
  const children = Array.from({ length: 50 }, (_, i) => ({
    position: [100, 100] as unknown,
    node: { name: 'Row ' + String(i), x: 0, y: i * 20 },
  }))
  const warning = discardedPositionsWarning(
    stacked,
    children,
  )
  expect(warning).toContain('50 stated positions ignored')
  expect(warning).toContain('"Row 0"')
  expect(warning).toContain('"Row 2"')
  expect(warning).not.toContain('"Row 3"')
  expect(warning).toContain('and 47 more')
  // The whole point: one modest line, not fifty near-identical ones.
  expect((warning ?? '').length).toBeLessThan(300)
})

test('discardedPositionsWarning: one affected child still reads as the singular sentence', () => {
  const warning = discardedPositionsWarning(stacked, [
    { position: [150, 90], node: { name: 'A', x: 0, y: 0 } },
    { position: [0, 40], node: { name: 'C', x: 0, y: 40 } },
  ])
  expect(warning).toBe(
    statedPositionWarning(
      [150, 90],
      { name: 'A', x: 0, y: 0 },
      stacked,
    ),
  )
})

test('discardedPositionsWarning: a level that lost nothing says nothing', () => {
  expect(
    discardedPositionsWarning(stacked, [
      { position: [0, 0], node: { name: 'A', x: 0, y: 0 } },
      { position: undefined, node: { name: 'B', x: 9, y: 9 } },
    ]),
  ).toBeUndefined()
  expect(
    discardedPositionsWarning(stacked, []),
  ).toBeUndefined()
})

test('statedPositionWarning: layoutPositioning ABSOLUTE is the escape hatch and warns nothing', () => {
  expect(
    statedPositionWarning(
      [150, 90],
      {
        name: 'Card',
        x: 150,
        y: 90,
        layoutPositioning: 'ABSOLUTE',
      },
      stacked,
    ),
  ).toBeUndefined()
})

test('statedPositionWarning: a parent that arranges nothing keeps the position, and the silence', () => {
  expect(
    statedPositionWarning(
      [150, 90],
      { name: 'Card', x: 150, y: 90 },
      { layoutMode: 'NONE' },
    ),
  ).toBeUndefined()
  // A page has no layoutMode at all.
  expect(
    statedPositionWarning(
      [150, 90],
      { name: 'Card', x: 150, y: 90 },
      {},
    ),
  ).toBeUndefined()
})

test('statedPositionWarning: a spec that stated no position is not accused of losing one', () => {
  expect(
    statedPositionWarning(
      undefined,
      { name: 'Card', x: 0, y: 0 },
      stacked,
    ),
  ).toBeUndefined()
})
