// variable-modes.ts — how a write names a mode (I70).
//
// The write vocabulary is the mode NAME: `valuesByMode:{Light:'#FF0000'}`,
// `aliases:{Light:'VariableID:…'}`. The read used to answer in mode IDs, so a
// read-modify-write cycle needed a hand-built modeId→name join and any payload
// carrying an id was rejected as an "unknown mode".
//
// Both halves are fixed. `get_variables` now emits the NAME (the server's
// renderVariableValues), and every write path resolves a mode reference by
// NAME FIRST, then by ID — so an id from an older read, from Figma's own
// tooling, or from `explicitVariableModes` still lands instead of being
// skipped. The name wins on a collision because it is the documented spelling;
// the id is the fallback, not a rival.
//
// `update_variables`' mode LIFECYCLE (renameModes / removeModes) already
// resolved name-then-id inline. This is that same rule, in one place, for the
// three value paths that did not have it.

/** A collection's mode, as much of one as this lookup reads. */
export type ModeLike = { modeId: string; name: string }

/**
 * The mode id a reference names, or `undefined` when the collection has no
 * such mode.
 *
 * `undefined` is the caller's signal to warn and skip that value (T7) — a
 * value written to a guessed mode would be worse than a value not written.
 */
export const modeIdFor = (
  ref: string,
  modes: readonly ModeLike[],
): string | undefined => {
  const byName = modes.find(m => m.name === ref)
  if (byName !== undefined) {
    return byName.modeId
  }
  return modes.find(m => m.modeId === ref)?.modeId
}
