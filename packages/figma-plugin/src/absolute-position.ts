// absolute-position.ts — an ABSOLUTE child lands where the spec said, not
// where a size the caller never saw put it (B87).
//
// THE LIVE FAILURE (2026-09-01). One `create_tree`: an H auto-layout COMPONENT
// with `sizing:['HUG','HUG']` holding a 2×20 accent bar at
// `layoutPositioning:'ABSOLUTE'`, `position:[0,10]`, `constraints:['MIN',
// 'CENTER']`. The bar read back at local **[0,-20]** — rendered twenty pixels
// ABOVE the row, outside its parent — with `warnings: []`.
//
// The arithmetic, and it is Figma's, correctly applied to the wrong box:
//
//   the frame is born 100 tall           parent centre 50
//   the bar sits at y 10..30             bar centre 20, i.e. 30 ABOVE centre
//   the parent then HUGs to 40           parent centre 20
//   CENTER preserves "30 above centre"   bar centre 20 - 30 = -10
//   the bar is 20 tall                   y = -10 - 10 = -20
//
// The tree path defers a parent's FILL/HUG resize until its children are in
// place (B60), so the child's position is applied against a PROVISIONAL box and
// the parent's collapse then re-maps it through the child's own constraints.
// The same value through `update_node` after the parent settled lands
// correctly, so the field works — only the create-time ordering was wrong.
//
// The remedy is the one the surface already uses twice: re-apply the stated
// value after the thing that moved it. `applyPostAppendProperties` re-applies
// x/y after auto-layout overwrites them, and `applyVectorPaths` re-applies the
// stated position after Figma's path rebase walks the node (B79). This is the
// third of the same shape, and it runs after the deferred resize.
//
// Structural (`Record<string, unknown>`), so it is testable without a Figma
// runtime.

/** A child the tree created, with the spec that asked for it. */
export type PlacedChild = {
  node: Record<string, unknown>
  spec: Record<string, unknown>
}

/** The stated `[x, y]` of an ABSOLUTE child, or undefined for anything else. */
const absolutePositionOf = (
  spec: Record<string, unknown>,
): [number, number] | undefined => {
  if (spec.layoutPositioning !== 'ABSOLUTE')
    return undefined
  const position = spec.position
  if (!Array.isArray(position)) return undefined
  const [x, y] = position as unknown[]
  return typeof x === 'number' && typeof y === 'number'
    ? [x, y]
    : undefined
}

/**
 * Put every ABSOLUTE child back where its spec asked, and answer which ones
 * had moved.
 *
 * Only a child that actually DRIFTED is written: an untouched node must not be
 * re-assigned, because assignment is where this campaign's surprises live
 * (B68's opacity reset, B79's path walk, B69's FIXED freeze).
 *
 * A refusal is named rather than thrown. The node exists and the tree is
 * built; losing the whole create over one position would be a worse answer
 * than a placed node with a line about it.
 */
export const restoreAbsolutePositions = (
  children: readonly PlacedChild[],
  warnings?: string[],
): string[] => {
  const moved: string[] = []
  for (const { node, spec } of children) {
    const stated = absolutePositionOf(spec)
    if (stated === undefined) continue
    const [x, y] = stated
    try {
      if (node.x === x && node.y === y) continue
      node.x = x
      node.y = y
      moved.push(String(node.id))
    } catch (err) {
      warnings?.push(
        'position [' +
          x +
          ', ' +
          y +
          '] could not be restored on the ABSOLUTE child ' +
          String(node.id) +
          ' after its parent resized: ' +
          (err instanceof Error
            ? err.message
            : String(err)),
      )
    }
  }
  return moved
}
