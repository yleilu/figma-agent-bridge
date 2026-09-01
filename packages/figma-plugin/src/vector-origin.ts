// vector-origin.ts — assigning `vectorPaths` MOVES the node, and the stated
// position has to be read in the frame that leaves behind (B79).
//
// Figma's `vectorPaths` setter is not a field write. It does three things:
//
//   1. REBASES the path data into the node's own box (the stored data comes
//      back 0-based, whatever was written),
//   2. RESIZES the node to the path bounds — already known, and already
//      handled: `size` is applied after the geometry on both write paths,
//   3. WALKS the node by the path MINIMUM, so the ink stays exactly where the
//      data put it.
//
// Step 3 was invisible. Discriminated live 2026-08-30: a create stating NO
// position, with data `M 60 76 … L 700 185 Z`, landed the node at [60,16] —
// the path's own minimum — and the drawing appeared exactly where the numbers
// said. Figma is compensating for its own rebase, and it is right to.
//
// The tool then wrote the spec's `position` absolutely, AFTER the assignment,
// overwriting that compensation with a number whose meaning the rebase had
// destroyed. The 2026-08-30 chart was authored in plot coordinates with
// `position:[0,0]`; every coordinate came back shifted by (−60,−16) and the
// fill baseline floated 16px above the zero axis, with `warnings: []`. The same
// clobber dragged every S48 icon glyph (`M 4 4 … L 20 20`, 16×16 ink centred in
// a 24-box) to its box corner, off-centre by (−4,−4), through 36 nav instances
// and every button and chip.
//
// THE CONTRACT THIS MODULE IMPLEMENTS. Path data carries its own origin, and
// `position` translates it:
//
//     final = stated + (what Figma moved the node by)
//
// 0-based data offsets by zero, so nothing written that way moves. Data written
// in its parent's coordinates lands where its numbers say, which is what both
// readings of `path()` meant anyway (the spec never stated the frame — that
// sentence is now in expression-formats.md §path()).
//
// The offset is MEASURED, never derived from the data string: the node's own
// x/y before and after the assignment is Figma's answer, and re-deriving the
// path minimum here would be a second implementation of a rule only Figma
// owns. It measures relatively, so the same arithmetic serves `update_node`,
// where the setter walks from wherever the node already stands.
//
// The trap is already handled ten lines away for the ABSOLUTE case (a position
// re-applied after auto-layout clobbers it). This is the same shape.
//
// Structural on the node side (`Partial<{…}>`), so the whole behaviour is
// testable against a fake whose `vectorPaths` setter really does walk — which
// it must be, because a plain-object fake cannot see an assignment's side
// effect (the B68 / GRID re-init / count-write law).

/** As much of a node as reading its origin touches. */
export type OriginNode = Partial<{
  x: unknown
  y: unknown
  /** Read only to word a refusal (I83) — never written. */
  id: unknown
}>

/**
 * What a `vectorPaths` refusal says, and what to do about it (I83).
 *
 * Figma seals vector data inside an INSTANCE: `update_node` on an instance's
 * nested VECTOR sublayer answers *"This property cannot be overridden in an
 * instance: vector-data"*. That refusal is correct and B45 already ruled the
 * degrade correct — what was missing is that the message stopped there, while
 * the guidance pointed the other way (`grammar.md` promised a verbatim
 * round-trip, and a read of that same instance child DOES emit `vectorPaths`).
 * Four KPI sparklines were modelled as one component plus per-instance shape
 * overrides on the strength of it, hit the refusal at content time, and had to
 * be rebuilt as a five-variant set.
 *
 * So the sealed case names the ways through, the way the sealed-instance append
 * refusal does. Keyed on the id's SHAPE rather than on Figma's wording: only a
 * node inside an instance carries a compound id, and matching English would
 * break on the next Figma release.
 */
export const pathRefusalMessage = (
  reason: string,
  nodeId: unknown,
): string => {
  const base = 'vectorPaths rejected by Figma: ' + reason
  const sealed =
    typeof nodeId === 'string' &&
    nodeId.startsWith('I') &&
    nodeId.includes(';')
  return sealed
    ? base +
        '. Vector geometry is SEALED in an instance — Figma allows no ' +
        'vector-data override on an instance or on its nested VECTOR ' +
        'sublayer, however the id is spelled. Three ways through: edit the ' +
        'MASTER’s vector (every instance follows); make the shapes variants ' +
        'of a COMPONENT_SET and swap the variant; or build the vector ' +
        'outside the instance and place it through a SLOT.'
    : base
}

/** As much of a VECTOR as this module writes to. */
export type PathTarget = OriginNode &
  Partial<{
    vectorPaths: unknown
  }>

/** What Figma moved a node by: `[dx, dy]`, in the parent's coordinates. */
export type VectorOffset = [number, number]

/** One path as Figma's own shape takes it — the two keys, and no more. */
export type PathEntry = {
  windingRule: unknown
  data: unknown
}

/**
 * A node's `[x, y]`, or undefined when it will not say.
 *
 * Guarded: this runs on handles that can refuse every property read, and an
 * unreadable origin must come back as UNKNOWN rather than as a fabricated
 * `[0, 0]` — a zero here would be read as "Figma moved nothing" and would
 * reinstate the very clobber this module removes.
 */
export const originOf = (
  node: OriginNode,
): VectorOffset | undefined => {
  try {
    const { x, y } = node
    return typeof x === 'number' && typeof y === 'number'
      ? [x, y]
      : undefined
  } catch {
    return undefined
  }
}

/** What one `vectorPaths` assignment did. */
export type PathAssignment = {
  /** False when Figma refused the data — the network was not rebuilt. */
  applied: boolean
  /** How far Figma walked the node. `[0,0]` when it did not, or would not say. */
  offset: VectorOffset
}

/**
 * Assign `vectorPaths` and report the walk.
 *
 * Only the two keys Figma's own shape has are sent. The per-point radii, caps
 * and joins live on the vector NETWORK and are written afterwards by the
 * caller, because this assignment rebuilds it.
 *
 * A refusal is a DEGRADE, not a throw: the node keeps its old geometry, the
 * caller's warning list carries Figma's own message, and `applied:false` tells
 * the caller not to write the per-point detail onto a network that was never
 * rebuilt.
 */
export const assignVectorPaths = (
  node: PathTarget,
  paths: readonly PathEntry[],
  warnings?: string[],
): PathAssignment => {
  const before = originOf(node)
  try {
    node.vectorPaths = paths.map(
      ({ windingRule, data }) => ({
        windingRule,
        data,
      }),
    )
  } catch (e) {
    // Figma's own message, not a guess at the cause. On a create the data is
    // the only thing that can be wrong, but update_node reaches nodes whose
    // path is read-only, and calling that "invalid path data" would send the
    // agent to fix a string that is already correct.
    warnings?.push(
      pathRefusalMessage(
        String(e),
        (node as { id?: unknown }).id,
      ),
    )
    return { applied: false, offset: [0, 0] }
  }
  const after = originOf(node)
  if (before === undefined || after === undefined) {
    // A node that will not state its own origin cannot be compensated. Zero is
    // the honest answer here and not a guess: with no measurement, the stated
    // position is applied exactly as the caller wrote it — the behaviour before
    // this module existed.
    return { applied: true, offset: [0, 0] }
  }
  return {
    applied: true,
    offset: [after[0] - before[0], after[1] - before[1]],
  }
}

/**
 * The position to write, given what the caller stated and what Figma moved.
 *
 * `undefined` means WRITE NOTHING — either the caller stated no position (and
 * Figma's own walk is already the right answer), or what it stated is not a
 * position at all. A malformed value is passed over rather than repaired: the
 * write face validates the shape, and substituting a number here would hide
 * bad input behind a plausible result.
 */
export const positionOverOffset = (
  stated: unknown,
  offset: VectorOffset,
): VectorOffset | undefined => {
  if (!Array.isArray(stated) || stated.length < 2) {
    return undefined
  }
  const [x, y] = stated as unknown[]
  if (typeof x !== 'number' || typeof y !== 'number') {
    return undefined
  }
  return [x + offset[0], y + offset[1]]
}
