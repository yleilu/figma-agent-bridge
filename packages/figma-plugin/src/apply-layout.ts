// Pure, side-effect-free auto-layout applier shared by create + update paths.
//
// The server's writer (`convertLayout` in node-spec-writer.ts) is PURE: it
// emits `spacing`/`padding`/`align`/`wrap` ONLY when present on the LayoutSpec.
// So this applier must mirror that contract — set each Figma field ONLY when
// the corresponding key is present, leaving Figma's own defaults untouched
// otherwise (no backfill). Setting them unconditionally indexed `padding[0]` /
// `align[0]` on a partial layout (e.g. `{mode:'H',wrap:true}`) and threw
// "Cannot read properties of undefined (reading '0')", failing the whole
// create/update.
//
// THE REVERT COMES AFTER THE REPLY (B58). A REAL UI selection on the target at
// write time makes the align write silently drop — `ok`, `warnings: []`, and a
// read seconds later shows the old value with the geometry unchanged. Deselect
// and the identical write lands, every time. Seven agent-only variants had
// passed, an API `set_selection` on the target included, so the trigger is the
// UI selection specifically: Figma's properties panel re-asserts what it is
// displaying over the still-selected node.
//
// The first fix for this read every field back after applying and retried a
// mismatch once. Live verification showed why that cannot work: the read-back
// SUCCEEDS. The value holds at apply time, the handler honestly reports ok, and
// the panel reverts it after the reply has already been sent. No in-handler
// check can catch a post-reply revert.
//
// So the target is briefly DESELECTED for the write and the selection restored
// afterwards, which makes the panel re-read the node instead of re-asserting
// its stale state. Only the target leaves the selection — a multi-selection
// keeps every other node. The blink is visible, so it is also NAMED in
// `warnings`.
//
// THE BLINK HAS TO SPAN REAL UI FRAMES, AND THE APPLY HAS TO LAND OUTSIDE THEM.
//
// A deselect and a restore inside one synchronous handler is not a blink at
// all: Figma's UI never gets a turn to process the deselection. Deferring the
// RESTORE past the reply made the blink visible on screen — and the value still
// reverted, with one decisive observation: the bar never spread, not even for a
// frame, while the verify read SPACE_BETWEEN back as applied.
//
// THE UNDERLYING BEHAVIOUR IS A FIGMA PLATFORM DEFECT, and the bridge can only
// sequence around it. When a layout write lands in the same UI frame as a
// still-RENDERED selection, the setter is a silent no-op at the document layer
// while the API object ECHOES the value back. The document never changed; the
// read-back is lied to. That is why every earlier round's verify passed
// honestly and reported ok on a write that had not happened, and why a human
// deselect before the same write always worked — the deselection had real
// frames to render in before the write arrived.
//
// So a guarded write DESELECTS, WAITS for the deselection to render, and only
// then applies. The wait is load-bearing and cannot be shortened to zero: the
// whole point is to leave the frame in which the setter lies. Nothing inside
// this module can detect the affected frame from within it, because the only
// instrument available — reading the property back — is exactly the thing the
// defect falsifies.
//
// The restore stays DEFERRED past the reply (`defer`, a timer by default). The
// handler answers without waiting for it, so the restore's own failures cannot
// ride the reply's `warnings` — they go to `onError`, which the plugin points
// at `figma.notify`.
//
// A deferred restore can also arrive to find the user has moved on. Putting
// the old selection back then would stomp a selection they made by hand, so
// the restore checks that the selection is still exactly what the mitigation
// left before touching it.
//
// An UNSELECTED target pays none of this: no wait, no timer, no await — the
// fast path stays fully synchronous.
//
// The read-back and its single retry STAY, as the safety net for every other
// way a field can fail to hold: a field that still refuses is NAMED, with what
// was asked and what is actually there. What this module must never do is what
// it used to do — report nothing while the layout the caller stated is not the
// layout on the node.
//
// This module declares the FrameNode surface it touches structurally (the
// figma `FrameNode` is structurally assignable to it) so it stays free of the
// figma runtime and is independently unit-testable with a plain fake node.

/** The exact layout shape the server's `convertLayout` emits. */
export type AppliedLayout = {
  mode: 'H' | 'V' | 'NONE' | 'GRID'
  spacing?: number
  padding?: [number, number, number, number]
  align?: [string, string]
  wrap?: boolean
  /** Grid row count (GRID mode only). */
  rows?: number
  /** Grid column count (GRID mode only). */
  cols?: number
  /** Grid row gap in px (GRID mode only). */
  rowGap?: number
  /** Grid column gap in px (GRID mode only). */
  colGap?: number
}

/** Structural subset of FrameNode this applier writes to. */
export type LayoutTarget = {
  /**
   * Optional so every existing caller and fake stays assignable — a real
   * FrameNode always has one. Without it the selection guard has nothing to
   * match the target against, so it simply does not run.
   */
  id?: string
  layoutMode: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID'
  itemSpacing: number
  paddingTop: number
  paddingRight: number
  paddingBottom: number
  paddingLeft: number
  primaryAxisAlignItems:
    | 'MIN'
    | 'MAX'
    | 'CENTER'
    | 'SPACE_BETWEEN'
  counterAxisAlignItems:
    | 'MIN'
    | 'MAX'
    | 'CENTER'
    | 'BASELINE'
  layoutWrap: 'NO_WRAP' | 'WRAP'
  // GRID fields (M12) — optional in the structural type so that runtimes
  // without GRID support remain structurally assignable. Presence is checked
  // at runtime via `'gridRowCount' in frame` (T7 feature-detect).
  gridRowCount?: number
  gridColumnCount?: number
  gridRowGap?: number
  gridColumnGap?: number
}

/**
 * Structural stand-in for `figma.currentPage` — a SETTABLE selection.
 *
 * Injected rather than reached for, so the deselect/restore dance is
 * unit-testable without a Figma runtime, like everything else here.
 */
export type SelectionHost = {
  selection: readonly { id: string }[]
}

/** How long the selection stays away before it is put back. */
export const RESTORE_DELAY_MS = 100

/**
 * How long to wait, after deselecting, before applying.
 *
 * About two UI frames. It has to be long enough for Figma to RENDER the
 * deselection, because a write that lands while the selection is still on
 * screen is silently dropped at the document layer while the API object echoes
 * it back (see the module header). Shortening this to zero restores the bug;
 * there is no in-process signal that says when the frame has passed.
 */
export const SETTLE_DELAY_MS = 80

/**
 * Everything the selection mitigation needs, injected so it can be driven by a
 * test with no Figma runtime and no real clock.
 */
export type SelectionGuard = {
  /** The page whose selection to protect — `figma.currentPage`. */
  page: SelectionHost
  /**
   * Run the restore LATER, past the reply. Defaults to a timer; a test passes
   * a collector and flushes it by hand. Deferring is the whole mitigation —
   * see the timing note in the module header.
   */
  defer?: (restore: () => void) => void
  /**
   * Wait `ms` before applying, so the deselection has frames to render in.
   * Defaults to a timer; a test passes a clock it can settle by hand.
   */
  wait?: (ms: number) => Promise<void>
  /**
   * Where a failed restore is reported. The reply has already gone out by
   * then, so `warnings` cannot carry it; the plugin points this at
   * `figma.notify` so the user is told rather than left deselected in silence.
   */
  onError?: (message: string) => void
}

/** The default pre-apply wait: a real timer, because a microtask is the same frame. */
const defaultWait = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

/**
 * The default deferral: past the current turn, so Figma's UI gets frames in
 * which to process the deselection.
 *
 * A runtime with no timers restores IMMEDIATELY. That is the synchronous
 * behaviour this rework exists to replace, so the mitigation stops working —
 * but never giving the selection back would be worse than not mitigating.
 */
const defaultDefer = (restore: () => void): void => {
  if (typeof setTimeout === 'function') {
    setTimeout(restore, RESTORE_DELAY_MS)
    return
  }
  restore()
}

/** Same nodes, order ignored — a selection is a set, not a sequence. */
const sameNodes = (
  a: readonly { id: string }[],
  b: readonly { id: string }[],
): boolean => {
  if (a.length !== b.length) {
    return false
  }
  const left = a.map(n => n?.id).sort()
  const right = b.map(n => n?.id).sort()
  return left.every((id, i) => id === right[i])
}

/** One Figma field this call means to set, and the value it means to set it to. */
type Intent = {
  field: keyof LayoutTarget
  value: string | number
}

/** What the caller is told when their selection blinked, and why. */
const selectionBlinkMessage = (id: string): string =>
  `applyLayout: \`${id}\` was selected in the Figma UI, so the selection was ` +
  'briefly cleared to apply the layout change. It comes back a moment later, ' +
  'once Figma has had frames in which to notice — a selected node has the ' +
  'properties panel re-asserting what it displays over it, which reverts a ' +
  'layout write AFTER the call returns (B58). The change landed; the selection ' +
  'blink is the cost of making it stick.'

/**
 * Take the target out of the UI selection for the write, and return the
 * function that puts the selection back — or UNDEFINED when nothing was done,
 * so an unselected write schedules no restore at all.
 *
 * Every step degrades to "do nothing" rather than throwing: a page that will
 * not report or accept a selection is a reason to skip the mitigation, never a
 * reason to fail the layout write it was meant to protect.
 */
const deselectTarget = (
  frame: LayoutTarget,
  guard: SelectionGuard | undefined,
  warnings?: string[],
): (() => void) | undefined => {
  const { id } = frame
  if (guard === undefined || typeof id !== 'string') {
    return undefined
  }
  const { page, onError } = guard
  let saved: readonly { id: string }[]
  try {
    saved = [...page.selection]
  } catch {
    return undefined
  }
  if (!saved.some(n => n?.id === id)) {
    return undefined
  }
  // Only the TARGET leaves. Clearing the whole selection would lose a
  // multi-selection the user built by hand.
  const left = saved.filter(n => n?.id !== id)
  try {
    page.selection = left
  } catch {
    return undefined
  }
  warnings?.push(selectionBlinkMessage(id))
  return () => {
    try {
      // The user may have selected something else during the blink. Putting
      // the old selection back on top of theirs would be a worse theft than
      // the blink itself, so restore ONLY an untouched selection.
      if (!sameNodes([...page.selection], left)) {
        return
      }
      page.selection = saved
    } catch {
      // The reply is long gone by the time this runs, so `warnings` cannot
      // carry the failure — and an uncaught throw from a timer helps nobody.
      onError?.(
        `The Figma selection could not be restored after the layout write to ${id}. ` +
          'Re-select the node.',
      )
    }
  }
}

/**
 * The Figma layoutMode a spec `mode` asks for. 'NONE' disables auto-layout
 * (it is NOT 'V'); 'H'/'V' map to HORIZONTAL/VERTICAL; 'GRID' maps to GRID.
 */
const layoutModeOf = (
  mode: AppliedLayout['mode'],
): LayoutTarget['layoutMode'] =>
  mode === 'NONE'
    ? 'NONE'
    : mode === 'H'
      ? 'HORIZONTAL'
      : mode === 'GRID'
        ? 'GRID'
        : 'VERTICAL'

/**
 * Everything this layout means to write, as flat field→value intents.
 *
 * The list IS the contract: `writeLayout` sets exactly these and the verify
 * checks exactly these, so a field can never be written without being proved,
 * or proved without being written. A grid field the runtime does not expose is
 * left out here — its absence is reported once, as a capability degrade, and is
 * not a dropped write.
 */
const intentsOf = (
  frame: LayoutTarget,
  layout: AppliedLayout,
): Intent[] => {
  const out: Intent[] = [
    {
      field: 'layoutMode',
      value: layoutModeOf(layout.mode),
    },
  ]
  if (layout.spacing !== undefined) {
    out.push({
      field: 'itemSpacing',
      value: layout.spacing,
    })
  }
  if (layout.padding !== undefined) {
    out.push(
      { field: 'paddingTop', value: layout.padding[0] },
      { field: 'paddingRight', value: layout.padding[1] },
      { field: 'paddingBottom', value: layout.padding[2] },
      { field: 'paddingLeft', value: layout.padding[3] },
    )
  }
  if (layout.align !== undefined) {
    out.push(
      {
        field: 'primaryAxisAlignItems',
        value: layout.align[0],
      },
      {
        field: 'counterAxisAlignItems',
        value: layout.align[1],
      },
    )
  }
  // `wrap: false` is deliberately NOT an intent: the pure-emit contract never
  // sets NO_WRAP, so there is nothing to verify.
  if (layout.wrap === true) {
    out.push({ field: 'layoutWrap', value: 'WRAP' })
  }
  if (layout.mode === 'GRID') {
    const grid: [keyof LayoutTarget, number | undefined][] =
      [
        ['gridRowCount', layout.rows],
        ['gridColumnCount', layout.cols],
        ['gridRowGap', layout.rowGap],
        ['gridColumnGap', layout.colGap],
      ]
    for (const [field, value] of grid) {
      if (value !== undefined && field in frame) {
        out.push({ field, value })
      }
    }
  }
  return out
}

const writeLayout = (
  frame: LayoutTarget,
  intents: Intent[],
): void => {
  const target = frame as unknown as Record<string, unknown>
  for (const { field, value } of intents) {
    target[field] = value
  }
}

/**
 * Whether the field holds what was asked. Numbers are compared with a small
 * tolerance: Figma stores layout numbers as floats, and calling a 12 that came
 * back 11.999999 a dropped write would be a warning about nothing.
 */
const held = (actual: unknown, want: string | number) =>
  typeof want === 'number'
    ? typeof actual === 'number' &&
      Math.abs(actual - want) < 0.01
    : actual === want

const droppedMessage = (
  { field, value }: Intent,
  actual: unknown,
): string =>
  `applyLayout: \`${field}\` did not hold — asked for ${String(value)}, ` +
  `the node reads ${String(actual)}. The write was retried once and refused ` +
  'again. A node SELECTED in the Figma UI is the known cause: the properties ' +
  'panel re-asserts what it displays. Deselect the node and repeat the call.'

/**
 * Write every intent, read them all back, rewrite the misses once, report the
 * rest.
 *
 * The read-back is only as honest as the frame it runs in. Under a rendered
 * selection Figma echoes the value back off the API object while the document
 * ignored it, so this reports a clean apply on a write that never landed — see
 * the module header. Sequencing the apply out of that frame is what makes this
 * check mean anything; it is the safety net for every OTHER way a field fails
 * to hold, not for that one.
 */
const writeAndVerify = (
  frame: LayoutTarget,
  intents: Intent[],
  warnings?: string[],
): void => {
  writeLayout(frame, intents)
  const reader = frame as unknown as Record<string, unknown>
  const missed = intents.filter(
    i => !held(reader[i.field], i.value),
  )
  if (missed.length === 0) {
    return
  }
  writeLayout(frame, missed)
  for (const intent of missed) {
    const actual = reader[intent.field]
    if (!held(actual, intent.value)) {
      warnings?.push(droppedMessage(intent, actual))
    }
  }
}

/**
 * Apply a (possibly partial) layout to a frame, and make it stick.
 *
 * `mode` is always set; every other field is set ONLY when present (pure-emit
 * contract mirror).
 *
 * `guard` carries the UI selection host — pass `figma.currentPage` when the
 * target is an EXISTING node the user may be looking at. When the target is in
 * that selection the write is SEQUENCED around a Figma platform defect (B58,
 * module header): deselect, WAIT for that to render, then apply, then restore
 * the selection after the reply. Omit `guard` for a node the user cannot have
 * selected — a node being created — and the whole body runs synchronously with
 * no timer and no await.
 *
 * AWAIT THE RESULT. On the guarded path this resolves only after the wait and
 * the apply; ignoring the promise would put the write back inside the frame
 * that drops it.
 *
 * Each written field is still read back, a mismatch rewritten once, and a field
 * that still refuses named on `warnings` — the safety net for every OTHER way a
 * write can fail to hold.
 *
 * T7 feature-detect for GRID: a runtime without `gridRowCount` etc. gets no
 * assignment and one capability warning on the optional `warnings` sink.
 */
export const applyLayout = async (
  frame: LayoutTarget,
  layout: AppliedLayout,
  warnings?: string[],
  guard?: SelectionGuard,
): Promise<void> => {
  // GRID-mode fields (M12). Feature-detect (T7): a runtime that does not expose
  // them gets ONE warning naming the capability, not four dropped-write
  // reports — an absent property is not a refused one.
  if (
    layout.mode === 'GRID' &&
    !('gridRowCount' in frame)
  ) {
    const hasGridKeys =
      layout.rows !== undefined ||
      layout.cols !== undefined ||
      layout.rowGap !== undefined ||
      layout.colGap !== undefined
    if (hasGridKeys && warnings) {
      warnings.push(
        'applyLayout: GRID mode grid fields (gridRowCount/gridColumnCount/gridRowGap/gridColumnGap) are not available in this runtime — keys ignored',
      )
    }
  }

  const intents = intentsOf(frame, layout)
  const restoreSelection = deselectTarget(
    frame,
    guard,
    warnings,
  )
  try {
    if (restoreSelection !== undefined) {
      // The deselection has been REQUESTED, not rendered. Applying now would
      // land in the frame that still shows the selection, where the setter is
      // a no-op and the read-back lies about it. This await is the fix; it is
      // the ONLY thing separating round 4 from three rounds that reported
      // success on a write that never happened.
      await (guard?.wait ?? defaultWait)(SETTLE_DELAY_MS)
    }
    writeAndVerify(frame, intents, warnings)
  } finally {
    // The user's selection comes back whatever the write did — but LATER, past
    // this reply, or the UI never notices it went away (see the module header).
    // Fire-and-forget: the handler does not wait for it.
    if (restoreSelection !== undefined) {
      ;(guard?.defer ?? defaultDefer)(restoreSelection)
    }
  }
}
