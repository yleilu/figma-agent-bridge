// search-candidates.ts — search candidates built from an EXPORT rather than
// from live handles (B48).
//
// `search` scans live nodes. That is right until it reaches a subtree whose
// live addresses were composed from a stale id (see canonical-ids.ts): those
// handles throw on `name`, so the nodes were dropped into `warnings[]` and
// never reached `results` — a whole-document sweep quietly degraded to a
// partial one, and the node above them was reported under its alias id.
//
// The recovery is the same oracle the read face uses: export the node the
// failures were reached THROUGH, and read the candidates out of that JSON. The
// export knows the canonical id of every node in the subtree, so the ids come
// back addressable and nothing is missing.
//
// What an export cannot supply is named here rather than guessed:
//   - `context`         — getSharedPluginData is a live-only read
//   - `styleIds`        — JSON_REST_V1 carries no style reference
//   - `componentKey` / `instancesOf` — needs the instance's main, resolved live
// A `match` on one of those still misses these nodes. `characters` and
// `variableIds` DO come through, which is what the copy-inventory and
// design-system sweeps run on.

import {
  exportedWithin,
  variableIdsInExport,
  type RawNode,
} from './canonical-ids'

/** The flat shape the server's matcher and projection consume. */
export type Candidate = Record<string, unknown>

/** What the caller asked the scan to collect per candidate (B3/B4 hints). */
export type CandidateHints = {
  characters?: boolean
  variableIds?: boolean
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined

/**
 * `[width, height]` for an exported node.
 *
 * Same preference order the server's reader applies: the plugin-supplied
 * unrotated size when it is there, else the axis-aligned bounding box. An
 * export that carries neither answers `undefined` rather than `[0, 0]` — a
 * fabricated size is worse than an absent one (B26).
 */
const sizeOf = (
  n: RawNode,
): [number, number] | undefined => {
  if (
    typeof n.width === 'number' &&
    typeof n.height === 'number'
  ) {
    return [n.width, n.height]
  }
  const bbox = n.absoluteBoundingBox as
    | { width?: unknown; height?: unknown }
    | null
    | undefined
  if (
    bbox !== null &&
    bbox !== undefined &&
    typeof bbox.width === 'number' &&
    typeof bbox.height === 'number'
  ) {
    return [bbox.width, bbox.height]
  }
  return undefined
}

/** One exported node as a candidate, or undefined when it has no id. */
export const candidateFromExport = (
  n: RawNode,
  hints: CandidateHints = {},
): Candidate | undefined => {
  const id = str(n.id)
  if (id === undefined) return undefined
  const candidate: Candidate = {
    id,
    name: str(n.name) ?? '',
    type: str(n.type) ?? '',
    size: sizeOf(n),
  }
  if (hints.characters === true && 'characters' in n) {
    candidate.characters = n.characters
  }
  if (hints.variableIds === true) {
    const ids = variableIdsInExport(n)
    if (ids.length > 0) {
      candidate.variableIds = ids
    }
  }
  return candidate
}

/**
 * Every node in an exported subtree as a candidate, root first, bounded by the
 * levels the live scan had left when it reached that root.
 */
export const candidatesFromExport = (
  doc: RawNode,
  depth: number,
  hints: CandidateHints = {},
): Candidate[] => {
  const out: Candidate[] = []
  for (const n of exportedWithin(doc, depth)) {
    const candidate = candidateFromExport(n, hints)
    if (candidate !== undefined) {
      out.push(candidate)
    }
  }
  return out
}
