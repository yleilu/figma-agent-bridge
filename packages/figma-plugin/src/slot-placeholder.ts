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
// the size has to stop being the plugin's. An empty slot hugs — it collapses to
// nothing while it holds nothing, and grows to its content the moment content
// arrives, which is the only resting size a slot can honestly have.
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

/** What an unstated slot is sized by. */
export type HugSizing = ['HUG', 'HUG']

/**
 * The sizing to write on a freshly created SLOT, or undefined to write none.
 *
 * `undefined` for the spec means a BARE NAME — an older server sends one, and
 * the bare string IS `{name}`, so it takes the same default the object form
 * takes. One entry cannot mean two things depending on how it was spelled.
 */
export const emptySlotSizing = (
  spec: Record<string, unknown> | undefined,
): HugSizing | undefined => {
  if (spec === undefined) return ['HUG', 'HUG']
  if (spec.size !== undefined) return undefined
  if (spec.sizing !== undefined) return undefined
  return ['HUG', 'HUG']
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
    (names.length === 1 ? 'it hugs' : 'they hug') +
    ' — Figma creates a slot at ' +
    SLOT_PLACEHOLDER_BOX[0] +
    '×' +
    SLOT_PLACEHOLDER_BOX[1] +
    ' FIXED, and an empty one at that size consumes real layout space and can ' +
    'push a master out of its own box. State size (or sizing) on the entry to ' +
    'pin a resting box instead.'
  )
}
