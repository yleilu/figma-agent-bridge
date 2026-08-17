// canonical-ids.ts — the EXPORT owns identity; the live tree owns the extras.
//
// A node written INTO a component SLOT keeps the id it had before the append.
// Figma does not re-home it, so one node answers two ids at once:
//
//   live (alias)  `298:7519`                     — node.id, on every handle a
//                                                  document walk reaches
//   canonical     `I298:7517;298:7516;298:7523`  — what exportAsync computes by
//                                                  chaining from the outermost
//                                                  INSTANCE
//
// Figma composes an instance sublayer's id as `I<parent.id>;<local>`, so a
// stale parent id mints `I298:7519;298:7510` — an address that names no node.
// Every property read on such a handle throws ("The node … does not exist").
//
// The canonical id is NOT arithmetic on the alias: the chip's canonical last
// segment (`298:7523`) is not its creation id (`298:7519`) — Figma mints a new
// local segment when a node becomes an instance override. Walking the tree to
// look for it fails too, because that walk reads the same stale ids. The export
// is the only oracle, which is why both the read face and search have to hold
// one to be honest about identity.
//
// This module is the seam they share. It is deliberately structural
// (`Record<string, unknown>` on both sides) so it is testable without a Figma
// runtime.

/** A live Figma node, seen structurally so a test can stand one up. */
export type LiveNode = Record<string, unknown>

/** One node of a JSON_REST_V1 export. */
export type RawNode = Record<string, unknown>

/** The id a node answers, or undefined when even that read throws. */
export const idOf = (
  n: Record<string, unknown>,
): string | undefined => {
  try {
    return typeof n.id === 'string' ? n.id : undefined
  } catch {
    // A stale handle answers nothing, its own id included.
    return undefined
  }
}

/**
 * A live node's children, or [] when the node refuses to list them.
 *
 * `onError` is called with the throw; the caller decides whether that is a
 * `readError` on this node or a search warning.
 */
export const liveChildren = (
  n: LiveNode,
  onError?: (err: unknown) => void,
): LiveNode[] => {
  try {
    if (!('children' in n)) return []
    const kids = n.children
    if (kids === null || kids === undefined) return []
    // `Array.from` rather than a cast: it accepts a real array, an array-like
    // and an iterable alike, and yields [] for anything else.
    return Array.from(kids as ArrayLike<LiveNode>)
  } catch (err) {
    // The shape was never the danger — the ACCESS is. A node that no longer
    // resolves throws on every property read, `children` among them.
    onError?.(err)
    return []
  }
}

/** An exported node's children (JSON_REST_V1 carries them as a plain array). */
export const exportedChildren = (n: RawNode): RawNode[] =>
  Array.isArray(n.children)
    ? (n.children as unknown[]).filter(
        (c): c is RawNode =>
          typeof c === 'object' && c !== null,
      )
    : []

/**
 * Every exported node from `root` down to `depth`, root first.
 *
 * `0` is the root alone, `N` the root plus N levels, `-1` every level — the
 * same depth vocabulary the live walk uses.
 */
export const exportedWithin = (
  root: RawNode,
  depth: number,
): RawNode[] => {
  const out: RawNode[] = []
  const walk = (n: RawNode, remaining: number): void => {
    out.push(n)
    if (remaining === 0) return
    const next = remaining < 0 ? remaining : remaining - 1
    for (const child of exportedChildren(n)) {
      walk(child, next)
    }
  }
  walk(root, depth)
  return out
}

/**
 * One node seen from both sides.
 *
 * Either half can be missing: an exported node whose live handle is a fabricated
 * alias address has no readable `live`, and a live node the export does not
 * describe (a caller that passed no export, or a shape disagreement) has no
 * `exported`. `id` is the id the caller should key by — the CANONICAL one
 * whenever the export supplies it.
 */
export type NodePair = {
  id: string | undefined
  live?: LiveNode
  exported?: RawNode
  /** The throw from listing this node's live children, if it refused. */
  walkError?: string
}

/**
 * Pair a live subtree with its export, root first, bounded by `depth`.
 *
 * An OUTER join: every node on either side comes back exactly once. Children
 * are paired BY POSITION when the two sides agree on how many there are —
 * which is the whole point, since the ids disagree precisely when the pairing
 * matters. When the counts differ (one side refused to list, or the shapes
 * genuinely diverge) it falls back to matching by id and emits the leftovers
 * on their own; positional guessing across a shape mismatch would merge one
 * node's geometry onto another, which is worse than losing it.
 *
 * Passing an `exported` root that does not describe `live` (e.g. `{}`) is
 * therefore not an error: nothing matches, and every live node comes back
 * keyed by its own id — exactly the behaviour of a walk with no export at all.
 */
export const pairWithExport = (
  live: LiveNode | undefined,
  exported: RawNode | undefined,
  depth: number,
): NodePair[] => {
  const out: NodePair[] = []

  const pairChildren = (
    liveKids: LiveNode[],
    exportedKids: RawNode[],
  ): [LiveNode | undefined, RawNode | undefined][] => {
    if (liveKids.length === exportedKids.length) {
      return exportedKids.map((e, i) => [liveKids[i], e])
    }
    // Shape mismatch — match what can be matched by id, keep the rest.
    // Indexed once: `idOf` is a property read on a LIVE node, so a linear
    // search per exported child would cost n² of them on a wide frame.
    const byId = new Map<string, LiveNode[]>()
    for (const l of liveKids) {
      const id = idOf(l)
      if (id === undefined) continue
      const bucket = byId.get(id)
      if (bucket === undefined) {
        byId.set(id, [l])
      } else {
        bucket.push(l)
      }
    }
    const taken = new Set<LiveNode>()
    const pairs: [
      LiveNode | undefined,
      RawNode | undefined,
    ][] = exportedKids.map(e => {
      const id = idOf(e)
      const hit =
        id === undefined ? undefined : byId.get(id)?.shift()
      if (hit !== undefined) {
        taken.add(hit)
      }
      return [hit, e]
    })
    for (const l of liveKids) {
      if (!taken.has(l)) {
        pairs.push([l, undefined])
      }
    }
    return pairs
  }

  const walk = (
    l: LiveNode | undefined,
    e: RawNode | undefined,
    remaining: number,
  ): void => {
    let walkError: string | undefined
    const liveKids =
      l === undefined
        ? []
        : liveChildren(l, err => {
            walkError = String(err)
          })
    out.push({
      id:
        (e !== undefined ? idOf(e) : undefined) ??
        (l !== undefined ? idOf(l) : undefined),
      ...(l !== undefined ? { live: l } : {}),
      ...(e !== undefined ? { exported: e } : {}),
      ...(walkError !== undefined ? { walkError } : {}),
    })
    if (remaining === 0) return
    const next = remaining < 0 ? remaining : remaining - 1
    const exportedKids =
      e === undefined ? [] : exportedChildren(e)
    for (const [lk, ek] of pairChildren(
      liveKids,
      exportedKids,
    )) {
      walk(lk, ek, next)
    }
  }

  walk(live, exported, depth)
  return out
}

/**
 * One paired subtree, keyed the way a CALLER addresses it.
 *
 * A read emits the id the EXPORT gives each node, so that is the only id an
 * agent can hand back. `live` answers "which handle does that id name" and
 * `exported` answers "what does the file say about it" — the two halves a
 * direct read of that id needs.
 *
 * `exported` holds a node even where `live` does not. Content inside a
 * slot-hosted INSTANCE has a handle Figma composed from a stale parent id, and
 * that handle throws on every property read, so a read of such an id can only
 * be served from the export.
 */
export type IdentityIndex = {
  /** canonical id → the live handle the pairing put opposite it. */
  live: Map<string, LiveNode>
  /** canonical id → the exported node. */
  exported: Map<string, RawNode>
}

/**
 * Index a live subtree and its export by the id the export gives each node.
 *
 * The FIRST pair wins on a repeated id. `pairWithExport` is pre-order, so that
 * is the shallowest node, which is the one a caller means.
 */
export const indexByCanonicalId = (
  live: LiveNode | undefined,
  exported: RawNode | undefined,
  depth = -1,
): IdentityIndex => {
  const index: IdentityIndex = {
    live: new Map(),
    exported: new Map(),
  }
  for (const pair of pairWithExport(live, exported, depth)) {
    const { id } = pair
    if (id === undefined) continue
    if (pair.live !== undefined && !index.live.has(id)) {
      index.live.set(id, pair.live)
    }
    if (
      pair.exported !== undefined &&
      !index.exported.has(id)
    ) {
      index.exported.set(id, pair.exported)
    }
  }
  return index
}

/**
 * Every bound-variable id an EXPORTED node carries.
 *
 * The read face already takes the binding ID off the export
 * (`raw.boundVariables`, and `boundVariables.color` inside each paint) — only
 * the NAME ever came from the live node. So harvesting ids here is what lets a
 * node whose live handle throws still render `var(<name>)` instead of a bare
 * literal.
 *
 * JSON_REST_V1 nests some of them one level deeper under a REST-specific
 * container (`boundVariables.rectangleCornerRadii.RECTANGLE_TOP_LEFT_…`), so
 * this collects any `{id}` reachable in the object rather than naming fields.
 */
export const variableIdsInExport = (
  n: RawNode,
): string[] => {
  const ids = new Set<string>()
  const harvest = (v: unknown, budget: number): void => {
    if (budget < 0 || v === null || typeof v !== 'object') {
      return
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        harvest(item, budget - 1)
      }
      return
    }
    const obj = v as Record<string, unknown>
    if (typeof obj.id === 'string' && 'type' in obj) {
      // A VariableAlias: {id, type:'VARIABLE_ALIAS'}.
      ids.add(obj.id)
      return
    }
    for (const item of Object.values(obj)) {
      harvest(item, budget - 1)
    }
  }
  // Node-level bindings, and the per-paint `boundVariables.color` on each fill
  // or stroke. Nothing else on a raw node holds a VariableAlias, and walking
  // the whole node would drag in `children`.
  harvest(n.boundVariables, 4)
  for (const field of ['fills', 'strokes'] as const) {
    const paints = n[field]
    if (!Array.isArray(paints)) continue
    for (const p of paints) {
      if (typeof p === 'object' && p !== null) {
        harvest((p as RawNode).boundVariables, 3)
      }
    }
  }
  return [...ids]
}
