import { expect, test } from 'bun:test'

import {
  applyLayout,
  type AppliedLayout,
  type LayoutTarget,
} from './apply-layout'

// The server's writer (`convertLayout`) is PURE — it emits spacing/padding/
// align/wrap ONLY when present. applyLayout must mirror that: it applies each
// field only when present and never indexes an absent array (the partial-layout
// crash this module fixes), leaving Figma's defaults untouched otherwise.

// A plain fake FrameNode seeded with sentinel defaults so we can assert which
// fields were touched. Structurally satisfies LayoutTarget.
const SENTINEL = {
  itemSpacing: -1,
  paddingTop: -1,
  paddingRight: -1,
  paddingBottom: -1,
  paddingLeft: -1,
  primaryAxisAlignItems: 'CENTER',
  counterAxisAlignItems: 'CENTER',
  layoutWrap: 'NO_WRAP',
} as const

const makeFrame = (): LayoutTarget => ({
  layoutMode: 'NONE',
  ...SENTINEL,
})

test('partial {mode:H, wrap:true} does not throw; leaves spacing/padding/align untouched', () => {
  const frame = makeFrame()
  const layout: AppliedLayout = { mode: 'H', wrap: true }
  expect(() => applyLayout(frame, layout)).not.toThrow()

  expect(frame.layoutMode).toBe('HORIZONTAL')
  expect(frame.layoutWrap).toBe('WRAP')
  // untouched
  expect(frame.itemSpacing).toBe(SENTINEL.itemSpacing)
  expect(frame.paddingTop).toBe(SENTINEL.paddingTop)
  expect(frame.paddingLeft).toBe(SENTINEL.paddingLeft)
  expect(frame.primaryAxisAlignItems).toBe(
    SENTINEL.primaryAxisAlignItems,
  )
  expect(frame.counterAxisAlignItems).toBe(
    SENTINEL.counterAxisAlignItems,
  )
})

test('partial {mode:V, spacing:8} sets spacing only; padding/align untouched', () => {
  const frame = makeFrame()
  const layout: AppliedLayout = { mode: 'V', spacing: 8 }
  expect(() => applyLayout(frame, layout)).not.toThrow()

  expect(frame.layoutMode).toBe('VERTICAL')
  expect(frame.itemSpacing).toBe(8)
  // untouched
  expect(frame.paddingTop).toBe(SENTINEL.paddingTop)
  expect(frame.primaryAxisAlignItems).toBe(
    SENTINEL.primaryAxisAlignItems,
  )
  expect(frame.layoutWrap).toBe(SENTINEL.layoutWrap)
})

test('partial {mode:H, spacing:8, padding} (no align) sets padding; align untouched', () => {
  const frame = makeFrame()
  const layout: AppliedLayout = {
    mode: 'H',
    spacing: 8,
    padding: [4, 4, 4, 4],
  }
  expect(() => applyLayout(frame, layout)).not.toThrow()

  expect(frame.itemSpacing).toBe(8)
  expect(frame.paddingTop).toBe(4)
  expect(frame.paddingRight).toBe(4)
  expect(frame.paddingBottom).toBe(4)
  expect(frame.paddingLeft).toBe(4)
  // untouched
  expect(frame.primaryAxisAlignItems).toBe(
    SENTINEL.primaryAxisAlignItems,
  )
  expect(frame.counterAxisAlignItems).toBe(
    SENTINEL.counterAxisAlignItems,
  )
})

test('partial {mode:H, align} (no padding) sets align; padding untouched', () => {
  const frame = makeFrame()
  const layout: AppliedLayout = {
    mode: 'H',
    align: ['MIN', 'MIN'],
  }
  expect(() => applyLayout(frame, layout)).not.toThrow()

  expect(frame.primaryAxisAlignItems).toBe('MIN')
  expect(frame.counterAxisAlignItems).toBe('MIN')
  // untouched
  expect(frame.paddingTop).toBe(SENTINEL.paddingTop)
  expect(frame.paddingLeft).toBe(SENTINEL.paddingLeft)
})

test('asymmetric padding maps [top,right,bottom,left] in order', () => {
  const frame = makeFrame()
  applyLayout(frame, {
    mode: 'V',
    padding: [1, 2, 3, 4],
  })
  expect(frame.paddingTop).toBe(1)
  expect(frame.paddingRight).toBe(2)
  expect(frame.paddingBottom).toBe(3)
  expect(frame.paddingLeft).toBe(4)
})

test('full layout sets every field', () => {
  const frame = makeFrame()
  applyLayout(frame, {
    mode: 'H',
    spacing: 12,
    padding: [10, 20, 30, 40],
    align: ['SPACE_BETWEEN', 'BASELINE'],
    wrap: true,
  })
  expect(frame.layoutMode).toBe('HORIZONTAL')
  expect(frame.itemSpacing).toBe(12)
  expect(frame.paddingTop).toBe(10)
  expect(frame.paddingRight).toBe(20)
  expect(frame.paddingBottom).toBe(30)
  expect(frame.paddingLeft).toBe(40)
  expect(frame.primaryAxisAlignItems).toBe('SPACE_BETWEEN')
  expect(frame.counterAxisAlignItems).toBe('BASELINE')
  expect(frame.layoutWrap).toBe('WRAP')
})

test('mode NONE disables auto-layout (not VERTICAL)', () => {
  const frame = makeFrame()
  frame.layoutMode = 'HORIZONTAL'
  applyLayout(frame, { mode: 'NONE' })
  expect(frame.layoutMode).toBe('NONE')
})

test('wrap:false does not set WRAP', () => {
  const frame = makeFrame()
  applyLayout(frame, { mode: 'H', wrap: false })
  expect(frame.layoutWrap).toBe('NO_WRAP')
})

// ─── GRID mode (M12) ──────────────────────────────────────────────────────────

// A grid-capable fake frame: same as makeFrame() but with the GRID-only fields
// present so 'gridRowCount' in frame is true (feature-detect passes).
const makeGridFrame = (): LayoutTarget & {
  gridRowCount: number
  gridColumnCount: number
  gridRowGap: number
  gridColumnGap: number
} => ({
  ...makeFrame(),
  gridRowCount: 0,
  gridColumnCount: 0,
  gridRowGap: 0,
  gridColumnGap: 0,
})

test('mode GRID sets layoutMode to GRID', () => {
  const frame = makeGridFrame()
  applyLayout(frame, { mode: 'GRID' })
  expect(frame.layoutMode).toBe('GRID')
})

test('mode GRID with all grid keys sets counts and gaps', () => {
  const frame = makeGridFrame()
  applyLayout(frame, {
    mode: 'GRID',
    rows: 2,
    cols: 3,
    rowGap: 8,
    colGap: 12,
  })
  expect(frame.layoutMode).toBe('GRID')
  expect(frame.gridRowCount).toBe(2)
  expect(frame.gridColumnCount).toBe(3)
  expect(frame.gridRowGap).toBe(8)
  expect(frame.gridColumnGap).toBe(12)
})

test('partial GRID (rows only) sets only rows; other grid fields untouched', () => {
  const frame = makeGridFrame()
  // seed sentinel on the grid fields so we can assert untouched
  frame.gridRowCount = -1
  frame.gridColumnCount = -1
  frame.gridRowGap = -1
  frame.gridColumnGap = -1
  applyLayout(frame, { mode: 'GRID', rows: 4 })
  expect(frame.gridRowCount).toBe(4)
  expect(frame.gridColumnCount).toBe(-1)
  expect(frame.gridRowGap).toBe(-1)
  expect(frame.gridColumnGap).toBe(-1)
})

// ─── per-track sizing (I56) ───────────────────────────────────────────────────
//
// ⚠️ ASSUMED RUNTIME BEHAVIOUR — NOT LIVE-CONFIRMED.
//
// `gridRowSizes` returns an array of `GridTrackSize` objects, and the Figma
// docs' own example mutates one IN PLACE (`frame.gridRowSizes[0].type =
// 'FIXED'`) and then reads the new value back off the frame. So the array's
// entries are modelled here as LIVE handles: a write through one reaches the
// frame. If the real runtime hands back a detached SNAPSHOT instead, that
// mutation lands on a copy and the frame keeps its old tracks — the shape of
// failure this campaign already met once (5710f56), where the effect happens
// at assignment time and a headless green proves nothing.
//
// Both worlds are modelled. `makeTrackFrame` is the live-handle runtime; the
// snapshot runtime is `snapshotTrackFrame` below, and the applier is required
// to fall back to whole-array assignment and then to SAY SO if neither took.
// Which of the two Figma actually is must be settled by a live probe.

type FakeTrack = { type: string; value?: number }

const makeTrackFrame = (
  rows: number,
  cols: number,
): LayoutTarget & {
  gridRowCount: number
  gridColumnCount: number
  gridRowGap: number
  gridColumnGap: number
  gridRowSizes: FakeTrack[]
  gridColumnSizes: FakeTrack[]
} => ({
  ...makeGridFrame(),
  gridRowSizes: Array.from({ length: rows }, () => ({
    type: 'FLEX',
    value: 1,
  })),
  gridColumnSizes: Array.from({ length: cols }, () => ({
    type: 'FLEX',
    value: 1,
  })),
})

test('I56: track sizes are written onto the tracks the grid already has', () => {
  const frame = makeTrackFrame(2, 2)
  const warnings: string[] = []
  applyLayout(
    frame,
    {
      mode: 'GRID',
      rows: 2,
      cols: 2,
      rowSizes: [
        { type: 'FIXED', value: 64 },
        { type: 'FLEX', value: 1 },
      ],
      colSizes: [
        { type: 'FIXED', value: 240 },
        { type: 'FLEX', value: 1 },
      ],
    },
    warnings,
  )
  expect(frame.gridRowSizes[0]).toEqual({
    type: 'FIXED',
    value: 64,
  })
  expect(frame.gridColumnSizes[0]).toEqual({
    type: 'FIXED',
    value: 240,
  })
  expect(frame.gridColumnSizes[1].type).toBe('FLEX')
  expect(warnings).toEqual([])
})

test('I56: a HUG track carries no value', () => {
  const frame = makeTrackFrame(1, 1)
  applyLayout(frame, {
    mode: 'GRID',
    colSizes: [{ type: 'HUG' }],
  })
  expect(frame.gridColumnSizes[0].type).toBe('HUG')
})

test('I56: naming more tracks than the grid has is reported, and the rest still land', () => {
  const frame = makeTrackFrame(1, 2)
  const warnings: string[] = []
  applyLayout(
    frame,
    {
      mode: 'GRID',
      cols: 2,
      colSizes: [
        { type: 'FIXED', value: 240 },
        { type: 'FLEX', value: 1 },
        { type: 'FIXED', value: 80 },
      ],
    },
    warnings,
  )
  expect(frame.gridColumnSizes[0].value).toBe(240)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('colSizes')
  expect(warnings[0]).toContain('3')
  expect(warnings[0]).toContain('2')
})

test('I56: a runtime with no gridRowSizes says the capability is missing, once', () => {
  const frame = makeGridFrame()
  const warnings: string[] = []
  expect(() =>
    applyLayout(
      frame,
      {
        mode: 'GRID',
        rowSizes: [{ type: 'FIXED', value: 64 }],
        colSizes: [{ type: 'FIXED', value: 240 }],
      },
      warnings,
    ),
  ).not.toThrow()
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toMatch(/gridRowSizes|track/i)
})

test('I56: a SNAPSHOT runtime is caught by the whole-array fallback', () => {
  // The other world: reading `gridRowSizes` hands back a fresh copy every
  // time, so mutating an entry changes nothing. Assigning the whole array
  // still works, and that is the documented second mechanism.
  let columns: FakeTrack[] = [
    { type: 'FLEX', value: 1 },
    { type: 'FLEX', value: 1 },
  ]
  const frame = makeTrackFrame(1, 0) as LayoutTarget & {
    gridColumnSizes: FakeTrack[]
  }
  Object.defineProperty(frame, 'gridColumnSizes', {
    get: () => columns.map(t => ({ ...t })),
    set: (next: FakeTrack[]) => {
      columns = next.map(t => ({ ...t }))
    },
    configurable: true,
    enumerable: true,
  })
  const warnings: string[] = []
  applyLayout(
    frame,
    {
      mode: 'GRID',
      cols: 2,
      colSizes: [
        { type: 'FIXED', value: 240 },
        { type: 'FLEX', value: 1 },
      ],
    },
    warnings,
  )
  expect(frame.gridColumnSizes[0]).toEqual({
    type: 'FIXED',
    value: 240,
  })
  expect(warnings).toEqual([])
})

test('I56: a runtime that refuses both mechanisms is named, not hidden', () => {
  const frozen: FakeTrack[] = [{ type: 'FLEX', value: 1 }]
  const frame = makeTrackFrame(1, 0) as LayoutTarget & {
    gridColumnSizes: FakeTrack[]
  }
  Object.defineProperty(frame, 'gridColumnSizes', {
    get: () => frozen.map(t => ({ ...t })),
    set: () => {
      /* swallows the write, the way a read-only getter would */
    },
    configurable: true,
    enumerable: true,
  })
  const warnings: string[] = []
  applyLayout(
    frame,
    {
      mode: 'GRID',
      cols: 1,
      colSizes: [{ type: 'FIXED', value: 240 }],
    },
    warnings,
  )
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('colSizes[0]')
  expect(warnings[0]).toContain('FIXED')
})

test('GRID feature-detect: absent gridRowCount property → no throw, no assignment', () => {
  // Simulate a runtime that does NOT support gridRowCount (T7 degrade).
  // makeFrame() has no gridRowCount so 'gridRowCount' in frame is false.
  const frame = makeFrame()
  expect(() =>
    applyLayout(frame, {
      mode: 'GRID',
      rows: 2,
      cols: 3,
      rowGap: 8,
      colGap: 12,
    }),
  ).not.toThrow()
  // The fields should not have been set (they don't exist on the object).
  expect('gridRowCount' in frame).toBe(false)
  expect('gridColumnCount' in frame).toBe(false)
})

test('GRID feature-detect degrade pushes a warning when grid fields absent', () => {
  // makeFrame() has no gridRowCount → feature-detect fails → warning.
  const frame = makeFrame()
  const warnings: string[] = []
  applyLayout(
    frame,
    { mode: 'GRID', rows: 2, cols: 3 },
    warnings,
  )
  // Should warn that grid fields are unsupported at runtime.
  expect(warnings.length).toBeGreaterThan(0)
  expect(warnings[0]).toMatch(/GRID/i)
})

// ─── B58's thin net: a layout write proves itself, or says it failed ─────────
//
// This is the verify-after-apply net, and it is deliberately NOT the B58 fix.
// It was built for B58 and could not catch it: the read-back was honest and the
// write had still been destroyed. The real cause was `align: SPACE_BETWEEN`
// paired with a VARIABLE-BOUND `gap` — a pair Figma's plugin API stores and
// renders while its properties panel silently normalizes it away the first time
// anyone clicks the node. That pair is refused before it can ever be written
// (space-between-gap.test.ts); this net stays for unknown future drops.
//
// It touches no selection. Three rounds deselected the target, waited for the
// deselection to render, and restored the selection afterwards, all chasing a
// mis-attributed trigger — a plain literal gap writes fine under a live
// selection, so none of that machinery was load-bearing.

/**
 * A frame whose named property refuses every write. `acceptFrom` lets it start
 * accepting on the Nth write, which is how the retry arm is exercised.
 */
const stubbornFrame = (
  field: keyof LayoutTarget,
  acceptFrom = Infinity,
): LayoutTarget & { writes: number } => {
  const frame = makeFrame() as LayoutTarget & {
    writes: number
  }
  let held = frame[field] as unknown
  let writes = 0
  Object.defineProperty(frame, field, {
    get: () => held,
    set: (v: unknown) => {
      writes += 1
      if (writes >= acceptFrom) {
        held = v
      }
    },
    configurable: true,
  })
  Object.defineProperty(frame, 'writes', {
    get: () => writes,
    configurable: true,
  })
  return frame
}

test('B58: a dropped align is named, with intended and actual', () => {
  const frame = stubbornFrame('primaryAxisAlignItems')
  const warnings: string[] = []
  applyLayout(
    frame,
    { mode: 'H', align: ['SPACE_BETWEEN', 'CENTER'] },
    warnings,
  )
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('primaryAxisAlignItems')
  expect(warnings[0]).toContain('SPACE_BETWEEN')
  expect(warnings[0]).toContain('CENTER')
})

test('B58: the write is retried ONCE before it is called dropped', () => {
  // Accepts the second write — the shape a transient re-assertion has.
  const frame = stubbornFrame('primaryAxisAlignItems', 2)
  const warnings: string[] = []
  applyLayout(
    frame,
    { mode: 'H', align: ['SPACE_BETWEEN', 'CENTER'] },
    warnings,
  )
  expect(frame.primaryAxisAlignItems).toBe('SPACE_BETWEEN')
  expect(warnings).toEqual([])
})

test('B58: it retries once, not forever', () => {
  const frame = stubbornFrame('primaryAxisAlignItems')
  applyLayout(frame, {
    mode: 'H',
    align: ['SPACE_BETWEEN', 'CENTER'],
  })
  expect(frame.writes).toBe(2)
})

test('B58: a dropped padding is named too', () => {
  const frame = stubbornFrame('paddingLeft')
  const warnings: string[] = []
  applyLayout(
    frame,
    { mode: 'V', padding: [8, 8, 8, 24] },
    warnings,
  )
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('paddingLeft')
  expect(warnings[0]).toContain('24')
})

test('B58: a dropped layoutMode is named', () => {
  const frame = stubbornFrame('layoutMode')
  const warnings: string[] = []
  applyLayout(frame, { mode: 'H' }, warnings)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('layoutMode')
  expect(warnings[0]).toContain('HORIZONTAL')
})

test('B58: a layout that lands says nothing', () => {
  const frame = makeFrame()
  const warnings: string[] = []
  applyLayout(
    frame,
    {
      mode: 'H',
      spacing: 12,
      padding: [4, 4, 4, 4],
      align: ['SPACE_BETWEEN', 'CENTER'],
      wrap: true,
    },
    warnings,
  )
  expect(warnings).toEqual([])
})

test('B58: only the field that dropped is named, not the whole patch', () => {
  const frame = stubbornFrame('itemSpacing')
  const warnings: string[] = []
  applyLayout(
    frame,
    {
      mode: 'H',
      spacing: 12,
      align: ['SPACE_BETWEEN', 'CENTER'],
    },
    warnings,
  )
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('itemSpacing')
  // …and the fields that DID land are not slandered.
  expect(warnings[0]).not.toContain('primaryAxis')
  expect(frame.primaryAxisAlignItems).toBe('SPACE_BETWEEN')
})

test('B58: a dropped grid count is named on a runtime that supports GRID', () => {
  const frame = makeGridFrame() as LayoutTarget & {
    gridRowCount?: number
  }
  let held = 0
  Object.defineProperty(frame, 'gridRowCount', {
    get: () => held,
    set: () => {
      held = 0
    },
    configurable: true,
  })
  const warnings: string[] = []
  applyLayout(frame, { mode: 'GRID', rows: 3 }, warnings)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('gridRowCount')
})
