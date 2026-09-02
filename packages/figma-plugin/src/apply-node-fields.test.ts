import { expect, test } from 'bun:test'

import {
  applyMinMax,
  applySize,
  applySizeVerified,
  applySizing,
  fillCollapseWarning,
  patchPositionIgnored,
  applyStrokeGeometry,
  applyStrokeWeights,
  applyExportSettings,
  applyGrids,
  capabilityWarnings,
  deadWrapWarning,
  discardedPositionsWarning,
  repinFixedSize,
  statedPositionWarning,
  verifyCreatedSize,
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
  const node: { strokeCap: unknown; strokeJoin: unknown } =
    {
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
    {
      format: 'PNG',
      suffix: '@2x',
      constraint: { type: 'SCALE', value: 2 },
    },
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

test("applyExportSettings: revives the wire-format constraint tuple to Figma's {type,value} object", () => {
  const node: { exportSettings: unknown } = {
    exportSettings: [],
  }
  applyExportSettings(node, [
    {
      format: 'PNG',
      suffix: '@2x',
      constraint: ['SCALE', 2],
    },
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
    capabilityWarnings(
      { type: 'RECTANGLE' },
      {
        text: { content: 'hi' },
      },
    ),
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
    capabilityWarnings(
      { type: 'RECTANGLE' },
      {
        vectorPaths: [
          { windingRule: 'NONZERO', data: 'M0 0' },
        ],
      },
    ),
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
  expect(warnings[0]).toContain('Resize the main component')
})

// B67 — the no-op detector compares the OUTCOME against the REQUEST, so a
// refusal and a success look identical when the node already reads the numbers
// that were asked for. An agent that resized an instance sublayer to the size
// it already had got `warnings: []` and learned the wrong lesson: that this
// target class takes a resize.
test('applySize: B67 — a resize that proved nothing on an instance sublayer says so', () => {
  const warnings: string[] = []
  const node = sizeNode(
    {
      width: 60,
      height: 30,
      parent: {
        type: 'FRAME',
        name: 'Row',
        parent: { type: 'INSTANCE', name: 'Card' },
      },
    },
    'no',
  )
  applySizeVerified(node, [60, 30], warnings)
  expect(warnings.length).toBe(1)
  expect(warnings[0]).toContain('size not verified')
  expect(warnings[0]).toContain(
    'sublayer of the instance "Card"',
  )
  expect(warnings[0]).toContain('already read [60, 30]')
})

test('applySize: B67 — a resize that CHANGED the size proves itself, instance or not', () => {
  const warnings: string[] = []
  const node = sizeNode(
    {
      parent: { type: 'INSTANCE', name: 'Card' },
    },
    'yes',
  )
  applySizeVerified(node, [60, 30], warnings)
  expect(node.width).toBe(60)
  // The write moved the node, so nothing is unproven and nothing is said.
  expect(warnings).toEqual([])
})

test('applySize: B67 — a coincidental match outside an instance is not accused', () => {
  const warnings: string[] = []
  const node = sizeNode({ width: 60, height: 30 }, 'no')
  applySizeVerified(node, [60, 30], warnings)
  // No instance ancestor: nothing here silently refuses a resize, so there is
  // no doubt to report and a warning would be noise on every idempotent write.
  expect(warnings).toEqual([])
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
  expect(warnings[0]).toContain('sizing:["FIXED","FIXED"]')
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

// ─── verifyCreatedSize (B61) ────────────────────────────────────────────────
//
// The create paths applied `size` and never looked. So one FRAME given
// `size:[400,60]` and a `layout` came back 136 wide with no `warnings` key at
// all, while `update_node` handed the SAME size to the SAME node, pinned it
// FIXED, and had had words for the contradiction since B46. Two write paths
// disagreeing about one field is bad; only one of them admitting it is worse —
// the operator paid ~15 repair calls before a read-back caught it.
//
// The sentence has one author now, so create cannot say it differently from
// update, or stop saying it while update still does.

test('verifyCreatedSize: a size the node kept says nothing', () => {
  const warnings: string[] = []
  const node = sizeNode({ width: 400, height: 60 })
  verifyCreatedSize(node, [400, 60], warnings)
  expect(warnings).toEqual([])
})

test('verifyCreatedSize: a stated size hugged away by the creation default is named', () => {
  // The B61 repro: `size` and `layout` on one FRAME, no `sizing` stated. The
  // creation default (B29) hugs it, the width is discarded, and the advice is
  // actionable because the caller never refused the pin.
  const warnings: string[] = []
  const node = sizeNode({
    type: 'FRAME',
    name: 'Row',
    width: 136,
    height: 60,
    layoutSizingHorizontal: 'HUG',
    layoutSizingVertical: 'FIXED',
  })
  verifyCreatedSize(node, [400, 60], warnings)
  expect(warnings.length).toBe(1)
  expect(warnings[0]).toContain('size not applied')
  expect(warnings[0]).toContain('asked [400, 60]')
  expect(warnings[0]).toContain('"Row" reads [136, 60]')
  expect(warnings[0]).toContain(
    'Auto-layout owns the width (layoutSizingHorizontal: HUG)',
  )
  expect(warnings[0]).toContain(
    'Pin it with sizing:["FIXED","FIXED"]',
  )
})

test('verifyCreatedSize: a spec that stated the HUG itself is told what it did', () => {
  const warnings: string[] = []
  const node = sizeNode({
    type: 'FRAME',
    width: 136,
    height: 60,
    layoutSizingHorizontal: 'HUG',
    layoutSizingVertical: 'FIXED',
  })
  verifyCreatedSize(node, [400, 60], warnings, [
    'HUG',
    'FIXED',
  ])
  expect(warnings[0]).toContain(
    'This patch set the width (layoutSizingHorizontal: HUG) itself',
  )
  expect(warnings[0]).toContain('the sizing wins')
  expect(warnings[0]).not.toContain('Pin it with')
})

test('verifyCreatedSize: no stated size is not a request', () => {
  const warnings: string[] = []
  const node = sizeNode({ width: 136, height: 60 })
  verifyCreatedSize(node, undefined, warnings)
  expect(warnings).toEqual([])
})

test('verifyCreatedSize: a node with no readable width/height is not accused', () => {
  const warnings: string[] = []
  verifyCreatedSize({ type: 'SLOT' }, [400, 60], warnings)
  expect(warnings).toEqual([])
})

test('verifyCreatedSize: it never resizes — the create path already applied the size', () => {
  const warnings: string[] = []
  let resizes = 0
  const node = sizeNode({
    width: 136,
    height: 60,
    resize() {
      resizes += 1
    },
    resizeWithoutConstraints() {
      resizes += 1
    },
  })
  verifyCreatedSize(node, [400, 60], warnings)
  expect(resizes).toBe(0)
  expect(warnings.length).toBe(1)
})

// ─── repinFixedSize (B69) ───────────────────────────────────────────────────
//
// A create_tree FRAME stating size:[300,60], sizing:['FIXED','FIXED'] and a
// horizontal layout came back [40, 60] with one child and [400, 60] with two.
// Child count is not the cause — the HUG WIDTH is, and the child count is what
// changes it. The deferred collapse (B60) lets the frame hug while its subtree
// is built, and `FIXED` then freezes whatever box the hug produced. The stated
// size is never re-applied, so it only survives when the hug happens to land
// on it.

test('repinFixedSize: an explicit FIXED restores the stated size the hug ate', () => {
  const warnings: string[] = []
  let asked: [number, number] | undefined
  const node = sizeNode({
    type: 'FRAME',
    name: 'Row',
    width: 40,
    height: 60,
    layoutSizingHorizontal: 'FIXED',
    layoutSizingVertical: 'FIXED',
    resize(w: number, h: number) {
      asked = [w, h]
      node.width = w
      node.height = h
    },
  })
  repinFixedSize(
    node,
    [300, 60],
    ['FIXED', 'FIXED'],
    warnings,
  )
  expect(asked).toEqual([300, 60])
  expect(node.width).toBe(300)
  expect(warnings).toEqual([])
})

test('repinFixedSize: pins only the axis the caller said FIXED', () => {
  const warnings: string[] = []
  let asked: [number, number] | undefined
  const node = sizeNode({
    type: 'FRAME',
    width: 40,
    height: 88,
    resize(w: number, h: number) {
      asked = [w, h]
    },
  })
  repinFixedSize(
    node,
    [300, 60],
    ['FIXED', 'HUG'],
    warnings,
  )
  // The width is the caller's number; the height is what the hug decided, and
  // this must not undo a HUG the caller asked for.
  expect(asked).toEqual([300, 88])
})

test('repinFixedSize: a sizing that pins nothing resizes nothing', () => {
  let resizes = 0
  const node = sizeNode({
    width: 40,
    height: 60,
    resize() {
      resizes += 1
    },
  })
  repinFixedSize(node, [300, 60], ['HUG', 'FILL'])
  repinFixedSize(node, [300, 60], undefined)
  repinFixedSize(node, undefined, ['FIXED', 'FIXED'])
  expect(resizes).toBe(0)
})

test('repinFixedSize: a node already at the stated size is left alone', () => {
  let resizes = 0
  const node = sizeNode({
    width: 300,
    height: 60,
    resize() {
      resizes += 1
    },
  })
  repinFixedSize(node, [300, 60], ['FIXED', 'FIXED'])
  expect(resizes).toBe(0)
})

test('repinFixedSize: a refusal is named, never thrown', () => {
  const warnings: string[] = []
  const node = sizeNode(
    { type: 'FRAME', width: 40, height: 60 },
    'throw',
  )
  expect(() =>
    repinFixedSize(
      node,
      [300, 60],
      ['FIXED', 'FIXED'],
      warnings,
    ),
  ).not.toThrow()
  expect(warnings.length).toBe(1)
  expect(warnings[0]).toContain('size')
})

test('create and update say the SAME sentence about the same node', () => {
  // Wording parity, asserted rather than trusted: the two paths run the same
  // author, so a change to one cannot leave the other behind.
  const stated = ['FILL', 'FIXED']
  const shape = {
    type: 'FRAME',
    name: 'Row',
    layoutSizingHorizontal: 'FILL',
    layoutSizingVertical: 'FIXED',
  }
  const fromUpdate: string[] = []
  applySizeVerified(
    sizeNode(shape, 'no'),
    [60, 30],
    fromUpdate,
    { statedSizing: stated },
  )
  const fromCreate: string[] = []
  verifyCreatedSize(
    sizeNode(shape, 'no'),
    [60, 30],
    fromCreate,
    stated,
  )
  expect(fromCreate).toEqual(fromUpdate)
  expect(fromCreate.length).toBe(1)
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
    {
      position: [150, 90],
      node: { name: 'A', x: 0, y: 0 },
    },
    {
      position: [10, 10],
      node: { name: 'B', x: 0, y: 20 },
    },
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
    {
      position: [150, 90],
      node: { name: 'A', x: 0, y: 0 },
    },
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
      {
        position: undefined,
        node: { name: 'B', x: 9, y: 9 },
      },
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

// ─── applySizing (B60) ─────────────────────────────────────────────────────

test('applySizing: writes both axes', () => {
  const node = {
    type: 'FRAME',
    layoutSizingHorizontal: 'FIXED',
    layoutSizingVertical: 'FIXED',
  }
  applySizing(node, ['FILL', 'HUG'])
  expect(node.layoutSizingHorizontal).toBe('FILL')
  expect(node.layoutSizingVertical).toBe('HUG')
})

test('applySizing: a spec that stated no sizing writes nothing', () => {
  const node = {
    type: 'FRAME',
    layoutSizingHorizontal: 'FIXED',
    layoutSizingVertical: 'FIXED',
  }
  applySizing(node, undefined)
  expect(node.layoutSizingHorizontal).toBe('FIXED')
  expect(node.layoutSizingVertical).toBe('FIXED')
})

test('applySizing: T7 — a refused FILL degrades to a warning, naming the type', () => {
  // Figma's own refusal, on a node that is not the child of an auto-layout
  // frame. The wording is the one the surface has always emitted.
  const node = {
    type: 'SLOT',
    set layoutSizingHorizontal(_value: string) {
      throw new Error(
        'FILL can only be set on children of auto-layout frames',
      )
    },
    layoutSizingVertical: 'FIXED',
  }
  const warnings: string[] = []
  expect(() =>
    applySizing(node, ['FILL', 'FILL'], warnings),
  ).not.toThrow()
  expect(warnings).toEqual([
    'sizing not applicable on this node (SLOT): Error: FILL can only be set on children of auto-layout frames',
  ])
})

// ─── B80: the FILL child that came out too small ────────────────────────────
//
// Live 2026-09-01: a `Token cell` stating `sizing:[FILL, HUG]` came out **12px
// wide with 56px of children overflowing it**, and the write answered
// `warnings: []`. Nothing throws here — which is exactly why a `catch` could
// never have caught it. B58's precedent is the shape (a self-contradictory
// pair, named where the node is in hand), but not the verdict: B58 REFUSES
// because Figma destroys that pair on the next click, and Figma tolerates this
// one. So: warn, and never refuse.
//
// THE REFINEMENT (stream 3, same round). The first cut warned on the circular
// PAIR by shape, and that read wrong in both directions:
//
//   FALSE POSITIVE — it fired on four designated flex columns across three
//                    tables that do NOT collapse. A master is a template: every
//                    row INSTANCE overrides its width to FILL, which un-hugs
//                    the parent and re-enables the child. Sizes stable on
//                    re-write.
//   FALSE NEGATIVE — the Token cell it was filed for was under a STARVED FIXED
//                    parent, not a hugging one, so the shape rule never looked
//                    at it.
//
// The finding is therefore the COLLAPSE, not the pair.

/** A child under a parent that lays out on `mode` and hugs the named axes. */
const inHug = (
  mode: 'HORIZONTAL' | 'VERTICAL' | 'NONE',
  parentSizing: [string, string],
  child: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: 'FRAME',
  name: 'Token cell',
  layoutSizingHorizontal: 'FIXED',
  layoutSizingVertical: 'FIXED',
  parent: {
    type: 'FRAME',
    name: 'Table row',
    layoutMode: mode,
    layoutSizingHorizontal: parentSizing[0],
    layoutSizingVertical: parentSizing[1],
  },
  ...child,
})

test('applySizing: B80 — a FILL child on the axis its parent HUGS is named', () => {
  const node = inHug('HORIZONTAL', ['HUG', 'FIXED'])
  const warnings: string[] = []
  applySizing(node, ['FILL', 'HUG'], warnings)
  // The write LANDS — Figma takes it, and refusing would block what the file
  // accepts.
  expect(node.layoutSizingHorizontal).toBe('FILL')
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('"Token cell"')
  expect(warnings[0]).toContain('"Table row"')
  expect(warnings[0]).toContain('horizontal')
  expect(warnings[0]).toContain('collapses')
})

test('applySizing: B80 — the numbers ride along when the node can be measured', () => {
  // The live case exactly: 12px of cell, 56px of children.
  const node = inHug('HORIZONTAL', ['HUG', 'FIXED'], {
    width: 12,
    height: 20,
    children: [
      { width: 24, height: 16 },
      { width: 32, height: 16 },
    ],
  })
  const warnings: string[] = []
  applySizing(node, ['FILL', 'HUG'], warnings)
  expect(warnings[0]).toContain('resolved to 12px')
  expect(warnings[0]).toContain('children need 56px')
})

test('applySizing: B80 — a measured node that did NOT collapse says nothing', () => {
  // The false positive, at its root: the pair is there and the numbers say it
  // resolved fine. Four flex columns across three tables were reported this
  // way, all of them correct and load-bearing.
  const node = inHug('HORIZONTAL', ['HUG', 'FIXED'], {
    width: 220,
    height: 20,
    children: [
      { width: 24, height: 16 },
      { width: 32, height: 16 },
    ],
  })
  const warnings: string[] = []
  applySizing(node, ['FILL', 'HUG'], warnings)
  expect(warnings).toEqual([])
})

test('applySizing: B80 — a STARVED FIXED parent is the collapse the pair rule missed', () => {
  // The Token cell's real shape. The parent is not hugging at all: it is FIXED
  // and too small, so the FILL child's share cannot hold its own children.
  const node = inHug('HORIZONTAL', ['FIXED', 'FIXED'], {
    width: 12,
    height: 20,
    children: [
      { width: 24, height: 16 },
      { width: 32, height: 16 },
    ],
  })
  ;(node.parent as Record<string, unknown>).width = 40
  const warnings: string[] = []
  applySizing(node, ['FILL', 'HUG'], warnings)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('"Token cell"')
  expect(warnings[0]).toContain('less room')
  expect(warnings[0]).toContain('resolved to 12px')
  expect(warnings[0]).toContain('children need 56px')
  expect(warnings[0]).toContain('FIXED at 40px')
  // …and it does not tell the caller a hug story that is not true here.
  expect(warnings[0]).not.toContain('HUGS the same axis')
})

test('applySizing: B80 — a FIXED parent with room to spare says nothing', () => {
  const node = inHug('HORIZONTAL', ['FIXED', 'FIXED'], {
    width: 200,
    height: 20,
    children: [{ width: 24, height: 16 }],
  })
  const warnings: string[] = []
  applySizing(node, ['FILL', 'HUG'], warnings)
  expect(warnings).toEqual([])
})

test('applySizing: B80 — an empty frame still gets the pair named', () => {
  // A create states the pair before any child exists. Author time is when the
  // caller can still act, so a value-only check would arrive too late.
  const warnings: string[] = []
  applySizing(
    inHug('VERTICAL', ['FIXED', 'HUG'], { children: [] }),
    ['HUG', 'FILL'],
    warnings,
  )
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('vertical')
  expect(warnings[0]).not.toContain('resolved to')
})

test('applySizing: B80 — the same empty frame INSIDE A MASTER says nothing', () => {
  // The other half of the false positive. In a master the shape is not
  // evidence: an instance overrides the row's width to FILL, which un-hugs the
  // parent and re-enables the child. Proved on four columns, sizes stable.
  const node = inHug('VERTICAL', ['FIXED', 'HUG'], {
    children: [],
  })
  ;(node.parent as Record<string, unknown>).parent = {
    type: 'COMPONENT',
    name: 'Table row',
  }
  const warnings: string[] = []
  applySizing(node, ['HUG', 'FILL'], warnings)
  expect(warnings).toEqual([])
})

test('applySizing: B80 — a master does NOT suppress a measured collapse', () => {
  // Suppression is only for the shape rule. Numbers are evidence wherever the
  // node lives, and a master whose column really did collapse is still wrong.
  const node = inHug('HORIZONTAL', ['HUG', 'FIXED'], {
    width: 12,
    height: 20,
    children: [{ width: 56, height: 16 }],
  })
  ;(node.parent as Record<string, unknown>).parent = {
    type: 'COMPONENT',
    name: 'Table row',
  }
  const warnings: string[] = []
  applySizing(node, ['FILL', 'HUG'], warnings)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('resolved to 12px')
})

test('applySizing: B80 — the COUNTER axis is left alone', () => {
  // A hug on the counter axis means "as big as my largest child", and a FILL
  // child stretching to the tallest sibling is ordinary. Warning here would be
  // noise on a very common shape.
  const warnings: string[] = []
  applySizing(
    inHug('HORIZONTAL', ['FIXED', 'HUG']),
    ['FIXED', 'FILL'],
    warnings,
  )
  expect(warnings).toEqual([])
})

test('applySizing: B80 — a FIXED or FILL parent with nothing measured is not a conflict', () => {
  for (const parentSizing of [
    ['FIXED', 'FIXED'],
    ['FILL', 'FIXED'],
  ] as [string, string][]) {
    const warnings: string[] = []
    applySizing(
      inHug('HORIZONTAL', parentSizing),
      ['FILL', 'HUG'],
      warnings,
    )
    expect(warnings).toEqual([])
  }
})

test('applySizing: B80 — a parent that lays out nothing is not a conflict', () => {
  const warnings: string[] = []
  applySizing(
    inHug('NONE', ['HUG', 'HUG']),
    ['FILL', 'FILL'],
    warnings,
  )
  expect(warnings).toEqual([])
})

test('applySizing: B80 — a refused write is never also called a collapse', () => {
  // The node never took the FILL, so there is no circle to report — and two
  // sentences about one axis would send the caller two ways at once.
  const node = {
    type: 'SLOT',
    name: 'Body',
    set layoutSizingHorizontal(_value: string) {
      throw new Error('FILL can only be set on children')
    },
    layoutSizingVertical: 'FIXED',
    parent: {
      type: 'FRAME',
      layoutMode: 'HORIZONTAL',
      layoutSizingHorizontal: 'HUG',
    },
  }
  const warnings: string[] = []
  applySizing(node, ['FILL', 'HUG'], warnings)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('sizing not applicable')
})

// ─── B76: the patch that carried its own remedy ─────────────────────────────
//
// `update_node 549:17000 {layoutPositioning:'ABSOLUTE', position:[0,10],
// size:[2,20], constraints:['MIN','CENTER']}` answered ok with the warning
// "x/y ignored on an auto-layout child (set layoutPositioning:ABSOLUTE first)"
// — the remedy the patch itself was applying — and dropped `position`, which
// defeated the ABSOLUTE re-apply that exists to land it. Re-sending the
// identical patch WITHOUT `layoutPositioning` then worked: the surface
// disagreeing with itself, and a round trip for nothing.

const stackParent = { layoutMode: 'VERTICAL' }

test('patchPositionIgnored: B76 — a patch that sets ABSOLUTE keeps its own position', () => {
  expect(
    patchPositionIgnored(
      { position: [0, 10], layoutPositioning: 'ABSOLUTE' },
      { layoutPositioning: 'AUTO' },
      stackParent,
    ),
  ).toBe(false)
})

test('patchPositionIgnored: a flow child that states no positioning is still warned', () => {
  expect(
    patchPositionIgnored(
      { position: [0, 10] },
      { layoutPositioning: 'AUTO' },
      stackParent,
    ),
  ).toBe(true)
})

test('patchPositionIgnored: a patch may also take the escape hatch AWAY', () => {
  // `{layoutPositioning:'AUTO'}` on an already-ABSOLUTE node puts it back in
  // the flow, so its stated x/y really will be ignored. Reading the node alone
  // would have missed this one in the other direction.
  expect(
    patchPositionIgnored(
      { position: [0, 10], layoutPositioning: 'AUTO' },
      { layoutPositioning: 'ABSOLUTE' },
      stackParent,
    ),
  ).toBe(true)
})

test('patchPositionIgnored: an already-ABSOLUTE node is untouched', () => {
  expect(
    patchPositionIgnored(
      { position: [0, 10] },
      { layoutPositioning: 'ABSOLUTE' },
      stackParent,
    ),
  ).toBe(false)
})

test('patchPositionIgnored: a parent that arranges nothing never warns', () => {
  for (const parent of [
    { layoutMode: 'NONE' },
    { type: 'PAGE' },
    null,
    undefined,
  ]) {
    expect(
      patchPositionIgnored(
        { position: [0, 10] },
        { layoutPositioning: 'AUTO' },
        parent,
      ),
    ).toBe(false)
  }
})

test('patchPositionIgnored: a patch that states no position has nothing to lose', () => {
  expect(
    patchPositionIgnored(
      { layoutPositioning: 'AUTO' },
      { layoutPositioning: 'ABSOLUTE' },
      stackParent,
    ),
  ).toBe(false)
})

test('fillCollapseWarning: a parent that refuses every read is not a finding', () => {
  const dead = new Proxy({} as Record<string, unknown>, {
    get: () => {
      throw new Error('does not exist')
    },
    has: () => true,
  })
  expect(
    fillCollapseWarning(
      { name: 'Cell', parent: dead },
      ['FILL', 'HUG'],
    ),
  ).toBeUndefined()
})

test('fillCollapseWarning: the legacy sizing fields answer when the new ones are absent', () => {
  // A runtime that predates layoutSizing* still states the hug through
  // primaryAxisSizingMode — the same preference order feed/write-scope.ts uses.
  const warning = fillCollapseWarning(
    {
      name: 'Cell',
      parent: {
        name: 'Row',
        layoutMode: 'HORIZONTAL',
        primaryAxisSizingMode: 'AUTO',
        counterAxisSizingMode: 'FIXED',
      },
    },
    ['FILL', 'HUG'],
  )
  expect(warning).toContain('HUGS the same axis')
})

// ─── B60: the end state a create_tree owes a constrained absolute child ─────
//
// The fault is an ORDER, so the contract has to be stated in arithmetic. The
// fake below models the one slice of Figma's geometry B60 turns on: a
// NONE-layout frame whose FILL axis makes its auto-layout parent resize it,
// and a resize that re-anchors every child by its constraint pair (MIN keeps
// the near edge where it is, MAX carries the far one).
//
// code.ts exports nothing and cannot be driven from a test, so what binds it
// to this order is the source scan in apply-wiring.test.ts. This pair states
// WHAT that order has to produce.

/** Where a constraint puts a child after its parent's axis changed size. */
const reanchor = (
  pos: number,
  before: number,
  after: number,
  rule: string,
): number => (rule === 'MAX' ? pos + (after - before) : pos)

type FakeChild = {
  name: string
  x: number
  y: number
  constraints: [string, string]
}

/**
 * A NONE-layout frame in an auto-layout parent `innerWidth` wide. Setting its
 * horizontal axis to FILL is what makes the parent resize it — the collapse
 * B60 is about.
 */
const fillingFrame = (innerWidth: number) => {
  const box = { width: 0, height: 0 }
  const children: FakeChild[] = []
  const resize = (width: number, height: number): void => {
    for (const child of children) {
      child.x = reanchor(
        child.x,
        box.width,
        width,
        child.constraints[0],
      )
      child.y = reanchor(
        child.y,
        box.height,
        height,
        child.constraints[1],
      )
    }
    box.width = width
    box.height = height
  }
  return {
    type: 'FRAME',
    name: 'media',
    layoutMode: 'NONE',
    children,
    resize,
    get width() {
      return box.width
    },
    get height() {
      return box.height
    },
    layoutSizingVertical: 'FIXED',
    set layoutSizingHorizontal(value: string) {
      if (value === 'FILL') {
        resize(innerWidth, box.height)
      }
    },
    get layoutSizingHorizontal() {
      return box.width === innerWidth ? 'FILL' : 'FIXED'
    },
  }
}

test('B60 contract: the parent holds its AUTHORED box until its children are placed and constrained', () => {
  const media = fillingFrame(174)
  // applySize — the box the child's position was authored against.
  media.resize(296, 140)
  // appendChild + applyPostAppendProperties: the child lands at its stated
  // position and takes its constraints, both while the box is still 296×140.
  media.children.push({
    name: 'badge',
    x: 238,
    y: 106,
    constraints: ['MAX', 'MAX'],
  })
  // …and only now the FILL collapse, which re-anchors it.
  applySizing(media, ['FILL', 'FIXED'])

  expect(media.width).toBe(174)
  // Shrunk axis: statedPos − delta (296 − 174 = 122).
  expect(media.children[0].x).toBe(116)
  // Unchanged axis: EXACTLY the stated position.
  expect(media.children[0].y).toBe(106)
})

test('B60 fault: a collapse that happens before the child exists can never re-anchor it', () => {
  const media = fillingFrame(174)
  media.resize(296, 140)
  // The order the create path used: a node's own sizing was applied at its
  // append, and its children were built afterwards.
  applySizing(media, ['FILL', 'FIXED'])
  media.children.push({
    name: 'badge',
    x: 238,
    y: 106,
    constraints: ['MAX', 'MAX'],
  })

  // The stated position survives untouched — and lands outside a 174-wide
  // clip, which is the displacement B60 reported.
  expect(media.children[0].x).toBe(238)
  expect(media.children[0].x).toBeGreaterThan(media.width)
})

// ─── applyMinMax (B59) ─────────────────────────────────────────────────────

/**
 * A node that answers the four clamps the way Figma does: the write is legal
 * only on an auto-layout frame or on a DIRECT CHILD of one, and anywhere else
 * it throws "Can only set maxWidth on auto layout nodes and their children".
 */
const clampNode = (opts: {
  type: string
  name?: string
  layoutMode?: string
  parentLayoutMode?: string
}): Record<string, unknown> => {
  const held: Record<string, unknown> = {}
  const legal = (): boolean =>
    (opts.layoutMode !== undefined &&
      opts.layoutMode !== 'NONE') ||
    (opts.parentLayoutMode !== undefined &&
      opts.parentLayoutMode !== 'NONE')
  const node: Record<string, unknown> = {
    type: opts.type,
    name: opts.name ?? '',
  }
  if (opts.layoutMode !== undefined) {
    node.layoutMode = opts.layoutMode
  }
  for (const field of [
    'minWidth',
    'maxWidth',
    'minHeight',
    'maxHeight',
  ]) {
    Object.defineProperty(node, field, {
      enumerable: true,
      get: () => held[field],
      set: (value: unknown) => {
        if (!legal()) {
          throw new Error(
            'in set_' +
              field +
              ': Can only set ' +
              field +
              ' on auto layout nodes and their children',
          )
        }
        held[field] = value
      },
    })
  }
  return node
}

test('applyMinMax: an auto-layout frame takes all four clamps', () => {
  const node = clampNode({
    type: 'FRAME',
    name: 'Card',
    layoutMode: 'VERTICAL',
  })
  applyMinMax(node, {
    minWidth: 200,
    maxWidth: 400,
    minHeight: 80,
    maxHeight: 600,
  })
  expect(node.minWidth).toBe(200)
  expect(node.maxWidth).toBe(400)
  expect(node.minHeight).toBe(80)
  expect(node.maxHeight).toBe(600)
})

test('applyMinMax: a TEXT node inside an auto-layout parent takes maxWidth', () => {
  // The B59 repro at the write that failed: a TEXT node is never an
  // auto-layout node itself, so the only thing that can make this write legal
  // is the auto-layout parent it is appended to.
  const node = clampNode({
    type: 'TEXT',
    name: 'Body copy',
    parentLayoutMode: 'VERTICAL',
  })
  const warnings: string[] = []
  applyMinMax(node, { maxWidth: 420 }, warnings)
  expect(node.maxWidth).toBe(420)
  expect(warnings).toEqual([])
})

test('applyMinMax: the same TEXT still parented to the page is refused — the pre-append order, in one write', () => {
  const node = clampNode({
    type: 'TEXT',
    name: 'Body copy',
  })
  expect(() =>
    applyMinMax(node, { maxWidth: 420 }),
  ).toThrow(/maxWidth 420 rejected on "Body copy"/)
  expect(node.maxWidth).toBeUndefined()
})

test('applyMinMax: a NONE-layout frame under a NONE-layout parent is refused honestly', () => {
  // Not a degrade: this spec's END state carries no auto-layout anywhere, so
  // no order could make Figma accept it.
  const node = clampNode({
    type: 'FRAME',
    name: 'media',
    layoutMode: 'NONE',
    parentLayoutMode: 'NONE',
  })
  expect(() =>
    applyMinMax(node, { minWidth: 200 }),
  ).toThrow(
    /Figma accepts min\/max sizing only on an auto-layout frame or a direct child of one/,
  )
})

test('applyMinMax: T7 — a node type that carries no clamp warns and continues', () => {
  const node = { type: 'SLICE', name: 'Cut' }
  const warnings: string[] = []
  expect(() =>
    applyMinMax(node, { maxWidth: 400 }, warnings),
  ).not.toThrow()
  expect(warnings).toEqual([
    'maxWidth ignored — not supported on a SLICE node',
  ])
})

test('applyMinMax: omission ≠ clear, and null IS a clear', () => {
  const node = clampNode({
    type: 'FRAME',
    layoutMode: 'VERTICAL',
  })
  applyMinMax(node, { minWidth: 200, maxWidth: 400 })
  applyMinMax(node, { maxWidth: null })
  expect(node.minWidth).toBe(200)
  expect(node.maxWidth).toBeNull()
})

// ─── deadWrapWarning (I86) ─────────────────────────────────────────────────
//
// The mirror of the FILL-in-HUG collapse above, and the trap that defeated
// S58. A HUG container sizes to its content, so nothing ever bounds the line
// and `wrap:true` can never fire. Operator-filed 2026-09-02: it set wrap on
// the top-bar action cluster and a segmented-control track expecting reflow at
// narrow widths; the only symptom was silent overhang and clipping, caught by
// its own squeeze probe at 469px of content against 432px of inner width.

const wrapNode = (over: Record<string, unknown> = {}) => ({
  type: 'FRAME',
  name: 'Actions',
  layoutMode: 'HORIZONTAL',
  layoutWrap: 'WRAP',
  layoutSizingHorizontal: 'HUG',
  ...over,
})

test('deadWrapWarning: wrap on a HUG main axis can never fire', () => {
  const warning = deadWrapWarning(wrapNode())
  expect(warning).toContain('"Actions"')
  expect(warning).toContain('wrap')
  expect(warning).toContain('HUG')
  expect(warning).toContain('maxWidth')
})

test('deadWrapWarning: a FILL main axis is bounded, so nothing is said', () => {
  expect(
    deadWrapWarning(
      wrapNode({ layoutSizingHorizontal: 'FILL' }),
    ),
  ).toBeUndefined()
})

test('deadWrapWarning: a maxWidth bounds the line even under HUG', () => {
  expect(
    deadWrapWarning(wrapNode({ maxWidth: 432 })),
  ).toBeUndefined()
})

test('deadWrapWarning: no wrap, no finding', () => {
  expect(
    deadWrapWarning(wrapNode({ layoutWrap: 'NO_WRAP' })),
  ).toBeUndefined()
})

test('deadWrapWarning: a VERTICAL frame does not wrap at all', () => {
  // Figma offers wrap on a horizontal auto-layout only, so a vertical frame
  // carrying the flag is a different question and not this one.
  expect(
    deadWrapWarning(wrapNode({ layoutMode: 'VERTICAL' })),
  ).toBeUndefined()
})

test('deadWrapWarning: the legacy sizing field answers when the new one is absent', () => {
  const node = wrapNode()
  delete (node as Record<string, unknown>)
    .layoutSizingHorizontal
  expect(
    deadWrapWarning({
      ...node,
      primaryAxisSizingMode: 'AUTO',
    }),
  ).toContain('wrap')
})

test('deadWrapWarning: a node that refuses every read is not a finding', () => {
  const hostile = new Proxy(
    {},
    {
      get: () => {
        throw new Error('The node does not exist')
      },
      has: () => true,
    },
  )
  expect(deadWrapWarning(hostile)).toBeUndefined()
})

test('applySizing: the dead-wrap warning rides the sizing write', () => {
  const node = wrapNode() as Record<string, unknown>
  const warnings: string[] = []
  applySizing(node, ['HUG', 'HUG'], warnings)
  expect(
    warnings.some(w => w.includes('never wrap')),
  ).toBe(true)
})
