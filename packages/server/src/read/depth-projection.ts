// depth-projection.ts — `depth` must never be silently inert (I64).
//
// `get_node({nodeId, depth:2, profile:'minimal'})` returned the node with no
// `children` key, no warning and no error. The read did descend — the plugin
// enriched two levels and the serializer built the tree — and then the
// projection dropped the one field the whole descent produced. Roughly fifteen
// recordings across four independent runs paid for that, every one of them
// concluding the same thing by hand: `depth` is a no-op under any narrowing
// selector, and nothing says so.
//
// TWO DESIGNS WERE POSSIBLE. Auto-include the children as id-stubs, or refuse
// and name the conflict. THIS SURFACE REFUSES, for three reasons:
//
//   1. `fields` is specified as an EXACT allow-list with no identity floor
//      (tool-surface.md, and the same sentence in tools/search.ts: "Nothing is
//      merged in behind the caller's back"). Injecting a field the caller did
//      not name would make that false on the read face while it stays true on
//      the search face — one vocabulary, two meanings.
//   2. Whether a projection should carry an identity floor at all is an OPEN
//      spec decision (I29, awaiting a ruling). Auto-including `children` would
//      settle half of it as a side effect of a bug fix.
//   3. It is the shape `search` already ships (I58): a field the reader cannot
//      supply is refused before anything is scanned, because a dropped field is
//      indistinguishable from a field the node does not carry.
//
// Enforced in the HANDLERS rather than in the schema, for the reason the search
// field vocabulary is: a `batch` entry and a direct call then face the same
// rule as an MCP call.

import type { Profile } from '@figma-agent-bridge/shared/read-model'
import { PROFILES } from './project'

/** The field a descent produces, and the one a narrow projection drops. */
const CHILDREN = 'children'

/**
 * Does this selector let `children` through?
 *
 * Mirrors `projectNode`'s own precedence exactly — non-empty `fields` beats
 * `profile` beats identity — because a rule that disagreed with the projection
 * it guards would refuse reads that work, or pass reads that do not.
 */
const keepsChildren = (sel: {
  fields?: string[]
  profile?: Profile
}): boolean => {
  if (sel.fields?.length) {
    return sel.fields.includes(CHILDREN)
  }
  if (sel.profile === undefined) {
    return true
  }
  // `full` short-circuits to identity in projectNode, and an out-of-enum
  // profile returns the node unchanged (B4) — both keep every field.
  return (
    sel.profile === 'full' ||
    PROFILES[sel.profile] === undefined
  )
}

/**
 * What a read is told when its `depth` and its projection contradict, or
 * `null` when they do not.
 *
 * A `depth` of 0 (or none) asks for no descent, so there is nothing to lose
 * and nothing to say. Any other value — `N > 0` for N levels, `-1` for every
 * level — asks the read to go down, and a projection without `children` throws
 * that answer away.
 */
export const depthProjectionConflict = (sel: {
  depth?: number
  fields?: string[]
  profile?: Profile
}): string | null => {
  const { depth } = sel
  if (depth === undefined || depth === 0) {
    return null
  }
  if (keepsChildren(sel)) {
    return null
  }
  const asked = sel.fields?.length
    ? `fields [${sel.fields.join(', ')}]`
    : `profile:'${String(sel.profile)}'`
  return (
    `depth:${depth} asks this read to descend, and ${asked} drops the ` +
    '`children` field the descent produces — so the reply would carry no ' +
    'children at all and read as a node that has none. Ask for both or ' +
    "neither: add 'children' to `fields`, or use profile:'full' (or no " +
    'projection) to keep the whole node, or drop `depth` if you meant this ' +
    'one node.'
  )
}
