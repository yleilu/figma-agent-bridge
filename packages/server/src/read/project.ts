// project.ts — field projection for NodeSpec: named profile sets and
// explicit field allow-lists. Used by the read model to narrow responses
// before returning them to the agent.

import type { NodeSpec } from '@figma-agent-bridge/shared/node-spec'
import type { Profile } from '@figma-agent-bridge/shared/read-model'

/**
 * Named field sets per profile. 'full' is treated as an identity projection
 * (all NodeSpec keys). The others narrow to a specific concern.
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
    'cssGrid',
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
    'cssGrid',
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
 */
export const projectNode = (
  n: NodeSpec,
  sel?: { fields?: string[]; profile?: Profile },
): Partial<NodeSpec> => {
  if (!sel) {
    return n
  }

  // An empty `fields` array is not a meaningful projection (it would select
  // nothing). Guard with `.length` so it falls through to the profile, then
  // to identity — rather than returning `{}`.
  const keys: readonly string[] = sel.fields?.length
    ? sel.fields
    : sel.profile !== undefined
      ? PROFILES[sel.profile]
      : null!

  if (keys === null) {
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
  return result
}
