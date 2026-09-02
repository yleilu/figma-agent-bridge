// slot-placeholder.ts — an EMPTY slot occupies no layout space (B92).
//
// `component.createSlot()` hands back a slot that is already 100×100 and FIXED
// on both axes. That is Figma's own birth size, not anything an author asked
// for, and it is inside an auto-layout master, so it CONSUMES that space:
//
//   26 empty SLOTs measured on the 2026-09-02b dashboard — every one 100px
//   tall, 20 of them at exactly [100,100]. Never a floor value.
//   14 `Chart card` headers on delivered screens inflated ~72px, so two cards
//   in one row showed visibly misaligned titles.
//   the `Top bar` COMPONENT master (1200×64) held its empty `Trailing` slot at
//   pos [1076,-18.5] size [100,100] — overflowing its own FIXED-64 box by
//   18.5px top and bottom, into two neighbouring catalogue frames.
//
// Re-measured 2026-09-03 with the same answer and more of it: 22 of 26 slots at
// the placeholder, SIX masters overflowing their own box (`Control/Overflow
// menu` +108, `KPI card` +51, `Table header` +30.5, `Table row` +28.5,
// `Activity item` +28, `Top bar` +18.5 again), and 16 further masters whose
// PUBLISHED resting height reads exactly 100 — so `get_components` and
// `get_node` report a tool artifact as those masters' geometry, and any future
// geometry gate reads it as authored.
//
// The author cannot avoid the shape: the design brief REQUIRES those slots. So
// the size has to stop being the plugin's.
//
// HUG ALONE DOES NOT DO IT, and the live run proved that against this module's
// first version. FIGMA KEEPS AN EMPTY AUTO-LAYOUT FRAME AT THE BOX IT ALREADY
// HAS: there is no content to hug to, so the current size stands.
// `update_component({slots:[{name:'Trailing'}]})` on a V master 240 wide left
// `Trailing` reading `sizing HUG,HUG` and `size [100,100]`, and the master grew
// 120 → 188 regardless. The sizing was set and nothing moved.
//
// SO THE ORDER IS THE FIX, and it is the remedy proven by hand on that same
// master: write a TINY RESTING BOX first — `size [0.01,0.01]`, which pins the
// slot FIXED and took the master to 88.01 — and write `sizing HUG,HUG` SECOND,
// where it wins over the pin. With a 120×32 filler appended the slot then read
// `[120,32] HUG,HUG` and the master read 120. Written the other way round, the
// resize pins FIXED over the hug and the whole thing is lost.
//
// 0.01 rather than 0, because 0.01 is Figma's own floor for a frame dimension.
// It is a RESTING box and not a collapse: the slot grows to its content the
// moment content arrives, which is the only resting size a slot can honestly
// have.
//
// ONLY INTO A SILENCE. An entry that states a `size` or a `sizing` is an author
// asking for a box, and gets one; this fills the case where nobody asked, which
// is where Figma's 100 was answering for everyone. Same rule as every other
// creation default on this surface (tool-surface.md §Creation default).
//
// This corrects F27 as well, and for the opposite reason to the one F27 gives:
// F27's exclusion rule for the master-integrity clause is right, but its stated
// premise — that empty slots read at Figma's floor, 0.01/1px — is wrong in
// detail. They read 100.
//
// Structural (`Record<string, unknown>`), so it is testable without a Figma
// runtime.

/** The box `createSlot()` hands back: Figma's, not the author's. */
export const SLOT_PLACEHOLDER_BOX: readonly [
  number,
  number,
] = [100, 100]

/**
 * The resting box an unstated slot is pinned to before it hugs.
 *
 * Figma's own floor for a frame dimension — a stated 0 is rejected — so it is
 * the smallest box a slot can rest at while it holds nothing.
 */
export const SLOT_RESTING_BOX: [number, number] = [
  0.01, 0.01,
]

/** What an unstated slot is sized by. */
export type HugSizing = ['HUG', 'HUG']

/** The two writes an unstated slot takes, in the order they must be made. */
export type SlotSizePlan = {
  /** Written FIRST. Pins the slot FIXED at a box that costs no layout space. */
  size: [number, number]
  /** Written SECOND, where it wins over the pin the resize just set. */
  sizing: HugSizing
}

/**
 * The size plan for a freshly created SLOT, or undefined to write nothing.
 *
 * TWO writes, and the ORDER is the whole fix — see the note above. A hug on its
 * own leaves an empty slot exactly where Figma put it, which is what the live
 * run read back off the first version of this module.
 *
 * `undefined` for the spec means a BARE NAME — an older server sends one, and
 * the bare string IS `{name}`, so it takes the same default the object form
 * takes. One entry cannot mean two things depending on how it was spelled.
 */
export const emptySlotPlan = (
  spec: Record<string, unknown> | undefined,
): SlotSizePlan | undefined => {
  const plan: SlotSizePlan = {
    size: SLOT_RESTING_BOX,
    sizing: ['HUG', 'HUG'],
  }
  if (spec === undefined) return plan
  if (spec.size !== undefined) return undefined
  if (spec.sizing !== undefined) return undefined
  return plan
}

/** How many slots a declaration names before it counts the rest (T4). */
const NAMED_IN_MESSAGE = 8

/**
 * What the reply says about the slots that took the default.
 *
 * ONE line for the whole call, because N slots taking one default is one fact
 * and not N of them (the I41 noise rule). Declared rather than silent for the
 * reason B86 gives about every other inherited default: the spec table alone
 * has never reached a caller.
 *
 * Exported so the message has ONE author — the `exportBudgetMessage` rule
 * (resolve-node.ts).
 */
export const placeholderHugMessage = (
  names: readonly string[],
): string => {
  const shown = names
    .slice(0, NAMED_IN_MESSAGE)
    .map(n => (n.length > 0 ? n : '(unnamed slot)'))
    .join(', ')
  const rest = names.length - NAMED_IN_MESSAGE
  return (
    'slot sizing: ' +
    shown +
    (rest > 0 ? ' and ' + rest + ' more' : '') +
    ' stated no size, so ' +
    (names.length === 1 ? 'it was' : 'they were') +
    ' given a resting box of ' +
    SLOT_RESTING_BOX[0] +
    ' and then set to HUG: ' +
    (names.length === 1 ? 'it hugs' : 'they hug') +
    ' once filled. Figma creates a slot at ' +
    SLOT_PLACEHOLDER_BOX[0] +
    '×' +
    SLOT_PLACEHOLDER_BOX[1] +
    ' FIXED; an empty one at that size consumes real layout space and can push ' +
    'a master out of its own box, and HUG on its own does not move it — an ' +
    'empty frame has no content to hug to, so it keeps the box it has. State ' +
    'size (or sizing) on the entry to pin a resting box of your own instead.'
  )
}
