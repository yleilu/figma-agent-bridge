// reparent-position.ts — where a reparented node has to sit so the canvas does
// not move it (B55).
//
// `appendChild` / `insertChild` keep the child's raw parent-RELATIVE x/y, so a
// node nested at [27, 11.5] inside a frame far out on the canvas reappears at
// [27, 11.5] ABSOLUTE the moment it is moved to the page — on top of whatever
// lives at the origin. code.ts already recomputed x/y across the move, but it
// took the new parent's origin from `absoluteTransform`, and a PageNode has
// none. The branch was therefore skipped exactly when un-nesting to the page,
// which is the common case (componentize-outside, per components.md §1).
//
// An auto-layout parent is the deliberate exception: it OWNS child placement,
// so re-placing the child would fight its own re-flow. That arm was already
// right and stays right.
//
// The module declares the node surface it reads STRUCTURALLY, so it is
// unit-testable without a Figma runtime — the same reason apply-layout.ts does.

/** A page-absolute origin, [x, y]. */
export type Origin = [number, number]

/** The structural subset of a node this module reads. */
export type Placeable = {
  type?: string
  layoutMode?: string
  absoluteTransform?: readonly (readonly number[])[]
}

/**
 * The node's page-absolute origin, or undefined when it cannot be known.
 *
 * `absoluteTransform` is [[a,b,tx],[c,d,ty]]; the translation [tx,ty] is the
 * unrotated node's absolute origin. A PAGE carries no transform because it IS
 * the canvas — its origin is the canvas origin, and treating that absence as
 * "unknown" is what B55 was.
 */
export const originOf = (
  node: Placeable,
): Origin | undefined => {
  const t = node.absoluteTransform
  if (
    Array.isArray(t) &&
    Array.isArray(t[0]) &&
    Array.isArray(t[1]) &&
    typeof t[0][2] === 'number' &&
    typeof t[1][2] === 'number'
  ) {
    return [t[0][2], t[1][2]]
  }
  if (node.type === 'PAGE') {
    return [0, 0]
  }
  return undefined
}

/**
 * Whether this parent places its own children. Auto-layout (and GRID) do; a
 * plain frame, a group and the page do not.
 */
export const parentOwnsPlacement = (
  parent: Placeable,
): boolean =>
  typeof parent.layoutMode === 'string' &&
  parent.layoutMode !== 'NONE'

/**
 * The x/y to write on the child AFTER it has been moved under `parent`, so
 * that its position on the canvas is unchanged. `childOrigin` is the child's
 * absolute origin read BEFORE the move (the move itself does not change it,
 * but the parent-relative x/y it is derived from does).
 *
 * Undefined means "apply nothing": either the parent owns placement, or an
 * origin is unknown and a guess would move the node for no reason.
 */
export const reparentPlacement = (
  childOrigin: Origin | undefined,
  parent: Placeable,
): { x: number; y: number } | undefined => {
  if (parentOwnsPlacement(parent)) {
    return undefined
  }
  const parentOrigin = originOf(parent)
  if (
    childOrigin === undefined ||
    parentOrigin === undefined
  ) {
    return undefined
  }
  return {
    x: childOrigin[0] - parentOrigin[0],
    y: childOrigin[1] - parentOrigin[1],
  }
}
