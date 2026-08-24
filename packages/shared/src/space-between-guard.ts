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
 * does not exist yet.
 *
 * THE EXITS DIFFER BY SITUATION, and getting that wrong sends the caller in a
 * circle. Found live: on a node whose gap is ALREADY bound, "write a literal
 * gap" does not resolve anything — a literal write leaves the binding in place
 * (`{gap: 16}` on a bound bar still reads `var(space/16)16`), so the guard
 * refuses the next call too. Only these three situations exist, and each one
 * gets the exits that actually work from where the caller is standing.
 */
export const spaceBetweenGapConflict = (detail: {
  where?: string
  arrivingHalf: 'align' | 'gap' | 'both'
}): string => {
  const { where, arrivingHalf } = detail
  const at = where === undefined ? '' : ` on ${where}`
  const why =
    `${SPACE_BETWEEN} means Figma decides the spacing, so a token bound to the ` +
    'gap contradicts it. Figma stores and renders the pair, but its properties ' +
    'panel silently rewrites the align to MIN the first time anyone clicks the ' +
    'node — the design changes under you with nothing reported.'

  // ONE call carries both halves. Nothing is bound yet, so every exit is a
  // matter of writing this call differently.
  if (arrivingHalf === 'both') {
    return (
      `layout: \`align\` primary ${SPACE_BETWEEN} cannot be combined with a ` +
      `variable-bound \`gap\`${at}. This call sets both. ${why} Choose one:\n` +
      '  • keep the token and drop the align (remove `align`, or use MIN/CENTER/MAX)\n' +
      '  • keep SPACE_BETWEEN and write a LITERAL gap (`gap: 16`) — Figma ignores ' +
      'it under space-between, and it survives a click\n' +
      '  • keep SPACE_BETWEEN and drop the gap entirely'
    )
  }

  // The align is arriving onto a gap that is ALREADY bound. A literal gap will
  // not help: the binding outlives it. The token has to come OFF first.
  if (arrivingHalf === 'align') {
    return (
      `layout: \`align\` primary ${SPACE_BETWEEN} cannot be combined with a ` +
      `variable-bound \`gap\`${at}. This call sets the align; the node's gap is ` +
      `already bound to a variable. ${why} Choose one:\n` +
      '  • keep the token and use a different align (MIN / CENTER / MAX)\n' +
      `  • keep SPACE_BETWEEN and take the token off the gap first: ` +
      `\`bind_variable {nodeId${
        where === undefined ? '' : `: "${where}"`
      }, field: "${GAP_BIND_FIELD}", clear: true}\`, then repeat this call.\n` +
      '    Writing a literal `gap` does NOT remove the binding — the token ' +
      'survives the value, and this refusal would repeat.'
    )
  }

  // A binding is arriving onto a node that is ALREADY space-between. Nothing is
  // bound yet, so there is nothing to clear — the align is what has to move.
  return (
    `layout: a variable-bound \`gap\` cannot be combined with \`align\` primary ` +
    `${SPACE_BETWEEN}${at}. This call binds the gap; the node is already ` +
    `${SPACE_BETWEEN}. ${why} Choose one:\n` +
    '  • keep the align and write the gap as a LITERAL (`gap: 16`, no `var()` ' +
    'wrapper) — Figma ignores it under space-between, and it survives a click\n' +
    '  • keep the token and change the align first (MIN / CENTER / MAX), then ' +
    'bind the gap'
  )
}
