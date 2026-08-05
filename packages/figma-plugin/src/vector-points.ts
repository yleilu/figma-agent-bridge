// vector-points.ts — the per-point detail of a VECTOR, sparsely.
//
// Figma stores a vector twice: `vectorPaths` (a path string, which is what the
// agent reads) and `vectorNetwork` (vertices, which is where per-point detail
// actually lives). Only the first crosses the wire, so a hand-drawn shape with
// two corners rounded to different radii reads back as four straight segments,
// and a line with an arrowhead on one end reads back blunt — the agent sees a
// shape the file does not have.
//
// This extracts just the properties that cannot be expressed otherwise, keyed
// by vertex index. Verified live that a vertex's index is the order the path
// string visits its points, subpaths included, so the index means the same
// thing on both sides.
//
// SPARSE on purpose: only points that differ from the node-level default
// appear, so a 500-point illustration with three rounded corners costs three
// entries rather than five hundred zeroes (T4, T10). The network itself is
// never sent — it is unbounded, and these few properties are all that cannot
// already be expressed.
//
// Values are the Plugin API's own (`ARROW_LINES`, never REST's `LINE_ARROW`),
// because they are read straight off the network rather than from an export.
//
// Every key is measured against the NODE's value for the same property, not
// against Figma's global default: Figma stamps the node-level value onto each
// vertex rather than leaving it blank, so a literal read would emit a dense
// list on every ordinary stroked vector.

type VertexLike = {
  cornerRadius?: number
  strokeCap?: string
  strokeJoin?: string
}

type NetworkLike = {
  vertices?: readonly VertexLike[]
}

const sparse = <T>(
  network: NetworkLike | undefined | null,
  pick: (v: VertexLike) => T | undefined,
): Record<number, T> | undefined => {
  const vertices = network?.vertices
  if (!Array.isArray(vertices)) {
    return undefined
  }
  const out: Record<number, T> = {}
  vertices.forEach((v, i) => {
    const value = pick(v ?? {})
    if (value !== undefined) {
      out[i] = value
    }
  })
  return Object.keys(out).length > 0 ? out : undefined
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
): Record<number, number> | undefined =>
  sparse(network, v => {
    const r = v.cornerRadius
    const rounded =
      typeof r === 'number' && Number.isFinite(r) && r > 0
    return rounded ? r : undefined
  })

/**
 * Sparse `{vertexIndex: strokeCap}` for the points that DISAGREE with the
 * node's own cap. This is what an arrow needs: a line pointing one way carries
 * a different cap at each end, and the node-level field can hold only one.
 *
 * Comparing against `nodeCap` is the whole job. Figma does not leave a
 * non-overriding vertex blank — it stamps the node's cap onto every one of
 * them (verified live: a node set to ROUND reads back with ROUND on each
 * vertex). Emitting what a vertex literally holds would therefore put a dense
 * `caps=[0:ROUND,1:ROUND,…]` on every ordinary stroked vector, duplicating
 * `stroke(){cap=ROUND}` and costing tokens to say nothing (T4).
 *
 * `nodeCap` is unknown when the node's own value is `figma.mixed` — which
 * happens exactly when the vertices disagree, so falling back to Figma's
 * default of NONE is right: with no node-level value to inherit, every
 * non-NONE point is worth naming.
 */
export const capsFromNetwork = (
  network: NetworkLike | undefined | null,
  nodeCap?: string,
): Record<number, string> | undefined => {
  const inherited = nodeCap ?? 'NONE'
  return sparse(network, v => {
    const cap = v.strokeCap
    const differs =
      typeof cap === 'string' &&
      cap.length > 0 &&
      cap !== inherited
    return differs ? cap : undefined
  })
}

/**
 * Sparse `{vertexIndex: strokeJoin}` for the points that disagree with the
 * node's own join — the same rule, and the same reason, as `capsFromNetwork`:
 * Figma stamps its node-level value onto every vertex, so anything else would
 * put a dense list on every ordinary stroked vector.
 *
 * `nodeJoin` is unknown exactly when the node's value is `figma.mixed`, which
 * is the case this key exists to describe; MITER is Figma's default and the
 * right thing to measure against then.
 */
export const joinsFromNetwork = (
  network: NetworkLike | undefined | null,
  nodeJoin?: string,
): Record<number, string> | undefined => {
  const inherited = nodeJoin ?? 'MITER'
  return sparse(network, v => {
    const join = v.strokeJoin
    const differs =
      typeof join === 'string' &&
      join.length > 0 &&
      join !== inherited
    return differs ? join : undefined
  })
}

/**
 * The write half: a copy of the vertices with per-point detail stamped on.
 *
 * Assigning `vectorPaths` makes Figma rebuild the network from the path data,
 * which is why these cannot be set in the same step — they have to be written
 * back onto the network that assignment produced. This is the pure part of
 * that; the caller does the reading and the `setVectorNetworkAsync`.
 *
 * Vertices are rebuilt rather than mutated because Figma's are readonly, and
 * an index past the end is *reported*, not thrown on: the detail and the path
 * data arrive as one spec an agent wrote, and a stale index should cost that
 * one point rather than the whole node.
 */
export const applyPointDetail = <T extends VertexLike>(
  vertices: readonly T[],
  detail: {
    corners?: Record<number, number>
    caps?: Record<number, string>
    joins?: Record<number, string>
  },
): { vertices: T[]; skipped: number[] } => {
  const { corners = {}, caps = {}, joins = {} } = detail
  const named = [
    ...Object.keys(corners),
    ...Object.keys(caps),
    ...Object.keys(joins),
  ].map(Number)
  return {
    vertices: vertices.map((v, i) => ({
      ...v,
      ...(corners[i] === undefined
        ? {}
        : { cornerRadius: corners[i] }),
      ...(caps[i] === undefined
        ? {}
        : { strokeCap: caps[i] }),
      ...(joins[i] === undefined
        ? {}
        : { strokeJoin: joins[i] }),
    })),
    skipped: [...new Set(named)]
      .filter(i => vertices[i] === undefined)
      .sort((a, b) => a - b),
  }
}
