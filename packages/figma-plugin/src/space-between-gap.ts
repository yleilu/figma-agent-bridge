// space-between-gap.ts — the half of the SPACE_BETWEEN/bound-gap refusal that
// needs the LIVE node (B58).
//
// The mechanism, and why the pair is refused at all, is in
// `@figma-agent-bridge/shared/space-between-guard` — one message, shared, so
// the two sides cannot drift.
//
// The server refuses the pair when ONE write carries both halves, which it can
// see from the spec alone. What it cannot see is a write that brings one half
// onto a node that already holds the other:
//
//   • `update_node {layout:{align:['SPACE_BETWEEN',…]}}` on a bar whose gap is
//     already bound to a token — the exact shape that produced B58, since the
//     operator's original create_tree set both and later edits touched one.
//   • `update_node {layout:{gap:'var(space/16)16'}}` on a bar already set to
//     SPACE_BETWEEN.
//   • `bind_variable {field:'itemSpacing'}` on a SPACE_BETWEEN node — the same
//     pair by the other door, with no layout write involved at all.
//
// The plugin has the node in hand, so this costs no extra round trip.
//
// Structural on both sides, so it is testable without a Figma runtime.

import {
  GAP_BIND_FIELD,
  SPACE_BETWEEN,
  spaceBetweenGapConflict,
} from '@figma-agent-bridge/shared'

/** As much of a live frame as this check reads. */
export type GapConflictNode = {
  id?: unknown
  primaryAxisAlignItems?: unknown
  boundVariables?: unknown
}

/** The converted layout the plugin receives, as much of it as matters here. */
export type IncomingLayout = {
  align?: unknown
}

/** One `bindings[]` entry of a converted write. */
export type IncomingBinding = {
  kind?: unknown
  field?: unknown
}

/** Whether the node's gap is bound to a variable right now. */
export const gapIsBound = (
  node: GapConflictNode,
): boolean => {
  try {
    const bound = node.boundVariables as
      | Record<string, unknown>
      | null
      | undefined
    return (
      bound !== null &&
      bound !== undefined &&
      bound[GAP_BIND_FIELD] !== undefined &&
      bound[GAP_BIND_FIELD] !== null
    )
  } catch {
    // A node that will not answer cannot be shown to conflict.
    return false
  }
}

/** Whether the node's primary axis is SPACE_BETWEEN right now. */
export const alignIsSpaceBetween = (
  node: GapConflictNode,
): boolean => {
  try {
    return node.primaryAxisAlignItems === SPACE_BETWEEN
  } catch {
    return false
  }
}

const nodeLabel = (
  node: GapConflictNode,
): string | undefined => {
  try {
    return typeof node.id === 'string' ? node.id : undefined
  } catch {
    return undefined
  }
}

/**
 * The refusal for an `update_node` layout write that would complete the pair,
 * or undefined when it would not.
 *
 * `incoming` is the CONVERTED layout (`align` already a tuple) and `bindings`
 * the converted binding intents — so "this write binds the gap" is read off the
 * same payload the applier will act on, never guessed from the atom text.
 */
export const updateLayoutConflict = (
  node: GapConflictNode,
  incoming: IncomingLayout | undefined,
  bindings: readonly IncomingBinding[] | undefined,
): string | undefined => {
  const align = Array.isArray(incoming?.align)
    ? (incoming.align as unknown[])[0]
    : undefined
  const bringsAlign = align === SPACE_BETWEEN
  const bringsBoundGap = (bindings ?? []).some(
    b => b?.kind === 'var' && b?.field === GAP_BIND_FIELD,
  )
  // A write that states a NON-space-between align is resolving the conflict,
  // not creating one — it must be allowed through even onto a bound gap.
  const alignStated = align !== undefined
  const where = nodeLabel(node)

  if (bringsAlign && bringsBoundGap) {
    // The server already refuses this shape; kept so the plugin is safe on its
    // own terms, whatever reaches it.
    return spaceBetweenGapConflict({
      where,
      arrivingHalf: 'both',
    })
  }
  if (bringsAlign && gapIsBound(node)) {
    return spaceBetweenGapConflict({
      where,
      arrivingHalf: 'align',
    })
  }
  if (
    bringsBoundGap &&
    !alignStated &&
    alignIsSpaceBetween(node)
  ) {
    return spaceBetweenGapConflict({
      where,
      arrivingHalf: 'gap',
    })
  }
  return undefined
}

/**
 * The refusal for a `bind_variable` that would bind the gap of a
 * SPACE_BETWEEN node, or undefined when it would not.
 */
export const bindFieldConflict = (
  node: GapConflictNode,
  field: unknown,
): string | undefined =>
  field === GAP_BIND_FIELD && alignIsSpaceBetween(node)
    ? spaceBetweenGapConflict({
        where: nodeLabel(node),
        arrivingHalf: 'gap',
      })
    : undefined
