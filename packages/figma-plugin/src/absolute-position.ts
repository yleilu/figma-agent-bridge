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

// ─── THE SECOND DOOR (B87 reopened, 2026-09-03) ────────────────────────────
//
// The create-door fix held: no recurrence through `create_tree`. The naive
// operator hit the same shape through `update_node` instead — an ABSOLUTE child
// of an auto-layout parent, writing `position:[0,0]`, reading back `[0,-40]`;
// writing `[0,40]`, reading back `[0,0]`. A constant offset of exactly one node
// height, deterministic, with `warnings: []`. It cost a real chart defect (the
// treasury `Month ticks` row) and the operator wrote every ABSOLUTE child with
// a compensating height offset for the rest of the build.
//
// SAME FAMILY, DIFFERENT ARITHMETIC, AND THE DIFFERENCE DOES NOT MATTER. The
// create door's cause is known exactly (a provisional box plus a CENTER
// constraint); the update door's is not, and pinning it would mean
// re-implementing a rule only Figma owns. What both doors need is the same
// thing this surface already does for `size` (B46/B67) and for `vectorPaths`
// (B79): write the stated value, READ IT BACK, and either correct by the
// measured drift or say what did not land. A rule re-derived here would break
// on the next Figma release; a measurement cannot.
//
// So the write is PROVEN rather than reasoned about, and the compensation is
// measured relatively — which is exactly the arithmetic that lets one
// implementation serve the create door and the update door alike.

/** As much of a node as proving a position touches. */
export type PositionTarget = Record<string, unknown>

/** A child the tree created, with the spec that asked for it. */
export type PlacedChild = {
  node: Record<string, unknown>
  spec: Record<string, unknown>
}

/** A stated `[x, y]`, or undefined for anything that is not one. */
const statedPair = (
  value: unknown,
): [number, number] | undefined => {
  if (!Array.isArray(value) || value.length < 2) {
    return undefined
  }
  const [x, y] = value as unknown[]
  return typeof x === 'number' && typeof y === 'number'
    ? [x, y]
    : undefined
}

/** A node's `[x, y]`, or undefined when it will not say. */
const positionOf = (
  node: PositionTarget,
): [number, number] | undefined => {
  try {
    const { x, y } = node as { x?: unknown; y?: unknown }
    return typeof x === 'number' && typeof y === 'number'
      ? [x, y]
      : undefined
  } catch {
    return undefined
  }
}

const pair = (p: readonly number[]): string =>
  '[' + p[0] + ', ' + p[1] + ']'

/**
 * What a caller is told when a stated position did not land.
 *
 * Exported so the message has ONE author — the `exportBudgetMessage` rule
 * (resolve-node.ts).
 */
export const positionMismatchWarning = (
  nodeId: unknown,
  stated: readonly number[],
  reads: readonly number[],
): string =>
  'position not applied on ' +
  (typeof nodeId === 'string' ? nodeId : '(unnamed node)') +
  ': asked ' +
  pair(stated) +
  ', reads ' +
  pair(reads) +
  '. Figma re-maps an ABSOLUTE child’s position through its own constraints, ' +
  'against the box the write left behind, and this one did not settle on the ' +
  'stated value even after the offset was compensated. Set constraints:' +
  '[\'MIN\',\'MIN\'] to pin it, or state the position the parent’s final box ' +
  'expects.'

/**
 * Write a stated `[x, y]` and PROVE it, or name what did not land.
 *
 * Three outcomes, and no fourth:
 *
 *   it already reads the stated value  — nothing is written. Assignment is
 *                                        where this campaign's surprises live
 *                                        (B68's opacity reset, B79's path walk,
 *                                        B69's FIXED freeze), so an untouched
 *                                        node stays untouched.
 *   it drifted                         — the drift is MEASURED and written off
 *                                        against a second assignment. One
 *                                        correction, never a chase: a value
 *                                        that will not settle in two writes is
 *                                        a refusal, not an offset.
 *   it will not settle                 — the caller is told, with the ask and
 *                                        the read-back in the sentence.
 *
 * A refusal is named rather than thrown, for the same reason
 * `restoreAbsolutePositions` names one: the node exists and the patch has
 * landed, and losing a whole update over one coordinate is a worse answer than
 * a placed node with a line about it.
 */
export const applyStatedPosition = (
  node: PositionTarget,
  stated: unknown,
  warnings?: string[],
): boolean => {
  const want = statedPair(stated)
  if (want === undefined) return false
  const before = positionOf(node)
  if (
    before !== undefined &&
    before[0] === want[0] &&
    before[1] === want[1]
  ) {
    return false
  }
  const write = (x: number, y: number): boolean => {
    try {
      node.x = x
      node.y = y
      return true
    } catch (err) {
      warnings?.push(
        'position ' +
          pair(want) +
          ' rejected by Figma on ' +
          String(node.id) +
          ': ' +
          (err instanceof Error ? err.message : String(err)),
      )
      return false
    }
  }
  if (!write(want[0], want[1])) return false
  const landed = positionOf(node)
  if (landed === undefined) {
    // A node that will not state its own origin cannot be judged, and an
    // unverifiable outcome is not a failure — it is unverifiable. Saying
    // nothing here is the honest answer: the write was made and nothing
    // contradicts it.
    return true
  }
  if (landed[0] === want[0] && landed[1] === want[1]) {
    return true
  }
  // The drift, measured rather than derived. Written off relatively, so the
  // same arithmetic serves a node standing anywhere.
  if (
    !write(
      want[0] - (landed[0] - want[0]),
      want[1] - (landed[1] - want[1]),
    )
  ) {
    return true
  }
  const settled = positionOf(node)
  if (
    settled === undefined ||
    (settled[0] === want[0] && settled[1] === want[1])
  ) {
    return true
  }
  warnings?.push(
    positionMismatchWarning(node.id, want, landed),
  )
  return true
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
    // ONE author for the behaviour, since B87's second door (below): the create
    // door and the update door prove a stated position exactly the same way, so
    // neither can quietly stop doing it while the other keeps its tests green.
    if (applyStatedPosition(node, stated, warnings)) {
      moved.push(String(node.id))
    }
  }
  return moved
}
