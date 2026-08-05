// vector-corners.ts — the per-point corner radii of a VECTOR, sparsely.
//
// Figma stores a vector twice: `vectorPaths` (a path string, which is what the
// agent reads) and `vectorNetwork` (vertices, which is where a per-point corner
// radius actually lives). Only the first crosses the wire, so a hand-drawn
// shape with two corners rounded to different radii reads back as four straight
// segments — the agent sees a shape the file does not have.
//
// This extracts just the radii, keyed by vertex index. Verified live that a
// vertex's index is the order the path string visits its points, subpaths
// included, so the index means the same thing on both sides.
//
// SPARSE on purpose: only points that are actually rounded appear, so a
// 500-point illustration with three rounded corners costs three entries rather
// than five hundred zeroes (T4, T10). The network itself is never sent — it is
// unbounded, and the radii are all that cannot already be expressed.

type VertexLike = {
  cornerRadius?: number
}

type NetworkLike = {
  vertices?: readonly VertexLike[]
}

/**
 * Sparse `{vertexIndex: radius}` for the points that are rounded, or
 * `undefined` when none are — which is every vector this grammar authors, so
 * an ordinary read carries nothing extra.
 *
 * Tolerant by design: a missing, malformed or empty network yields `undefined`
 * rather than throwing. This runs inside the export path, where a throw would
 * lose the whole read over one odd node.
 */
export const cornersFromNetwork = (
  network: NetworkLike | undefined | null,
): Record<number, number> | undefined => {
  const vertices = network?.vertices
  if (!Array.isArray(vertices)) {
    return undefined
  }
  const out: Record<number, number> = {}
  vertices.forEach((v, i) => {
    const r = v?.cornerRadius
    if (
      typeof r === 'number' &&
      Number.isFinite(r) &&
      r > 0
    ) {
      out[i] = r
    }
  })
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * The write half: a copy of the vertices with `corners` stamped on.
 *
 * Assigning `vectorPaths` makes Figma rebuild the network from the path data,
 * which is why the radii cannot be set in the same step — they have to be
 * written back onto the network that assignment produced. This is the pure
 * part of that; the caller does the reading and the `setVectorNetworkAsync`.
 *
 * Vertices are rebuilt rather than mutated because Figma's are readonly, and
 * an index past the end is *reported*, not thrown on: the radii and the path
 * data arrive as one spec an agent wrote, and a stale index should cost that
 * one corner rather than the whole node.
 */
export const applyCornersToVertices = <
  T extends VertexLike,
>(
  vertices: readonly T[],
  corners: Record<number, number>,
): { vertices: T[]; skipped: number[] } => ({
  vertices: vertices.map((v, i) =>
    corners[i] === undefined
      ? v
      : { ...v, cornerRadius: corners[i] },
  ),
  skipped: Object.keys(corners)
    .map(Number)
    .filter(i => vertices[i] === undefined),
})
