// enrich-nodes.ts — the fields JSON_REST_V1 cannot carry, for EVERY node a
// read returns complete.
//
// `exportAsync({format:'JSON_REST_V1'})` serializes a whole subtree in one
// call, but REST's node shape is a subset of the Plugin API's: it has no
// `vectorPaths`, no `pointCount`/`innerRadius`, no unrotated `width`/`height`,
// no `strokeJoin`, no per-range text `runs`, no style/variable NAMES. Those
// have always been patched back on afterwards — but only onto the export ROOT,
// so a node read at `depth:0` was complete and the SAME node read as a child at
// `depth:1` was not (B23).
//
// That is a misstatement, not an omission: a mixed-run TEXT child positively
// reported the single font its node-level fields happen to hold, and a VECTOR
// child came back with no geometry at all — so reading a frame at `depth:1` and
// writing it straight back lost the bold and emptied the vector.
//
// The rule this module implements is the one the specs already state: a read
// returns "the node's complete faithful spec at the requested `depth`"
// (tool-surface.md → *Read model*), and wrappers "reach descendants … every
// node it returns complete" (expression-formats.md).
//
// SHAPE — collect then apply, generalised from what `context` alone used to do:
//   1. walk the LIVE subtree, bounded by `depth`, collecting one patch per id;
//   2. resolve the async parts ONCE PER DISTINCT ID (a 97-node subtree has 280
//      bound fields but only 8 distinct tokens — 1 ms batched, 26 ms naive);
//   3. walk the EXPORTED tree and merge each patch in by id.
//
// BOUNDED BY DEPTH (T10): enrichment stops where the read stops. Anything past
// the requested depth collapses to an id-stub server-side, so paying for it
// would buy nothing. `depth: -1` means every level, which is what the caller
// asked for.
//
// PAIRED WITH THE EXPORT, NOT JOINED BY ID (B41). The live walk and the export
// do not always agree on what a node is CALLED: content written into a
// component SLOT keeps its pre-append id, so the walk sees `298:7519` where the
// export says `I298:7517;298:7516;298:7523`, and the walk's descendants carry
// ids composed from the stale one that name no node at all. Keying the patch
// map off the live id and looking it up in the export therefore missed EVERY
// patch for such a subtree — which is B41: `bindingNames` is the only channel
// carrying style/variable NAMES, so a missed patch silently deletes every
// `var()` / `style()` wrapper while the literal value (which rides on the
// export) stays right. The two sides are paired STRUCTURALLY instead — see
// canonical-ids.ts — and the patch is keyed by the id the export gives.
//
// DEGRADES PER NODE (T7): every step of this walk is a property read on a live
// node, and a node can refuse — a handle whose address was composed from a
// stale id throws on EVERY read of it ("The node … with id 'I…;…' does not
// exist"). Unguarded, one such node inside a subtree took the whole read down:
// a 978 KB read-back answered 151 bytes of PLUGIN_ERROR. So each node's
// collection is wrapped on its own — the throw becomes that node's `readError`
// and every other node comes back whole. Never around the map: a guard that
// spans the walk loses the read it was added to save.
//
// Such a node is still not empty: its bound-variable IDS come off the EXPORT
// (`variableIdsInExport`), which is where the read face takes them from anyway,
// so its `var()` names resolve even though its live handle answers nothing. The
// fields only the Plugin API carries — `context`, text runs, vector geometry,
// the unrotated size, `style()` names — stay lost, and the `readError` on that
// node says so rather than letting the gap pass as a clean read.
//
// A MISSING `style()` WRAPPER IS ALWAYS ATTRIBUTABLE (B41). The export carries
// no style id at all — proven live, 2026-07-31 — so the wrapper is a live-only
// field and there is no export half to fall back on the way variables have one.
// Two roads therefore end at a bare literal, and until B41 both were silent:
//
//   no live half   — the walk never reached this node, so it has no throw of
//                    its own to report. `collectOne` declares the export served
//                    it (`slicedReadMessage`).
//   no style NAME  — the node states a styleId and the resolver cannot name it,
//                    so no wrapper can be rendered (`unnamedStyleMessage`).
//                    Only when the resolver EXISTS: a runtime without one (T7)
//                    names no style at all, and a declaration on every styled
//                    node is noise, not attribution.
//
// Neither can be repaired here. Both are declared, because a read that returns
// a bare literal where a style is bound invites a write that DETACHES it, and
// an unstyled node and an unresolvable one must not look alike. Whether a live
// handle answers is session state (resolve-node.ts), which is the whole of
// B41's nondeterminism: the same node read twice was styled and unstyled.
//
// Nodes are seen STRUCTURALLY (`LiveNode`) rather than as `BaseNode` so this is
// testable without a Figma runtime — the same reason `omitMixed` takes
// `figma.mixed` as an argument.

import {
  CONTEXT_NS,
  CONTEXT_KEY,
} from '@figma-agent-bridge/shared'

import { omitMixed } from './mixed'
import {
  capsFromNetwork,
  cornersFromNetwork,
  joinsFromNetwork,
} from './vector-points'
import { segmentsToRuns } from './text-runs'
import {
  pairWithExport,
  variableIdsInExport,
  type LiveNode,
  type NodePair,
  type RawNode,
} from './canonical-ids'
import {
  partialLiveReadMessage,
  slicedReadMessage,
} from './resolve-node'

export type { LiveNode, RawNode }

/** The extra keys merged onto one exported node. */
export type Patch = Record<string, unknown>

/**
 * The two globals this needs, injected.
 *
 * Each resolver is OPTIONAL because both are feature-detected (T7): a Figma
 * runtime without `getStyleByIdAsync` omits that half and the read continues,
 * rather than throwing and losing the node.
 */
export type EnrichDeps = {
  /** `figma.mixed` — a Symbol, so it cannot be imported into a test. */
  mixed: symbol
  getStyleName?: (id: string) => Promise<string | undefined>
  getVariableName?: (
    id: string,
  ) => Promise<string | undefined>
}

/**
 * styleId field → the grammar field name the reader wraps.
 *
 * All FIVE slots Figma has, because a style owns its whole field and a read
 * that omits one reports a styled field as a plain list of literals — writable
 * back, and detaching the style when it is (expression-formats.md).
 */
const STYLE_ID_FIELDS = {
  fillStyleId: 'fill',
  strokeStyleId: 'stroke',
  effectStyleId: 'effect',
  textStyleId: 'text',
  gridStyleId: 'grid',
} as const

/**
 * The LAYOUT fields Figma lets a variable bind, in the Plugin API's own
 * spelling — `node.setBoundVariable(field, variable)` takes exactly these.
 *
 * They are patched across because JSON_REST_V1 does not carry them: a real,
 * live-verified `itemSpacing` binding (gap 4 → 8, the variable's value, and the
 * node indexed by `search match:{variableId}`) read back as a bare `gap: 8`,
 * with no wrapper and nothing to say a binding existed at all (B44). So a
 * read-modify-write silently destroyed it, and spacing tokens were unauditable.
 *
 * `counterAxisSpacing` is bindable in Figma but has no field in the layout
 * struct (the grammar spells one `gap`), so nothing here could carry it.
 */
const LAYOUT_BOUND_FIELDS = [
  'itemSpacing',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'gridRowGap',
  'gridColumnGap',
] as const

/** The four auto-layout size clamps a write sets and a read must return (B54). */
const MIN_MAX_FIELDS = [
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
] as const

/** The node's agent-authored `context`, or undefined when it has none. */
export const readContext = (
  n: LiveNode,
): string | undefined => {
  if (typeof n.getSharedPluginData !== 'function') {
    return undefined
  }
  const read = n.getSharedPluginData as (
    ns: string,
    key: string,
  ) => string
  const v = read.call(n, CONTEXT_NS, CONTEXT_KEY)
  return typeof v === 'string' && v !== '' ? v : undefined
}

/**
 * The four grid-CHILD fields, in the Plugin API's own spelling (I56).
 *
 * The two anchors are READ-ONLY properties; the read face is the only place
 * they can come from, which is why they travel even though no write sets them
 * directly (the write goes through `setGridChildPosition`).
 */
const GRID_CELL_FIELDS = [
  'gridRowAnchorIndex',
  'gridColumnAnchorIndex',
  'gridRowSpan',
  'gridColumnSpan',
  'gridChildHorizontalAlign',
  'gridChildVerticalAlign',
] as const

/**
 * Per-track sizes of a GRID frame, flattened to plain objects (I56).
 *
 * `gridRowSizes` hands back live `GridTrackSize` handles, and a handle cannot
 * cross `postMessage` — the same wall `figma.mixed`'s Symbol hit. What travels
 * is `{type, value}`, which is exactly what the read face renders and what the
 * write face sends back.
 *
 * Gated on `layoutMode === 'GRID'`, not on the property: the Plugin API calls
 * the track arrays "only applicable" to a GRID frame, and reading them off an
 * H-mode frame would put two empty lists on every auto-layout node in a read.
 */
const gridTracksPatch = (
  node: LiveNode,
  patch: Patch,
): void => {
  if (
    node.layoutMode !== 'GRID' ||
    !('gridRowSizes' in node)
  ) {
    return
  }
  const flatten = (raw: unknown): unknown =>
    Array.isArray(raw)
      ? raw.map(track => {
          const t = track as {
            type?: unknown
            value?: unknown
          }
          return typeof t.value === 'number'
            ? { type: t.type, value: t.value }
            : { type: t.type }
        })
      : undefined
  const rows = flatten(node.gridRowSizes)
  if (rows !== undefined) {
    patch.gridRowSizes = rows
  }
  const cols = flatten(node.gridColumnSizes)
  if (cols !== undefined) {
    patch.gridColumnSizes = cols
  }
}

/**
 * A grid child's anchor, spans and in-cell align (I56).
 *
 * Gated on the PARENT, and it has to be. `GridChildrenMixin` sits on
 * `LayoutMixin`, so every scene node in the file answers `gridRowSpan` — a
 * property probe would put a cell on all of them, and the read face would then
 * report a grid position for nodes that are not in a grid.
 */
const gridCellPatch = (
  node: LiveNode,
  patch: Patch,
): void => {
  const parent = node.parent as
    | { layoutMode?: unknown }
    | null
    | undefined
  if (
    typeof parent !== 'object' ||
    parent === null ||
    parent.layoutMode !== 'GRID'
  ) {
    return
  }
  for (const field of GRID_CELL_FIELDS) {
    if (field in node) {
      patch[field] = node[field]
    }
  }
}

const vectorPatch = (
  node: LiveNode,
  patch: Patch,
  mixed: symbol,
): void => {
  if (node.type !== 'VECTOR' || !('vectorPaths' in node)) {
    return
  }
  patch.vectorPaths = node.vectorPaths
  // Per-point detail lives on the NETWORK, which vectorPaths cannot express —
  // without it a hand-drawn shape reads back with sharp corners the file does
  // not have, and an arrow reads back blunt. Only the few properties are sent,
  // sparsely; the network itself is unbounded and stays put (T10).
  if (!('vectorNetwork' in node)) return
  const network = node.vectorNetwork as Parameters<
    typeof cornersFromNetwork
  >[0]
  const corners = cornersFromNetwork(network)
  if (corners !== undefined) {
    patch.vectorCorners = corners
  }
  // The node's own cap/join is `figma.mixed` exactly when the vertices
  // disagree; only a string is a value to compare against.
  const caps = capsFromNetwork(
    network,
    omitMixed(node.strokeCap, mixed) as string | undefined,
  )
  if (caps !== undefined) {
    patch.vectorCaps = caps
  }
  const joins = joinsFromNetwork(
    network,
    omitMixed(node.strokeJoin, mixed) as string | undefined,
  )
  if (joins !== undefined) {
    patch.vectorJoins = joins
  }
}

const runsPatch = (node: LiveNode, patch: Patch): void => {
  // NOT a JSON_REST_V1 field: REST describes mixed text as
  // `characterStyleOverrides` plus a `styleOverrideTable`, an indirection the
  // reader does not speak, so without this the `runs` the write face applies
  // read back as nothing at all — the value lands in the file and is then
  // denied by the very next read.
  //
  // Costs nothing on an ordinary node: `getStyledTextSegments` returns ONE
  // segment for a single-style text and `segmentsToRuns` declines a
  // single-segment list, so a plain read is byte-identical to before.
  if (
    node.type !== 'TEXT' ||
    typeof node.getStyledTextSegments !== 'function'
  ) {
    return
  }
  const read = node.getStyledTextSegments as (
    fields: string[],
  ) => unknown
  const projected = segmentsToRuns(
    read.call(node, [
      'fontName',
      'fontSize',
      'fills',
      'lineHeight',
      'letterSpacing',
    ]),
  )
  if (
    projected === undefined ||
    projected.runs.length === 0
  ) {
    return
  }
  patch.runs = projected.runs
  if (projected.omitted > 0) {
    // The reader turns this into a warning. Truncating a read without saying
    // so is the one thing a bounded read must not do (T10/T7).
    patch.runsOmitted = projected.omitted
  }
}

/**
 * Everything that is a plain property read — no round trips, so it costs the
 * same on a descendant as on the root.
 *
 * EVERY GROUP IS GUARDED ON ITS OWN, and `refused` names the ones that threw
 * (B65). A handle Figma composed from a pre-append id does not refuse
 * uniformly: it answers `id`, `name`, `type` and its size, and throws on
 * `parent`, `children` and `getSharedPluginData` (live, B74/B81/B84). The
 * collection used to run under ONE guard with `getSharedPluginData` first, so
 * the very first read decided the whole node: 580 nodes on the 2026-09-01
 * artifact came back with nothing but a `readError` while their unrotated
 * size, vector geometry and text runs were all still readable.
 *
 * `refused` is a plain accumulator rather than a throw so the caller can name
 * the loss ONCE, against an id the caller can actually use.
 */
export const syncPatch = (
  node: LiveNode,
  mixed: symbol,
  refused: string[] = [],
): Patch => {
  const patch: Patch = {}

  /**
   * One field group, guarded. A refusing member costs its own group and
   * nothing else — never the node.
   */
  const group = (name: string, read: () => void): void => {
    try {
      read()
    } catch {
      refused.push(name)
    }
  }

  group('context', () => {
    const ctx = readContext(node)
    if (ctx !== undefined) {
      patch.context = ctx
    }
  })

  group('vector geometry', () =>
    vectorPatch(node, patch, mixed),
  )
  group('text runs', () => runsPatch(node, patch))

  // width / height — JSON_REST_V1 emits only absoluteBoundingBox, which is the
  // AXIS-ALIGNED bbox (inflated when the node is rotated). node.width/height
  // are always unrotated (B7), so the reader can prefer them.
  group('the unrotated size', () => {
    if ('width' in node) {
      patch.width = node.width
      patch.height = node.height
    }
  })

  group('the stroke detail', () => {
    // strokeJoin / strokeMiterLimit — REST carries strokeCap but NOT these two
    // (live-confirmed absent, 2026-07-31).
    if ('strokeJoin' in node) {
      // A vector whose points carry different joins reports figma.mixed, which
      // is a Symbol and cannot cross the plugin boundary — see mixed.ts.
      // Omitting is the honest answer: mixed is not one value, and the per-point
      // `joins=` list says what each point actually does.
      const join = omitMixed(node.strokeJoin, mixed)
      if (join !== undefined) {
        patch.strokeJoin = join
      }
    }
    if ('strokeMiterLimit' in node) {
      patch.strokeMiterLimit = node.strokeMiterLimit
    }

    // Per-side stroke weights (B27) — only when the four sides DIFFER.
    //
    // A node whose sides differ reports `figma.mixed` for `strokeWeight`, so the
    // uniform field cannot describe it at all: without these four the read of a
    // `stroke([0,0,1,0])` divider says either nothing or the wrong thing, and
    // writing that read back erases the rule. Only frame-like and RECTANGLE
    // nodes carry them (IndividualStrokesMixin), hence the property probe.
    //
    // Uniform sides are deliberately NOT patched: `strokeWeight` already says it,
    // the read face emits the plain number as the canonical form, and four extra
    // numbers on every stroked node in a large read is the T4 cost this module
    // stays clear of. (These are plain numbers — never `figma.mixed` — so no
    // Symbol can reach the wire through them.)
    if ('strokeTopWeight' in node) {
      const sides = [
        node.strokeTopWeight,
        node.strokeRightWeight,
        node.strokeBottomWeight,
        node.strokeLeftWeight,
      ]
      if (
        sides.every(w => typeof w === 'number') &&
        !sides.every(w => w === sides[0])
      ) {
        patch.strokeTopWeight = sides[0]
        patch.strokeRightWeight = sides[1]
        patch.strokeBottomWeight = sides[2]
        patch.strokeLeftWeight = sides[3]
      }
    }
  })

  group('the size clamps', () => {
    // minWidth / maxWidth / minHeight / maxHeight (B54) — the four auto-layout
    // size clamps. `update_node` writes them (code.ts) and the layout obeys them,
    // but no read channel carried them, so a floor could only be proved by its
    // geometric effect. They ride the live patch because the export does not
    // reliably carry them, and the live node is the value the write just set.
    //
    // Only a NUMBER travels. Figma reports an absent clamp as `null`, and four
    // null keys on every frame of a big read buy nothing (T4) — the absence
    // already says "no floor".
    for (const field of MIN_MAX_FIELDS) {
      if (
        field in node &&
        typeof node[field] === 'number'
      ) {
        patch[field] = node[field]
      }
    }
  })

  group('the shape detail', () => {
    // pointCount (POLYGON + STAR) and innerRadius (STAR). Feature-detected by
    // PROPERTY, which is robust to the POLYGON vs REGULAR_POLYGON export-type
    // name difference.
    if ('pointCount' in node) {
      patch.pointCount = node.pointCount
    }
    if ('innerRadius' in node) {
      patch.innerRadius = node.innerRadius
    }

    // isMask / maskType — only when masking, to keep ordinary nodes clean.
    if ('isMask' in node && node.isMask === true) {
      patch.isMask = true
      if ('maskType' in node) {
        patch.maskType = node.maskType
      }
    }
  })

  group('the variable modes', () => {
    // explicitVariableModes (M13) — per-collection mode pins.
    if ('explicitVariableModes' in node) {
      const evm = node.explicitVariableModes
      if (
        typeof evm === 'object' &&
        evm !== null &&
        Object.keys(evm).length > 0
      ) {
        patch.explicitVariableModes = evm
      }
    }
  })

  group('the grid', () => {
    // M12 — GRID layout. REST may not carry these for a GRID-mode frame.
    if ('gridRowCount' in node) {
      patch.gridRowCount = node.gridRowCount
      patch.gridColumnCount = node.gridColumnCount
      patch.gridRowGap = node.gridRowGap
      patch.gridColumnGap = node.gridColumnGap
    }

    // I56 — per-track sizing, and the cell of a grid CHILD.
    gridTracksPatch(node, patch)
    gridCellPatch(node, patch)
  })

  group('the layout bindings', () => {
    // B44 — which VARIABLE each bindable layout field is bound to. Only the ids
    // travel; the reader turns them into the `var()` names it emits, off the same
    // `bindingNames` map every other wrapper resolves through.
    const bound = node.boundVariables as
      | Record<string, { id?: unknown } | undefined>
      | undefined
    if (typeof bound === 'object' && bound !== null) {
      const layoutBound: Record<string, string> = {}
      for (const field of LAYOUT_BOUND_FIELDS) {
        const id = bound[field]?.id
        if (typeof id === 'string') {
          layoutBound[field] = id
        }
      }
      if (Object.keys(layoutBound).length > 0) {
        patch.layoutBoundVariables = layoutBound
      }
    }
  })

  group('the component property references', () => {
    // B3 — componentPropertyReferences: field → canonical component property id,
    // set by update_component's add+targetNodeId binding. Present on component
    // and instance SUBLAYERS, which is precisely where the root-only rule used
    // to lose it.
    if ('componentPropertyReferences' in node) {
      const refs = node.componentPropertyReferences
      if (
        typeof refs === 'object' &&
        refs !== null &&
        Object.keys(refs).length > 0
      ) {
        patch.componentPropertyReferences = refs
      }
    }
  })

  return patch
}

/** `{gramField: styleId}` for every style this node is actually bound to. */
export const styleIdsOf = (
  node: LiveNode,
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [idField, gramField] of Object.entries(
    STYLE_ID_FIELDS,
  )) {
    if (!(idField in node)) continue
    const styleId = node[idField]
    if (typeof styleId === 'string' && styleId.length > 0) {
      out[gramField] = styleId
    }
  }
  return out
}

/**
 * What a node says when it IS styled and the read cannot name the style (B41).
 *
 * Exported so the message has ONE author, the `exportBudgetMessage` rule.
 *
 * The distinction matters more than it looks. A node with no style and a node
 * whose style could not be named read IDENTICALLY — both come back as a plain
 * list of literals — and writing that list back detaches the style on the
 * second one. So the second one says which fields it could not name.
 */
export const unnamedStyleMessage = (
  fields: readonly string[],
): string =>
  'this node binds a style on ' +
  fields.join(', ') +
  ', and the read could not name it. Those fields come back as plain ' +
  'literals, with no style() wrapper. A write of those literals DETACHES ' +
  'the style.'

/** Every distinct variable id this node binds, on any field. */
export const variableIdsOf = (node: LiveNode): string[] => {
  const bound = node.boundVariables
  if (typeof bound !== 'object' || bound === null) return []
  const ids = new Set<string>()
  const pushAlias = (a: unknown): void => {
    const id = (a as { id?: unknown } | null)?.id
    if (typeof id === 'string') {
      ids.add(id)
    }
  }
  for (const val of Object.values(
    bound as Record<string, unknown>,
  )) {
    if (Array.isArray(val)) {
      for (const a of val) {
        pushAlias(a)
      }
    } else {
      pushAlias(val)
    }
  }
  return [...ids]
}

const mainComponentOf = async (
  node: LiveNode,
): Promise<{ key: string; remote: boolean } | null> => {
  if (
    node.type !== 'INSTANCE' ||
    typeof node.getMainComponentAsync !== 'function'
  ) {
    return null
  }
  const get = node.getMainComponentAsync as () => Promise<{
    key: string
    remote: boolean
  } | null>
  return get.call(node).catch(() => null)
}

/** Resolve each distinct id ONCE, in parallel; unresolvable ids drop out. */
const resolveNames = async (
  ids: Iterable<string>,
  resolve:
    | ((id: string) => Promise<string | undefined>)
    | undefined,
): Promise<Map<string, string>> => {
  const out = new Map<string, string>()
  if (resolve === undefined) return out
  await Promise.all(
    [...new Set(ids)].map(async id => {
      // try/catch, not `.catch()`: a resolver can throw SYNCHRONOUSLY (the
      // Figma call refusing before it ever returns a promise), and there is no
      // promise to attach a handler to when it does. One id that cannot be
      // named loses that name and nothing else.
      let name: string | undefined
      try {
        name = await resolve(id)
      } catch {
        return
      }
      if (name !== undefined) {
        out.set(id, name)
      }
    }),
  )
  return out
}

/** One node's collected state, before the async halves land on it. */
type Pending = {
  /** Absent when only the export describes this node — see collectOne. */
  node: LiveNode | undefined
  id: string
  patch: Patch
  styleIds: Record<string, string>
  variableIds: string[]
}

/**
 * One node's synchronous collection — guarded PER NODE (T7).
 *
 * The guard is here and not around the walk on purpose: `syncPatch`,
 * `styleIdsOf` and `variableIdsOf` are all plain property reads, and a node
 * that no longer resolves throws on every one of them. Wrapping the whole map
 * would trade a lost read for a lost read; wrapping one node costs one node.
 * The failure becomes a field, so the caller learns WHICH node it lost.
 *
 * The bound-variable ids are the UNION of what the live node reports and what
 * the export carries. The export half is not redundant: it is the only half a
 * node with an unusable live handle has, and it is where the read face reads
 * the binding id from anyway — so the names still resolve and the wrapper
 * survives (B41).
 *
 * A node with NO live half is the one case that has no throw to report: the
 * walk stopped above it, so nothing here failed and everything live-only is
 * missing anyway. It says so (B41) — a silent thin row is the outcome this
 * whole module exists to prevent, and `readNodeDocument` already words the
 * identical loss the identical way when a WHOLE read is served from an export.
 */
const collectOne = (
  pair: NodePair,
  id: string,
  mixed: symbol,
): Pending => {
  const exportedIds =
    pair.exported === undefined
      ? []
      : variableIdsInExport(pair.exported)
  const node = pair.live
  if (node === undefined) {
    return {
      node: undefined,
      id,
      patch: { readError: slicedReadMessage(id) },
      styleIds: {},
      variableIds: exportedIds,
    }
  }
  try {
    const refused: string[] = []
    const patch = syncPatch(node, mixed, refused)
    // Both are plain property reads on the same handle, so both refuse the
    // same way — and losing the style ids silently is B41 exactly.
    let styleIds: Record<string, string> = {}
    try {
      styleIds = styleIdsOf(node)
    } catch {
      refused.push('style() names')
    }
    let liveVariableIds: string[] = []
    try {
      liveVariableIds = variableIdsOf(node)
    } catch {
      refused.push('the live variable bindings')
    }
    if (pair.walkError !== undefined) {
      patch.readError = pair.walkError
    } else if (refused.length > 0) {
      // B65 — the loss is stated in OUR words, against the id the read emits.
      // Figma's own message quotes the address it composed off the pre-append
      // id (`I570:22243;570:20740`, exactly two segments), and that address
      // resolves to nothing: 580 rows on the 2026-09-01 artifact carried one,
      // so every id a caller could have acted on was the one id the row did
      // not carry. An id a read mentions has to be an id a read resolves.
      patch.readError = partialLiveReadMessage(id, refused)
    }
    return {
      node,
      id,
      patch,
      styleIds,
      variableIds: [
        ...new Set([...liveVariableIds, ...exportedIds]),
      ],
    }
  } catch (err) {
    // `readError` plus whatever the EXPORT still says: half a patch off a node
    // that cannot be read is worth less than the name of what went wrong, but
    // the export's own bindings are not half — they are complete and correct.
    return {
      node,
      id,
      patch: { readError: String(err) },
      styleIds: {},
      variableIds: exportedIds,
    }
  }
}

/**
 * One patch per node, for every node within `depth` of `root`, keyed by the id
 * `applyPatches` will look it up under.
 *
 * `exported` is the JSON_REST_V1 document the patches are destined for. It is
 * what makes the key CANONICAL: pairing is structural, so a node whose live
 * handle answers a stale id is still keyed by the id the export gives it.
 * Pass `undefined` (or a document that describes something else) and every
 * node simply keys by its own live id — nothing matches, nothing breaks.
 *
 * The async halves — style/variable NAMES and an instance's main component —
 * are resolved across the WHOLE set at once. Names batch by distinct id
 * (the cost tracks how many tokens the document defines, not how big the
 * subtree is); `component.key` cannot batch, because an instance's main must
 * be asked per instance, but at ~0.06 ms each it does not need to.
 */
export const collectPatches = async (
  root: LiveNode,
  exported: RawNode | undefined,
  depth: number,
  deps: EnrichDeps,
): Promise<Map<string, Patch>> => {
  const pending = pairWithExport(root, exported, depth)
    .map(pair => ({ pair, id: pair.id }))
    .filter(
      (p): p is { pair: NodePair; id: string } =>
        p.id !== undefined,
    )
    .map(p => collectOne(p.pair, p.id, deps.mixed))

  const [styleNames, variableNames] = await Promise.all([
    resolveNames(
      pending.flatMap(p => Object.values(p.styleIds)),
      deps.getStyleName,
    ),
    resolveNames(
      pending.flatMap(p => p.variableIds),
      deps.getVariableName,
    ),
  ])

  await Promise.all(
    pending.map(async p => {
      if (p.node === undefined) return
      try {
        const main = await mainComponentOf(p.node)
        if (main !== null && main !== undefined) {
          p.patch.componentKey = main.key
          p.patch.componentRemote = main.remote
        }
      } catch (err) {
        // Same rule as the sync half, and it needs its own guard: reaching
        // `getMainComponentAsync` reads the node, so an unreachable INSTANCE
        // throws here — synchronously, before there is a promise to reject —
        // even when every other node in the read resolved fine.
        if (p.patch.readError === undefined) {
          p.patch.readError = String(err)
        }
      }
    }),
  )

  const out = new Map<string, Patch>()
  for (const p of pending) {
    // T1 (wrapper-names) — the resolved NAMES, so the server can render a
    // bound fill as style(Brand/Primary) and a bound property as var(radius/md)
    // instead of the flattened literal. Only the plugin can turn a Figma id
    // into a name, and a descendant whose style(...) had been flattened looks
    // writable and is not.
    const styles: Record<string, string> = {}
    for (const [gramField, id] of Object.entries(
      p.styleIds,
    )) {
      const name = styleNames.get(id)
      if (name !== undefined) {
        styles[gramField] = name
      }
    }
    // A styleId the resolver could not name (B41). The wrapper cannot be
    // rendered, so the read declares WHICH field lost it rather than emitting
    // a literal that reads as an unstyled node. A failure already named on
    // this node is more specific and is never overwritten.
    //
    // Only when the runtime HAS the resolver. An absent one (T7) names no
    // style anywhere, so the loss is uniform across the read and there is
    // nothing per node to attribute — the flood would drown the real signal,
    // which is one node degrading where its siblings did not.
    const unnamedStyles =
      deps.getStyleName === undefined
        ? []
        : Object.keys(p.styleIds).filter(
            gramField => styles[gramField] === undefined,
          )
    if (
      unnamedStyles.length > 0 &&
      p.patch.readError === undefined
    ) {
      p.patch.readError = unnamedStyleMessage(unnamedStyles)
    }
    const variables: Record<string, string> = {}
    for (const id of p.variableIds) {
      const name = variableNames.get(id)
      if (name !== undefined) {
        variables[id] = name
      }
    }
    const bindingNames: {
      styles?: Record<string, string>
      variables?: Record<string, string>
    } = {}
    if (Object.keys(styles).length > 0) {
      bindingNames.styles = styles
    }
    if (Object.keys(variables).length > 0) {
      bindingNames.variables = variables
    }
    if (Object.keys(bindingNames).length > 0) {
      p.patch.bindingNames = bindingNames
    }
    if (Object.keys(p.patch).length > 0) {
      out.set(p.id, p.patch)
    }
  }
  return out
}

/**
 * Merge the collected patches into the exported JSON_REST_V1 tree, by id.
 *
 * Bounded by the same `depth` the patches were collected at — past it there is
 * nothing to apply, and the exported subtree can be far larger than the read.
 *
 * A FAILURE THAT CANNOT BE MERGED IS STILL REPORTED. The collection keys each
 * patch by the id the EXPORT gives the node, so a patch that finds no home
 * means the two walks disagreed about the SHAPE of the subtree, not about a
 * node's name — rare, and no reason to drop a failure on the floor. Those land
 * on the ROOT as `readErrors` (`"<id the walk saw>: <message>"`). Distinct
 * field, distinct claim: `readError` says THIS node failed, `readErrors` says a
 * node below me failed and I could not tell you which one it is in this tree.
 *
 * Only failures get the fallback. A clean patch that finds no home is dropped
 * as it always has been — it carries nothing the caller needs to act on.
 */
export const applyPatches = (
  doc: Record<string, unknown>,
  patches: Map<string, Patch>,
  depth: number,
): void => {
  const merged = new Set<string>()
  const walk = (
    n: Record<string, unknown>,
    remaining: number,
  ): void => {
    const id = typeof n.id === 'string' ? n.id : undefined
    const patch =
      id !== undefined ? patches.get(id) : undefined
    if (patch !== undefined && id !== undefined) {
      Object.assign(n, patch)
      merged.add(id)
    }
    if (remaining === 0) return
    const next = remaining < 0 ? remaining : remaining - 1
    if (!Array.isArray(n.children)) return
    for (const child of n.children) {
      if (typeof child === 'object' && child !== null) {
        walk(child as Record<string, unknown>, next)
      }
    }
  }
  walk(doc, depth)

  const unattached: string[] = []
  for (const [id, patch] of patches) {
    if (merged.has(id)) continue
    const failure = patch.readError
    if (typeof failure !== 'string') continue
    unattached.push(id + ': ' + failure)
  }
  if (unattached.length > 0) {
    const existing = doc.readErrors
    doc.readErrors = Array.isArray(existing)
      ? [...existing, ...unattached]
      : unattached
  }
}

/**
 * Collect + apply: the whole enrichment pass for one export.
 *
 * `doc` is mutated in place — it is the object the reply is built from, and it
 * is also what the collection pairs the live subtree against, so the patches
 * come back keyed by the ids `doc` actually uses.
 */
export const enrichDocument = async (
  root: LiveNode,
  doc: Record<string, unknown>,
  depth: number,
  deps: EnrichDeps,
): Promise<void> => {
  applyPatches(
    doc,
    await collectPatches(root, doc, depth, deps),
    depth,
  )
}
