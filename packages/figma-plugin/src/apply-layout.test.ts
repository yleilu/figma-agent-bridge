import { expect, test } from 'bun:test'

import {
  applyLayout,
  RESTORE_DELAY_MS,
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
  applyLayout(
    frame,
    { mode: 'GRID', rows: 2, cols: 3 },
    warnings,
  )
  // Should warn that grid fields are unsupported at runtime.
  expect(warnings.length).toBeGreaterThan(0)
  expect(warnings[0]).toMatch(/GRID/i)
})

// ─── B58: a layout write proves itself, or says it failed ────────────────────
//
// Proven live with Lei holding the selection: a REAL UI selection on the target
// node at write time makes the align write silently drop. ok, warnings [],
// read-back unchanged, geometry unchanged. Deselect and the IDENTICAL write
// lands. Seven agent-only variants had all passed, an API set_selection on the
// target included, so the trigger is the UI selection specifically — Figma's
// properties panel re-asserting what it is showing, most likely.
//
// The mock cannot hold a UI selection, so what is pinned here is the CODE PATH
// CONTRACT: after applying, read the values back; on a mismatch write once
// more; if it still did not take, name the field, what was asked, and what is
// actually there. Never ok with empty warnings on a field that did not hold.
// Only live verification can prove the retry beats the panel.

/**
 * A frame whose named property refuses every write — the panel re-asserting
 * its own value. `acceptFrom` lets it start accepting on the Nth write, which
 * is how the retry arm is exercised.
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

// ─── B58 rework: the blink has to span real UI frames ────────────────────────
//
// Two live attempts failed before this shape, and each one narrowed it.
//
// Round 1 read every field back after applying and retried a mismatch once.
// Live, with Lei holding a real UI selection: ok, EMPTY warnings — the
// read-back saw the new value and was telling the truth — and a read seconds
// later showed align MIN with the geometry unchanged. The value holds at apply
// time and is reverted AFTER the reply, when Figma's properties panel
// re-asserts its stale state. No in-handler check can catch that.
//
// Round 2 deselected the target for the write and restored the selection in the
// same handler. The mitigation fired, the warning arrived verbatim, and the
// value STILL reverted — while a human deselect before the identical write made
// it stick. A deselect and a restore inside one synchronous turn is not a blink:
// the UI never gets a frame in which to process it, so the panel never drops
// its stale context and the selection was, from its point of view, never
// interrupted.
//
// So the restore is DEFERRED past the reply. What is pinned below is that
// separation in time — the restore must NOT have happened when the handler
// would return, and must happen once the deferral runs.

/**
 * A stand-in for `figma.currentPage`: a settable selection that records every
 * assignment, so a test can assert the deselect→restore SEQUENCE and not just
 * the final state (restoring correctly while never having deselected would
 * otherwise look identical).
 */
const fakePage = (selectedIds: string[]) => {
  let current: readonly { id: string }[] = selectedIds.map(
    id => ({ id }),
  )
  const history: string[][] = []
  return {
    get selection(): readonly { id: string }[] {
      return current
    },
    set selection(next: readonly { id: string }[]) {
      current = next
      history.push(next.map(n => n.id))
    },
    history,
  }
}

/** A hand-cranked clock: nothing runs until the test says so. */
const fakeClock = () => {
  const pending: (() => void)[] = []
  return {
    defer: (fn: () => void) => {
      pending.push(fn)
    },
    get scheduled(): number {
      return pending.length
    },
    /** Run everything deferred so far, as the timer eventually would. */
    flush: () => {
      const due = pending.splice(0, pending.length)
      for (const fn of due) {
        fn()
      }
    },
  }
}

const framed = (id: string): LayoutTarget => ({
  ...makeFrame(),
  id,
})

const SELECTED_LAYOUT: AppliedLayout = {
  mode: 'H',
  align: ['SPACE_BETWEEN', 'CENTER'],
}

test('B58: the restore does NOT run in the handler — that is the whole fix', () => {
  const page = fakePage(['1:1'])
  const clock = fakeClock()
  applyLayout(framed('1:1'), SELECTED_LAYOUT, [], {
    page,
    defer: clock.defer,
  })
  // applyLayout has returned; the reply would go out now. The target must
  // still be deselected, or the UI never notices the blink at all.
  expect(page.history).toEqual([[]])
  expect(page.selection.map(n => n.id)).toEqual([])
  expect(clock.scheduled).toBe(1)
})

test('B58: …and DOES run once the deferral fires', () => {
  const page = fakePage(['1:1'])
  const clock = fakeClock()
  applyLayout(framed('1:1'), SELECTED_LAYOUT, [], {
    page,
    defer: clock.defer,
  })
  clock.flush()
  expect(page.history).toEqual([[], ['1:1']])
  expect(page.selection.map(n => n.id)).toEqual(['1:1'])
})

test('B58: the blink is announced, and says the selection comes back', () => {
  const page = fakePage(['1:1'])
  const clock = fakeClock()
  const warnings: string[] = []
  applyLayout(framed('1:1'), SELECTED_LAYOUT, warnings, {
    page,
    defer: clock.defer,
  })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('selection')
  expect(warnings[0]).toContain('1:1')
  expect(warnings[0]).toContain('a moment later')
})

test('B58: a multi-selection keeps every OTHER node selected throughout', () => {
  const page = fakePage(['0:9', '1:1', '2:2'])
  const clock = fakeClock()
  applyLayout(framed('1:1'), SELECTED_LAYOUT, [], {
    page,
    defer: clock.defer,
  })
  expect(page.history).toEqual([['0:9', '2:2']])
  clock.flush()
  expect(page.history).toEqual([
    ['0:9', '2:2'],
    ['0:9', '1:1', '2:2'],
  ])
})

test('B58: an UNSELECTED target schedules nothing and touches nothing', () => {
  const page = fakePage(['9:9'])
  const clock = fakeClock()
  const warnings: string[] = []
  applyLayout(framed('1:1'), SELECTED_LAYOUT, warnings, {
    page,
    defer: clock.defer,
  })
  expect(page.history).toEqual([])
  expect(clock.scheduled).toBe(0)
  expect(warnings).toEqual([])
})

test('B58: no guard at all behaves exactly as before', () => {
  const frame = framed('1:1')
  const warnings: string[] = []
  applyLayout(frame, SELECTED_LAYOUT, warnings)
  expect(frame.primaryAxisAlignItems).toBe('SPACE_BETWEEN')
  expect(warnings).toEqual([])
})

test('B58: the restore is still SCHEDULED when the apply throws', () => {
  // Leaving the user deselected because a write failed would be worse than the
  // bug being fixed — and the scheduling is in a `finally` for that reason.
  const page = fakePage(['1:1'])
  const clock = fakeClock()
  const frame = framed('1:1')
  Object.defineProperty(frame, 'primaryAxisAlignItems', {
    set: () => {
      throw new Error('Cannot set align on this node')
    },
    get: () => 'MIN',
    configurable: true,
  })
  expect(() =>
    applyLayout(frame, SELECTED_LAYOUT, [], {
      page,
      defer: clock.defer,
    }),
  ).toThrow('Cannot set align')
  expect(clock.scheduled).toBe(1)
  clock.flush()
  expect(page.selection.map(n => n.id)).toEqual(['1:1'])
})

test('B58: a user who re-selects during the blink KEEPS their selection', () => {
  // The deferral opens a window the user can act in. Putting the old selection
  // back on top of one they just made by hand would be a worse theft than the
  // blink itself.
  const page = fakePage(['1:1'])
  const clock = fakeClock()
  applyLayout(framed('1:1'), SELECTED_LAYOUT, [], {
    page,
    defer: clock.defer,
  })
  page.selection = [{ id: '7:7' }]
  clock.flush()
  expect(page.selection.map(n => n.id)).toEqual(['7:7'])
  // …and the restore did not write at all, so nothing flickered.
  expect(page.history).toEqual([[], ['7:7']])
})

test('B58: an untouched selection is restored even as a fresh array', () => {
  // Figma hands back a NEW array on every read, so identity cannot be the test
  // — the restore compares which nodes are selected.
  const page = fakePage(['1:1'])
  const clock = fakeClock()
  applyLayout(framed('1:1'), SELECTED_LAYOUT, [], {
    page,
    defer: clock.defer,
  })
  page.selection = []
  clock.flush()
  expect(page.selection.map(n => n.id)).toEqual(['1:1'])
})

test('B58: a failed restore reports through onError, not warnings', () => {
  // The reply is long gone by the time the restore runs, so `warnings` cannot
  // carry the failure and an uncaught throw from a timer helps nobody.
  const clock = fakeClock()
  const notices: string[] = []
  let current: readonly { id: string }[] = [{ id: '1:1' }]
  let writes = 0
  const page = {
    get selection(): readonly { id: string }[] {
      return current
    },
    set selection(next: readonly { id: string }[]) {
      writes += 1
      if (writes > 1) {
        throw new Error('selection is not settable now')
      }
      current = next
    },
  }
  const warnings: string[] = []
  applyLayout(framed('1:1'), SELECTED_LAYOUT, warnings, {
    page,
    defer: clock.defer,
    onError: m => notices.push(m),
  })
  expect(() => clock.flush()).not.toThrow()
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain('1:1')
  // The reply's warnings carry the blink only — never the later failure.
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('a moment later')
})

test('B58: the verify/retry safety net still runs inside the guard', () => {
  const page = fakePage(['1:1'])
  const clock = fakeClock()
  const frame = framed('1:1')
  let held = 'MIN'
  Object.defineProperty(frame, 'primaryAxisAlignItems', {
    get: () => held,
    set: () => {
      held = 'MIN'
    },
    configurable: true,
  })
  const warnings: string[] = []
  applyLayout(frame, SELECTED_LAYOUT, warnings, {
    page,
    defer: clock.defer,
  })
  expect(warnings).toHaveLength(2)
  expect(warnings.some(w => w.includes('selection'))).toBe(
    true,
  )
  expect(
    warnings.some(w => w.includes('primaryAxisAlignItems')),
  ).toBe(true)
})

test('B58: a frame with no id is never deselected (nothing to match on)', () => {
  const page = fakePage(['1:1'])
  const clock = fakeClock()
  applyLayout(makeFrame(), SELECTED_LAYOUT, [], {
    page,
    defer: clock.defer,
  })
  expect(page.history).toEqual([])
  expect(clock.scheduled).toBe(0)
})

// The PRODUCTION path passes no `defer` — code.ts hands over only the page and
// the notifier — so the default deferral is what actually ships. A default that
// quietly ran inline would be round 2 again, with every test above still green.
test('B58: the DEFAULT deferral is a real one — nothing restores inline', async () => {
  const page = fakePage(['1:1'])
  applyLayout(framed('1:1'), SELECTED_LAYOUT, [], { page })
  expect(page.history).toEqual([[]])
  await new Promise(resolve =>
    setTimeout(resolve, RESTORE_DELAY_MS * 3),
  )
  expect(page.history).toEqual([[], ['1:1']])
})
