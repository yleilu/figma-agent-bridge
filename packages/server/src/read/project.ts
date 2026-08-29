// project.ts — field projection for NodeSpec: named profile sets and
// explicit field allow-lists. Used by the read model to narrow responses
// before returning them to the agent.

import type { NodeSpec } from '@figma-agent-bridge/shared/node-spec'
import type { Profile } from '@figma-agent-bridge/shared/read-model'

/**
 * Named field sets per profile, each narrowing to one concern.
 *
 * `full` is NOT consulted — `projectNode` short-circuits it to identity, so
 * every NodeSpec field survives including ones added later. Its entry exists
 * only because `Record<Profile, …>` requires a key per profile; do not treat
 * the list below as full's definition. It was one once, and quietly fell eight
 * fields behind NodeSpec.
 */
export const PROFILES: Record<
  Profile,
  readonly (keyof NodeSpec)[]
> = {
  minimal: ['type', 'name', 'id'],
  layout: [
    'type',
    'name',
    'id',
    'size',
    'position',
    'layout',
    // A grid child's `cell` is its position. Without it the layout profile
    // would report a grid's children by the pixel x/y the grid computed, which
    // says nothing about which cell each one holds (I56).
    'cell',
    'sizing',
    'constraints',
    'layoutPositioning',
  ],
  style: [
    'type',
    'name',
    'id',
    'fills',
    'strokes',
    'stroke',
    'effects',
    'radius',
    'opacity',
    'blend',
  ],
  text: ['type', 'name', 'id', 'text'],
  full: [
    'type',
    'name',
    'id',
    'size',
    'position',
    'layoutPositioning',
    'layout',
    'sizing',
    'constraints',
    'minWidth',
    'maxWidth',
    'minHeight',
    'maxHeight',
    'fills',
    'strokes',
    'stroke',
    'effects',
    'radius',
    'opacity',
    'rotation',
    'blend',
    'visible',
    'clipsContent',
    'grids',
    'text',
    'exportSettings',
    'componentProperties',
    'variantProperties',
    'overrides',
    'context',
    'children',
  ],
}

/**
 * Project a NodeSpec to a subset of its fields.
 *
 * Precedence:
 *   non-empty fields > profile > identity (return node unchanged)
 * An empty `fields` array is ignored (falls through to profile/identity).
 *
 * Unknown field names in `fields` are silently ignored (no throw).
 * Returns the node unchanged (same reference) when no selector is given.
 *
 * `readError`/`readErrors` survive every selector — see the note at the end of
 * the body.
 */
export const projectNode = (
  n: NodeSpec,
  sel?: { fields?: string[]; profile?: Profile },
): Partial<NodeSpec> => {
  if (!sel) {
    return n
  }

  // `full` means EVERY field, so it is identity — not a list. Enumerating it
  // is what made it wrong: the list fell behind NodeSpec and silently dropped
  // eight fields, `component` among them, which is the INSTANCE round-trip
  // anchor. A list that must name every key is a list that will drift, so the
  // profile that means "no narrowing" must not be one.
  // `fields` still wins when both are given, so this only fires when `fields`
  // selects nothing (absent, or the empty array the guard below also ignores).
  if (sel.profile === 'full' && !sel.fields?.length) {
    return n
  }

  // An empty `fields` array is not a meaningful projection (it would select
  // nothing). Guard with `.length` so it falls through to the profile, then
  // to identity — rather than returning `{}`.
  const keys: readonly string[] | undefined = sel.fields
    ?.length
    ? sel.fields
    : sel.profile !== undefined
      ? PROFILES[sel.profile]
      : undefined

  // Catch the no-selection case AND an unknown profile (B4): PROFILES[bogus]
  // is `undefined`, not `null`, so the old `=== null` guard missed it and a
  // non-SDK caller with an out-of-enum profile hit "undefined is not an object"
  // in the loop below. `!keys` returns the node unchanged instead of throwing.
  if (!keys) {
    return n
  }

  const result: Partial<NodeSpec> = {}
  for (const k of keys) {
    if (k in n) {
      ;(result as Record<string, unknown>)[k] = (
        n as Record<string, unknown>
      )[k]
    }
  }
  // `readError`/`readErrors` are OUTSIDE projection, like `contextSummary`:
  // they do not say what the node IS, they say a node could not be read. A
  // profile that hides them hands back a node that merely looks thin, which is
  // the failure the fields exist to prevent (T7) — and no `fields` list can
  // ask for them, because the caller cannot know in advance which node will be
  // unreachable. Exempted HERE rather than at each caller (the way
  // `contextSummary` is) because these are pass-through fields, not ones
  // derived after the fact: one clause covers inspect, get_node, get_nodes and
  // search alike.
  if (n.readError !== undefined) {
    result.readError = n.readError
  }
  if (n.readErrors !== undefined) {
    result.readErrors = n.readErrors
  }
  return result
}
