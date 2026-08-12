// slot-entries.ts — read one `update_component` slot entry (B30).
//
// A slot entry crosses the wire in one of two shapes: the CONVERTED spec
// object the server built on the shared write face, carrying `name` plus the
// Figma-ready fields the ordinary apply pipeline consumes — which is what the
// current server sends for every entry, a bare name included (the bare name IS
// `{name}`, so it is converted like one) — or a bare NAME, still read here
// because the param has always accepted one and an older server sends it.
//
// The branch lives here, free of the figma runtime, because it is the part
// worth testing: `code.ts` cannot be imported outside Figma, and getting the
// name wrong costs the slot its name — the one thing a slot must have.

/** A slot entry as it arrives from the server. */
export type SlotEntry = string | Record<string, unknown>

/**
 * The name to give the slot, and the spec to apply to it (absent for a bare
 * name).
 *
 * A missing / non-string `name` yields `''`, which the caller reads as "leave
 * Figma's own auto-name" rather than assigning a stringified object.
 */
export const readSlotEntry = (
  entry: SlotEntry,
): { name: string; spec?: Record<string, unknown> } => {
  if (typeof entry === 'string') {
    return { name: entry }
  }
  if (entry === null || typeof entry !== 'object') {
    return { name: '' }
  }
  const name = (entry as { name?: unknown }).name
  return {
    name: typeof name === 'string' ? name : '',
    spec: entry,
  }
}
