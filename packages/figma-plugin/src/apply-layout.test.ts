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

test('partial {mode:H, wrap:true} does not throw; leaves spacing/padding/align untouched', async () => {
  const frame = makeFrame()
  const layout: AppliedLayout = { mode: 'H', wrap: true }
  await expect(
    applyLayout(frame, layout),
  ).resolves.toBeUndefined()

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

test('partial {mode:V, spacing:8} sets spacing only; padding/align untouched', async () => {
  const frame = makeFrame()
  const layout: AppliedLayout = { mode: 'V', spacing: 8 }
  await expect(
    applyLayout(frame, layout),
  ).resolves.toBeUndefined()

  expect(frame.layoutMode).toBe('VERTICAL')
  expect(frame.itemSpacing).toBe(8)
  // untouched
  expect(frame.paddingTop).toBe(SENTINEL.paddingTop)
  expect(frame.primaryAxisAlignItems).toBe(
    SENTINEL.primaryAxisAlignItems,
  )
  expect(frame.layoutWrap).toBe(SENTINEL.layoutWrap)
})

test('partial {mode:H, spacing:8, padding} (no align) sets padding; align untouched', async () => {
  const frame = makeFrame()
  const layout: AppliedLayout = {
    mode: 'H',
    spacing: 8,
    padding: [4, 4, 4, 4],
  }
  await expect(
    applyLayout(frame, layout),
  ).resolves.toBeUndefined()

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

test('partial {mode:H, align} (no padding) sets align; padding untouched', async () => {
  const frame = makeFrame()
  const layout: AppliedLayout = {
    mode: 'H',
    align: ['MIN', 'MIN'],
  }
  await expect(
    applyLayout(frame, layout),
  ).resolves.toBeUndefined()

  expect(frame.primaryAxisAlignItems).toBe('MIN')
  expect(frame.counterAxisAlignItems).toBe('MIN')
  // untouched
  expect(frame.paddingTop).toBe(SENTINEL.paddingTop)
  expect(frame.paddingLeft).toBe(SENTINEL.paddingLeft)
})

test('asymmetric padding maps [top,right,bottom,left] in order', async () => {
  const frame = makeFrame()
  await applyLayout(frame, {
    mode: 'V',
    padding: [1, 2, 3, 4],
  })
  expect(frame.paddingTop).toBe(1)
  expect(frame.paddingRight).toBe(2)
  expect(frame.paddingBottom).toBe(3)
  expect(frame.paddingLeft).toBe(4)
})

test('full layout sets every field', async () => {
  const frame = makeFrame()
  await applyLayout(frame, {
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

test('mode NONE disables auto-layout (not VERTICAL)', async () => {
  const frame = makeFrame()
  frame.layoutMode = 'HORIZONTAL'
  await applyLayout(frame, { mode: 'NONE' })
  expect(frame.layoutMode).toBe('NONE')
})

test('wrap:false does not set WRAP', async () => {
  const frame = makeFrame()
  await applyLayout(frame, { mode: 'H', wrap: false })
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

test('mode GRID sets layoutMode to GRID', async () => {
  const frame = makeGridFrame()
  await applyLayout(frame, { mode: 'GRID' })
  expect(frame.layoutMode).toBe('GRID')
})

test('mode GRID with all grid keys sets counts and gaps', async () => {
  const frame = makeGridFrame()
  await applyLayout(frame, {
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

test('partial GRID (rows only) sets only rows; other grid fields untouched', async () => {
  const frame = makeGridFrame()
  // seed sentinel on the grid fields so we can assert untouched
  frame.gridRowCount = -1
  frame.gridColumnCount = -1
  frame.gridRowGap = -1
  frame.gridColumnGap = -1
  await applyLayout(frame, { mode: 'GRID', rows: 4 })
  expect(frame.gridRowCount).toBe(4)
  expect(frame.gridColumnCount).toBe(-1)
  expect(frame.gridRowGap).toBe(-1)
  expect(frame.gridColumnGap).toBe(-1)
})

test('GRID feature-detect: absent gridRowCount property → no throw, no assignment', async () => {
  // Simulate a runtime that does NOT support gridRowCount (T7 degrade).
  // makeFrame() has no gridRowCount so 'gridRowCount' in frame is false.
  const frame = makeFrame()
  await expect(
    applyLayout(frame, {
      mode: 'GRID',
      rows: 2,
      cols: 3,
      rowGap: 8,
      colGap: 12,
    }),
  ).resolves.toBeUndefined()
  // The fields should not have been set (they don't exist on the object).
  expect('gridRowCount' in frame).toBe(false)
  expect('gridColumnCount' in frame).toBe(false)
})

test('GRID feature-detect degrade pushes a warning when grid fields absent', async () => {
  // makeFrame() has no gridRowCount → feature-detect fails → warning.
  const frame = makeFrame()
  const warnings: string[] = []
  await applyLayout(
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

test('B58: a dropped align is named, with intended and actual', async () => {
  const frame = stubbornFrame('primaryAxisAlignItems')
  const warnings: string[] = []
  await applyLayout(
    frame,
    { mode: 'H', align: ['SPACE_BETWEEN', 'CENTER'] },
    warnings,
  )
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('primaryAxisAlignItems')
  expect(warnings[0]).toContain('SPACE_BETWEEN')
  expect(warnings[0]).toContain('CENTER')
})

test('B58: the write is retried ONCE before it is called dropped', async () => {
  // Accepts the second write — the shape a transient re-assertion has.
  const frame = stubbornFrame('primaryAxisAlignItems', 2)
  const warnings: string[] = []
  await applyLayout(
    frame,
    { mode: 'H', align: ['SPACE_BETWEEN', 'CENTER'] },
    warnings,
  )
  expect(frame.primaryAxisAlignItems).toBe('SPACE_BETWEEN')
  expect(warnings).toEqual([])
})

test('B58: it retries once, not forever', async () => {
  const frame = stubbornFrame('primaryAxisAlignItems')
  await applyLayout(frame, {
    mode: 'H',
    align: ['SPACE_BETWEEN', 'CENTER'],
  })
  expect(frame.writes).toBe(2)
})

test('B58: a dropped padding is named too', async () => {
  const frame = stubbornFrame('paddingLeft')
  const warnings: string[] = []
  await applyLayout(
    frame,
    { mode: 'V', padding: [8, 8, 8, 24] },
    warnings,
  )
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('paddingLeft')
  expect(warnings[0]).toContain('24')
})

test('B58: a dropped layoutMode is named', async () => {
  const frame = stubbornFrame('layoutMode')
  const warnings: string[] = []
  await applyLayout(frame, { mode: 'H' }, warnings)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('layoutMode')
  expect(warnings[0]).toContain('HORIZONTAL')
})

test('B58: a layout that lands says nothing', async () => {
  const frame = makeFrame()
  const warnings: string[] = []
  await applyLayout(
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

test('B58: only the field that dropped is named, not the whole patch', async () => {
  const frame = stubbornFrame('itemSpacing')
  const warnings: string[] = []
  await applyLayout(
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

test('B58: a dropped grid count is named on a runtime that supports GRID', async () => {
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
  await applyLayout(
    frame,
    { mode: 'GRID', rows: 3 },
    warnings,
  )
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('gridRowCount')
})

// ─── B58: sequencing around a Figma platform defect ──────────────────────────
//
// Four live rounds, each narrowing the mechanism.
//
// R1 read every field back after applying and retried a mismatch once. Live,
// with Lei holding a real UI selection: ok, EMPTY warnings — and a read seconds
// later showed align MIN. The verify passed on a write that had not landed.
//
// R2 deselected the target and restored the selection in the same handler. Same
// result, while a human deselect before the identical write made it stick.
//
// R3 deferred the restore past the reply. The blink became VISIBLE on screen —
// and the decisive observation: the bar never spread, not even for a frame,
// while the verify still read SPACE_BETWEEN back as applied.
//
// That isolates the mechanism, and it is a FIGMA PLATFORM DEFECT the bridge can
// only sequence around: a layout write landing in the same UI frame as a
// still-RENDERED selection is a silent no-op at the document layer, while the
// API object echoes the value back. The verify is lied to from inside the
// affected frame — so no amount of reading, retrying or reporting can detect
// it, because the instrument is the thing being falsified. R2 and R3
// deselected and applied in the same turn, so every apply still happened under
// a rendered selection.
//
// R4, below: deselect, WAIT for that to render, then apply. The wait is
// load-bearing and cannot be zero.

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

/**
 * A hand-cranked clock: nothing moves until the test says so.
 *
 * `wait` is the PRE-APPLY settle (round 4) and `defer` is the post-reply
 * restore (round 3). They are separate handles because the whole point is that
 * they happen at different times.
 */
const fakeClock = () => {
  const deferred: (() => void)[] = []
  const waiters: (() => void)[] = []
  return {
    defer: (fn: () => void) => {
      deferred.push(fn)
    },
    wait: (): Promise<void> =>
      new Promise<void>(resolve => {
        waiters.push(resolve)
      }),
    /** How many pre-apply settles are outstanding. */
    get waiting(): number {
      return waiters.length
    },
    /** How many post-reply restores are outstanding. */
    get scheduled(): number {
      return deferred.length
    },
    /** Let the pre-apply wait finish, as the timer eventually would. */
    settle: async (): Promise<void> => {
      for (const resolve of waiters.splice(0)) {
        resolve()
      }
    },
    /** Run the deferred restore, as the timer eventually would. */
    flush: () => {
      for (const fn of deferred.splice(0)) {
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

const guardOf = (
  page: ReturnType<typeof fakePage>,
  clock: ReturnType<typeof fakeClock>,
) => ({ page, defer: clock.defer, wait: clock.wait })

test('B58: the apply does NOT happen before the deselection has settled', async () => {
  const page = fakePage(['1:1'])
  const clock = fakeClock()
  const frame = framed('1:1')
  const running = applyLayout(
    frame,
    SELECTED_LAYOUT,
    [],
    guardOf(page, clock),
  )
  // The deselect is out, the wait is pending, and the document is UNTOUCHED.
  // Applying here is what rounds 2 and 3 did, and it is why they failed.
  expect(page.history).toEqual([[]])
  expect(clock.waiting).toBe(1)
  expect(frame.primaryAxisAlignItems).toBe('CENTER')
  expect(frame.layoutMode).toBe('NONE')
  await clock.settle()
  await running
})

test('B58: …and DOES happen once it has', async () => {
  const page = fakePage(['1:1'])
  const clock = fakeClock()
  const frame = framed('1:1')
  const running = applyLayout(
    frame,
    SELECTED_LAYOUT,
    [],
    guardOf(page, clock),
  )
  await clock.settle()
  await running
  expect(frame.primaryAxisAlignItems).toBe('SPACE_BETWEEN')
  expect(frame.layoutMode).toBe('HORIZONTAL')
})

test('B58: the restore is deferred past the reply, not folded into the wait', async () => {
  const page = fakePage(['1:1'])
  const clock = fakeClock()
  const running = applyLayout(
    framed('1:1'),
    SELECTED_LAYOUT,
    [],
    guardOf(page, clock),
  )
  await clock.settle()
  await running
  // applyLayout has returned; the reply would go out now, and the target must
  // still be deselected or the UI never sees the blink at all.
  expect(page.history).toEqual([[]])
  expect(clock.scheduled).toBe(1)
  clock.flush()
  expect(page.history).toEqual([[], ['1:1']])
})

test('B58: an UNSELECTED target keeps the fully synchronous fast path', async () => {
  const page = fakePage(['9:9'])
  const clock = fakeClock()
  const frame = framed('1:1')
  const warnings: string[] = []
  const running = applyLayout(
    frame,
    SELECTED_LAYOUT,
    warnings,
    guardOf(page, clock),
  )
  // No wait, no timer, and the write has ALREADY landed before anything is
  // awaited — an unselected node must pay nothing for this mitigation.
  expect(clock.waiting).toBe(0)
  expect(clock.scheduled).toBe(0)
  expect(frame.primaryAxisAlignItems).toBe('SPACE_BETWEEN')
  expect(page.history).toEqual([])
  expect(warnings).toEqual([])
  await running
})

test('B58: no guard at all behaves exactly as before', async () => {
  const frame = framed('1:1')
  const warnings: string[] = []
  const running = applyLayout(
    frame,
    SELECTED_LAYOUT,
    warnings,
  )
  expect(frame.primaryAxisAlignItems).toBe('SPACE_BETWEEN')
  expect(warnings).toEqual([])
  await running
})

test('B58: the blink is announced, and says the selection comes back', async () => {
  const page = fakePage(['1:1'])
  const clock = fakeClock()
  const warnings: string[] = []
  const running = applyLayout(
    framed('1:1'),
    SELECTED_LAYOUT,
    warnings,
    guardOf(page, clock),
  )
  await clock.settle()
  await running
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('selection')
  expect(warnings[0]).toContain('1:1')
  expect(warnings[0]).toContain('a moment later')
})

test('B58: a multi-selection keeps every OTHER node selected throughout', async () => {
  const page = fakePage(['0:9', '1:1', '2:2'])
  const clock = fakeClock()
  const running = applyLayout(
    framed('1:1'),
    SELECTED_LAYOUT,
    [],
    guardOf(page, clock),
  )
  await clock.settle()
  await running
  expect(page.history).toEqual([['0:9', '2:2']])
  clock.flush()
  expect(page.history).toEqual([
    ['0:9', '2:2'],
    ['0:9', '1:1', '2:2'],
  ])
})

test('B58: the restore is still scheduled when the apply throws', async () => {
  // Leaving the user deselected because a write failed would be worse than the
  // bug being fixed — the scheduling is in a `finally` for that reason, and the
  // throw now has to survive an await to get there.
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
  const running = applyLayout(
    frame,
    SELECTED_LAYOUT,
    [],
    guardOf(page, clock),
  )
  await clock.settle()
  await expect(running).rejects.toThrow('Cannot set align')
  expect(clock.scheduled).toBe(1)
  clock.flush()
  expect(page.selection.map(n => n.id)).toEqual(['1:1'])
})

test('B58: a user who re-selects during the blink KEEPS their selection', async () => {
  // The wait plus the deferral opens a window the user can act in. Putting the
  // old selection back on top of one they just made by hand would be a worse
  // theft than the blink itself.
  const page = fakePage(['1:1'])
  const clock = fakeClock()
  const running = applyLayout(
    framed('1:1'),
    SELECTED_LAYOUT,
    [],
    guardOf(page, clock),
  )
  await clock.settle()
  await running
  page.selection = [{ id: '7:7' }]
  clock.flush()
  expect(page.selection.map(n => n.id)).toEqual(['7:7'])
  expect(page.history).toEqual([[], ['7:7']])
})

test('B58: an untouched selection is restored even as a fresh array', async () => {
  // Figma hands back a NEW array on every read, so identity cannot be the test
  // — the restore compares which nodes are selected.
  const page = fakePage(['1:1'])
  const clock = fakeClock()
  const running = applyLayout(
    framed('1:1'),
    SELECTED_LAYOUT,
    [],
    guardOf(page, clock),
  )
  await clock.settle()
  await running
  page.selection = []
  clock.flush()
  expect(page.selection.map(n => n.id)).toEqual(['1:1'])
})

test('B58: a failed restore reports through onError, not warnings', async () => {
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
  const running = applyLayout(
    framed('1:1'),
    SELECTED_LAYOUT,
    warnings,
    {
      page,
      defer: clock.defer,
      wait: clock.wait,
      onError: m => notices.push(m),
    },
  )
  await clock.settle()
  await running
  expect(() => clock.flush()).not.toThrow()
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain('1:1')
  // The reply's warnings carry the blink only — never the later failure.
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('a moment later')
})

test('B58: the verify/retry safety net still runs after the settle', async () => {
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
  const running = applyLayout(
    frame,
    SELECTED_LAYOUT,
    warnings,
    guardOf(page, clock),
  )
  await clock.settle()
  await running
  expect(warnings).toHaveLength(2)
  expect(warnings.some(w => w.includes('selection'))).toBe(
    true,
  )
  expect(
    warnings.some(w => w.includes('primaryAxisAlignItems')),
  ).toBe(true)
})

test('B58: a frame with no id is never deselected (nothing to match on)', async () => {
  const page = fakePage(['1:1'])
  const clock = fakeClock()
  await applyLayout(
    makeFrame(),
    SELECTED_LAYOUT,
    [],
    guardOf(page, clock),
  )
  expect(page.history).toEqual([])
  expect(clock.waiting).toBe(0)
  expect(clock.scheduled).toBe(0)
})

// The PRODUCTION path injects neither `wait` nor `defer` — code.ts hands over
// only the page and the notifier — so the DEFAULTS are what actually ship. A
// default that quietly ran inline would be round 3 again, with every test above
// still green.
test('B58: the default pre-apply wait is a real TIMER, not a microtask', async () => {
  const page = fakePage(['1:1'])
  const frame = framed('1:1')
  const running = applyLayout(frame, SELECTED_LAYOUT, [], {
    page,
  })
  expect(frame.primaryAxisAlignItems).toBe('CENTER')
  // Drain the microtask queue. A `Promise.resolve()` standing in for the wait
  // would let the apply through right here — and a microtask is the SAME UI
  // frame, which is precisely the frame Figma drops the write in. Only a
  // macrotask gives the deselection somewhere to render.
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
  expect(frame.primaryAxisAlignItems).toBe('CENTER')
  await running
  expect(frame.primaryAxisAlignItems).toBe('SPACE_BETWEEN')
})

test('B58: the default restore deferral is a real one', async () => {
  const page = fakePage(['1:1'])
  await applyLayout(framed('1:1'), SELECTED_LAYOUT, [], {
    page,
  })
  expect(page.history).toEqual([[]])
  await new Promise(resolve =>
    setTimeout(resolve, RESTORE_DELAY_MS * 3),
  )
  expect(page.history).toEqual([[], ['1:1']])
})
