// combine-variants.ts — the refusal `combine_variants` owes a caller (I88).
//
// The tool used to answer a COUNT error for a TYPE fault. Live, 2026-09-02:
//
//   combine_variants({componentIds:['571:31758','571:31763'], name:'Control'})
//   → {"error":"Need at least 2 components for combine_variants"}
//
// Exactly two ids were passed. The second was an INSTANCE — mis-mapped out of
// `create_tree`'s positional `ids` array, where an INSTANCE child consumes an
// entry — and the message sent the operator to re-count its array instead of
// checking types. It lost time doing precisely that.
//
// The surface already does this well elsewhere: `create_tree`'s
// UNSUPPORTED_NODE_TYPE names the type it got and every type it takes. So the
// refusal names each id it could not use and WHAT that id actually is.
//
// Pure and structural, so it is testable without a Figma runtime — `code.ts`
// cannot be imported outside Figma.

/** One id `combine_variants` could not use, and what it turned out to be. */
export type RejectedId = {
  id: string
  /** The node's own type, or undefined when the id names nothing. */
  type?: string
}

/** How many rejected ids the message names before it counts the rest (T4). */
const NAMED_IN_REFUSAL = 8

/** One rejected id, in the words the caller needs. */
const describe = (entry: RejectedId): string =>
  entry.type === undefined
    ? entry.id + ' names no node'
    : entry.id + ' is a ' + entry.type + ', not a COMPONENT'

/**
 * Why the call cannot proceed.
 *
 * `kept` is how many real COMPONENTs the ids did resolve to. It stays in the
 * sentence because the count IS the condition — the fault is that the count
 * was the WHOLE sentence, not that it was in it.
 */
export const combineVariantsRefusal = (
  rejected: readonly RejectedId[],
  kept: number,
): string => {
  const head =
    'combine_variants needs at least 2 COMPONENT ids and found ' +
    kept +
    '.'
  if (rejected.length === 0) {
    return (
      head +
      ' Pass the id of each component MASTER — `get_components`, or the' +
      ' reply from `create_component`.'
    )
  }
  const named = rejected
    .slice(0, NAMED_IN_REFUSAL)
    .map(describe)
    .join('; ')
  const rest = rejected.length - NAMED_IN_REFUSAL
  return (
    head +
    ' ' +
    named +
    (rest > 0 ? '; and ' + rest + ' more' : '') +
    '. Pass the id of each component MASTER — `get_components`, or the reply' +
    ' from `create_component`. A `create_tree` `ids` array is positional and' +
    ' every node consumes an entry, so an INSTANCE id is easy to pick up by' +
    ' mistake there.'
  )
}
