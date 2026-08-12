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
// DEGRADES PER NODE (T7): every step of this walk is a property read on a live
// node, and a node can refuse — one created inside a component SLOT keeps a
// stale handle and then throws on EVERY read of it ("The node … with id 'I…;…'
// does not exist"). Unguarded, one such node inside a subtree took the whole
// read down: a 978 KB read-back answered 151 bytes of PLUGIN_ERROR. So each
// node's collection is wrapped on its own — the throw becomes that node's
// `readError` and every other node comes back whole. Never around the map: a
// guard that spans the walk loses the read it was added to save. And when the
// failing node cannot be found again in the exported tree — same stale id, seen
// from the other side — the failure lands on the ROOT as `readErrors` instead
// of disappearing (see `applyPatches`).
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

const childrenOf = (
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
    // The shape `Array.from` was guarding against was never the danger — the
    // ACCESS is. A node that no longer resolves (the stale handle a slot-child
    // create hands back) throws on every property read, `children` among them,
    // and this runs inside the export path, where a throw loses the whole
    // read. The node stays in the walk and its own patch names the failure, so
    // the subtree missing from here is reported rather than quietly absent.
    onError?.(err)
    return []
  }
}

/**
 * Every node from `root` down to `depth`, root first.
 *
 * `depth: 0` is the root alone, `N` is the root plus N levels, `-1` is all of
 * them.
 *
 * `onError` is called with the node whose children could not be listed; the
 * walk continues past it either way.
 */
export const nodesWithin = (
  root: LiveNode,
  depth: number,
  onError?: (node: LiveNode, err: unknown) => void,
): LiveNode[] => {
  const out: LiveNode[] = []
  const walk = (n: LiveNode, remaining: number): void => {
    out.push(n)
    if (remaining === 0) return
    const next = remaining < 0 ? remaining : remaining - 1
    for (const child of childrenOf(n, err =>
      onError?.(n, err),
    )) {
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

/** The node's id, or undefined when it cannot even be identified. */
const idOf = (n: LiveNode): string | undefined => {
  try {
    return typeof n.id === 'string' ? n.id : undefined
  } catch {
    // A patch is merged BY id, so there is nothing to attach to a node whose
    // id is unreadable — it drops out exactly as an id-less node always has.
    return undefined
  }
}

/** One node's collected state, before the async halves land on it. */
type Pending = {
  node: LiveNode
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
 */
const collectOne = (
  node: LiveNode,
  id: string,
  mixed: symbol,
  walkError: string | undefined,
): Pending => {
  try {
    const patch = syncPatch(node, mixed)
    if (walkError !== undefined) {
      patch.readError = walkError
    }
    return {
      node,
      id,
      patch,
      styleIds: styleIdsOf(node),
      variableIds: variableIdsOf(node),
    }
  } catch (err) {
    // `readError` alone: whatever `syncPatch` had gathered before it threw is
    // not reachable from out here, and half a patch off a node that cannot be
    // read is worth less than the name of what went wrong.
    return {
      node,
      id,
      patch: { readError: String(err) },
      styleIds: {},
      variableIds: [],
    }
  }
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
  // A node whose children could not be listed is still a node in the read; the
  // error is held here and lands on its own patch below, beside whatever of
  // that node WAS readable.
  const walkErrors = new Map<LiveNode, string>()
  const pending = nodesWithin(root, depth, (node, err) => {
    walkErrors.set(node, String(err))
  })
    .map(node => ({ node, id: idOf(node) }))
    .filter(
      (p): p is { node: LiveNode; id: string } =>
        p.id !== undefined,
    )
    .map(p =>
      collectOne(
        p.node,
        p.id,
        deps.mixed,
        walkErrors.get(p.node),
      ),
    )

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
 * A FAILURE THAT CANNOT BE MERGED IS STILL REPORTED. The two sides are keyed by
 * id, and the id the live walk reads is not always the id the export carries:
 * the same slot-nested node that throws on every read also answers the STALE
 * form of its id (`I<creationId>;<child>`) while the export names it by the
 * canonical ancestor chain. The patch then matches nothing, and a silently
 * dropped `readError` is exactly the quiet failure this whole module exists to
 * remove — so unattachable failures are collected onto the ROOT as `readErrors`
 * (`"<id the walk saw>: <message>"`). Distinct field, distinct claim:
 * `readError` says THIS node failed, `readErrors` says a node below me failed
 * and I could not tell you which one it is in this tree.
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
