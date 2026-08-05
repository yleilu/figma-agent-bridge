// mixed.ts — keep `figma.mixed` from reaching the wire.
//
// Figma answers a node-level property with `figma.mixed` when the parts of the
// node disagree — a vector whose points carry different stroke joins, a text
// node with two font sizes. That sentinel is a **Symbol**, and every reply
// leaves the plugin through `ui.postMessage`, which structured-clones: a
// symbol throws there ("Cannot unwrap symbol"), the reply never leaves, and
// the caller waits out its whole timeout with nothing to diagnose. One
// unguarded read cost exactly that — a 30-second hang that read as a Figma
// defect until it was traced back here.
//
// So every raw read of a property Figma documents as possibly-mixed goes
// through this. Omitting is the honest answer: mixed is not a value, and the
// per-part detail (`path()`'s `caps=`/`joins=`, a text run) says what each
// part actually does.

/**
 * The property's value, or `undefined` when Figma reports it as mixed.
 *
 * `mixed` is passed in rather than read from the global so this stays a pure
 * function — the plugin runtime is not available to a test, and the rule is
 * worth testing on its own.
 */
export const omitMixed = <T>(
  value: T | symbol,
  mixed: symbol,
): T | undefined =>
  value === mixed ? undefined : (value as T)
