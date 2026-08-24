// space-between-guard.ts — the one pair the layout surface refuses, and the
// one message it refuses it with (B58).
//
// `align` primary `SPACE_BETWEEN` means "Figma decides the gaps". A `gap` bound
// to a VARIABLE means "the gap is this token". The two cannot both be true, and
// Figma resolves the contradiction in a way nothing on the API side can see:
//
//   - The PLUGIN API stores the pair and the canvas RENDERS it. A bar written
//     this way looked right for days and read back `align: SPACE_BETWEEN` with
//     `gap: "var(space/16)16"`.
//   - The UI PROPERTIES PANEL destroys the SPACE_BETWEEN the moment it engages
//     with the node. Clicking a node that already holds the pair collapses the
//     stored value to MIN; holding a selection while the pair is written
//     defeats the incoming write the same way.
//
// So the document silently disagrees with itself depending on whether a human
// has ever clicked the node. That normalization is undocumented and
// destructive: a FIGMA platform quirk. Accepting the pair in the first place is
// the BRIDGE's gap, and this module is that half of the fix.
//
// A LITERAL gap alongside SPACE_BETWEEN is fine and is NOT refused — Figma
// simply ignores it under space-between, and the pair survives selection. The
// binding is the whole discriminator, proven by a live pair test: two identical
// bars, the literal-gap one survived a click and the var-gap twin collapsed.
//
// WHY REFUSE RATHER THAN AUTO-FIX. Dropping the binding silently would hand
// back a design whose token the caller asked for and did not get, which is the
// no-silent-failure principle the whole surface is built on. The caller states
// which of the two they meant.

/** Figma's primary-axis value that makes the gap automatic. */
export const SPACE_BETWEEN = 'SPACE_BETWEEN'

/** The plugin-side field a `layout.gap` variable binds to. */
export const GAP_BIND_FIELD = 'itemSpacing'

/**
 * What a caller is told when a write would pair SPACE_BETWEEN with a
 * variable-bound gap.
 *
 * `where` names the node when there is one — an update knows its id, a create
 * does not yet exist. `arrivingHalf` says which half this call brought, so an
 * update that only supplies one of them still reads as a coherent explanation
 * rather than an accusation about a field the caller never mentioned.
 */
export const spaceBetweenGapConflict = (detail: {
  where?: string
  arrivingHalf: 'align' | 'gap' | 'both'
}): string => {
  const { where, arrivingHalf } = detail
  const at = where === undefined ? '' : ` on ${where}`
  const brought =
    arrivingHalf === 'both'
      ? 'This call sets both.'
      : arrivingHalf === 'align'
        ? 'This call sets the align; the node already has the bound gap.'
        : 'This call binds the gap; the node already has the align.'
  return (
    `layout: \`align\` primary ${SPACE_BETWEEN} cannot be combined with a ` +
    `variable-bound \`gap\`${at}. ${brought} ${SPACE_BETWEEN} means Figma ` +
    'decides the spacing, so a token bound to the gap contradicts it. Figma ' +
    'stores and renders the pair, but its properties panel silently rewrites ' +
    `the align to MIN the first time anyone clicks the node — the design ` +
    'changes under you with nothing reported. Choose one:\n' +
    '  • keep the token and drop the align (remove `align`, or use MIN/CENTER/MAX)\n' +
    '  • keep SPACE_BETWEEN and write a LITERAL gap (`gap: 16`) — Figma ignores ' +
    'it under space-between, and it survives a click\n' +
    '  • keep SPACE_BETWEEN and drop the gap entirely'
  )
}
