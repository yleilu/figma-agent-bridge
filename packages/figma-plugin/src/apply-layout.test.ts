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
  applyLayout(frame, { mode: 'GRID', rows: 2, cols: 3 }, warnings)
  // Should warn that grid fields are unsupported at runtime.
  expect(warnings.length).toBeGreaterThan(0)
  expect(warnings[0]).toMatch(/GRID/i)
})
