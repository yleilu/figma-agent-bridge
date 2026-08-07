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

/** A live Figma node, seen structurally so a test can stand one up. */
export type LiveNode = Record<string, unknown>

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

/** styleId field → the grammar field name the reader wraps. */
const STYLE_ID_FIELDS = {
  fillStyleId: 'fill',
  strokeStyleId: 'stroke',
  effectStyleId: 'effect',
  textStyleId: 'text',
} as const

const childrenOf = (n: LiveNode): LiveNode[] => {
  if (!('children' in n)) return []
  const kids = n.children
  if (kids === null || kids === undefined) return []
  // `Array.from` rather than a cast: it accepts a real array, an array-like
  // and an iterable alike, and yields [] for anything else — this runs inside
  // the export path, where a throw would lose the whole read.
  return Array.from(kids as ArrayLike<LiveNode>)
}

/**
 * Every node from `root` down to `depth`, root first.
 *
 * `depth: 0` is the root alone, `N` is the root plus N levels, `-1` is all of
 * them.
 */
export const nodesWithin = (
  root: LiveNode,
  depth: number,
): LiveNode[] => {
  const out: LiveNode[] = []
  const walk = (n: LiveNode, remaining: number): void => {
    out.push(n)
    if (remaining === 0) return
    const next = remaining < 0 ? remaining : remaining - 1
    for (const child of childrenOf(n)) {
      walk(child, next)
    }
  }
  walk(root, depth)
  return out
}

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
 */
export const syncPatch = (
  node: LiveNode,
  mixed: symbol,
): Patch => {
  const patch: Patch = {}

  const ctx = readContext(node)
  if (ctx !== undefined) {
    patch.context = ctx
  }

  vectorPatch(node, patch, mixed)
  runsPatch(node, patch)

  // width / height — JSON_REST_V1 emits only absoluteBoundingBox, which is the
  // AXIS-ALIGNED bbox (inflated when the node is rotated). node.width/height
  // are always unrotated (B7), so the reader can prefer them.
  if ('width' in node) {
    patch.width = node.width
    patch.height = node.height
  }

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

  // M12 — GRID layout. REST may not carry these for a GRID-mode frame.
  if ('gridRowCount' in node) {
    patch.gridRowCount = node.gridRowCount
    patch.gridColumnCount = node.gridColumnCount
    patch.gridRowGap = node.gridRowGap
    patch.gridColumnGap = node.gridColumnGap
  }

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
      const name = await resolve(id).catch(() => undefined)
      if (name !== undefined) {
        out.set(id, name)
      }
    }),
  )
  return out
}

/**
 * One patch per node id, for every node within `depth` of `root`.
 *
 * The async halves — style/variable NAMES and an instance's main component —
 * are resolved across the WHOLE set at once. Names batch by distinct id
 * (the cost tracks how many tokens the document defines, not how big the
 * subtree is); `component.key` cannot batch, because an instance's main must
 * be asked per instance, but at ~0.06 ms each it does not need to.
 */
export const collectPatches = async (
  root: LiveNode,
  depth: number,
  deps: EnrichDeps,
): Promise<Map<string, Patch>> => {
  const pending = nodesWithin(root, depth)
    .map(node => ({
      node,
      id: typeof node.id === 'string' ? node.id : undefined,
    }))
    .filter(
      (p): p is { node: LiveNode; id: string } =>
        p.id !== undefined,
    )
    .map(p => ({
      ...p,
      patch: syncPatch(p.node, deps.mixed),
      styleIds: styleIdsOf(p.node),
      variableIds: variableIdsOf(p.node),
    }))

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
      const main = await mainComponentOf(p.node)
      if (main !== null && main !== undefined) {
        p.patch.componentKey = main.key
        p.patch.componentRemote = main.remote
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
 */
export const applyPatches = (
  doc: Record<string, unknown>,
  patches: Map<string, Patch>,
  depth: number,
): void => {
  const walk = (
    n: Record<string, unknown>,
    remaining: number,
  ): void => {
    const patch =
      typeof n.id === 'string'
        ? patches.get(n.id)
        : undefined
    if (patch !== undefined) {
      Object.assign(n, patch)
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
}

/**
 * Collect + apply: the whole enrichment pass for one export.
 *
 * `doc` is mutated in place — it is the object the reply is built from.
 */
export const enrichDocument = async (
  root: LiveNode,
  doc: Record<string, unknown>,
  depth: number,
  deps: EnrichDeps,
): Promise<void> => {
  applyPatches(
    doc,
    await collectPatches(root, depth, deps),
    depth,
  )
}
