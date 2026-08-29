import {
  BUILD_ID,
  COMMANDS,
  CONTEXT_NS,
  CONTEXT_KEY,
} from '@figma-agent-bridge/shared'

import {
  applyLayout,
  type AppliedLayout,
} from './apply-layout'
import {
  bindFieldConflict,
  updateLayoutConflict,
  type GapConflictNode,
} from './space-between-gap'
import {
  originOf,
  reparentPlacement,
  type Placeable,
} from './reparent-position'
import {
  instanceSwapKey,
  resolvePropertyKey,
  undeletedMessage,
  unresolvedSwapKeyMessage,
  type PropertyDefs,
} from './component-properties'
import { importComponentByKeyWithDeadline } from './import-by-key'
import { createFontLoader } from './font-cache'
import { applyPointDetail } from './vector-points'
import {
  applyMinMax,
  applySize,
  applySizeVerified,
  applySizing,
  applyStrokeGeometry,
  applyStrokeWeights,
  applyExportSettings,
  applyGrids,
  capabilityWarnings,
  discardedPositionsWarning,
  repinFixedSize,
  verifyCreatedSize,
  type Placement,
  type SizeTarget,
} from './apply-node-fields'
import {
  applyStyleField,
  applyWrapperBindings,
  bindNodeField,
  clearNodeField,
  bindPaintField,
  createBindingLookups,
  STYLE_TYPES,
  type BindTargetNode,
  type StyleCategory,
  type StyleField,
} from './bind-wrappers'
import {
  createShadowWarning,
  otherCollectionsHolding,
  type VariableLike,
} from './variable-shadowing'
import {
  resolveCollectionTarget,
  extendedCollectionWarning,
  duplicateVariableWarning,
  ambiguousCollectionError,
} from './variable-collection-target'
import { resolvePageScope } from './search-page-scope'
import {
  modeIdFor,
  type ModeLike,
} from './variable-modes'
import {
  readSlotEntry,
  slotParentRefusal,
  type SlotEntry,
  type SlotParentNode,
} from './slot-entries'
import {
  fontsToLoad,
  runsToRangeOps,
  type RangeOp,
} from './text-runs'
import {
  enrichDocument,
  readContext as readNodeContext,
  type LiveNode,
} from './enrich-nodes'
import {
  componentSetOf,
  repairScan,
  type ExportedHost,
  type ScanFailure,
} from './search-candidates'
import {
  messageOf,
  scanFrom,
  UNREADABLE_NODE,
} from './search-scan'
import {
  createNodeResolver,
  declareDegradedRead,
  slicedReadMessage,
} from './resolve-node'
import type { RawNode } from './canonical-ids'
import { projectComponentDefs } from './project-component-defs'
import { rollbackCreated } from './rollback'
import { resolveInstanceProps } from './resolve-instance-props'
import {
  isTargetMismatch,
  targetGuardError,
} from './file-channel'
import {
  WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MAX_WINDOW_HEIGHT,
} from './spring-height'
import { homogeneousKind } from './selection-label'
import {
  ACCUM_CAP,
  FEED_FRAMES_PER_SEC,
  FLUSH_DEBOUNCE_MS,
  FLUSH_MAX_WAIT_MS,
  SELECT_IDS_CAP,
  type AttributedRecord,
} from '@figma-agent-bridge/shared/change-feed'
import {
  createWriteScope,
  UNATTRIBUTED,
} from './feed/write-scope'
import { createSelfWriteAttributor } from './feed/self-write-attributor'
import { createAccumulator } from './feed/accumulator'
import { mintFrame } from './feed/mint'
import { createFlusher } from './feed/flusher'

figma.showUI(__html__, {
  width: WINDOW_WIDTH,
  height: MIN_WINDOW_HEIGHT,
  title: 'Agent Bridge',
  themeColors: true,
})

// The file's stable identity. figma.fileKey needs enablePrivatePluginApi
// (manifest) and is undefined for a never-saved file → null. Sent up
// front (best-effort) AND on a get-identity request (the reliable path
// the UI awaits before it derives a channel / registers — fixes the old
// fileName:null register race).
const fileIdentity = () => ({
  type: 'identity' as const,
  fileKey: figma.fileKey ?? null,
  // I62 — the build identity the UI registers with comes from HERE, the
  // bundle that answers every command. Reporting the UI bundle's own stamp
  // would have missed the incident this exists for: the 2026-08-27 QA round
  // had a stale `dist/code.js` beside a fresh `ui.html`, so the half that
  // returned the wrong reads is exactly the half whose id must be published.
  build: BUILD_ID,
  fileName: figma.root.name,
  currentPage: figma.currentPage.name,
  selected: figma.currentPage.selection.length,
  selectedKind: homogeneousKind(
    figma.currentPage.selection,
  ),
})

figma.ui.postMessage(fileIdentity())

// Presence: current page + selection (count and common kind), pushed
// to the UI so the panel can render a selection bar and the relay's
// channel registry can enrich discovery.
// Leading + trailing: the FIRST change of a burst posts immediately,
// so a marquee drag never leaves a stale count on screen; the
// trailing edge settles the final value.
const PRESENCE_DEBOUNCE_MS = 300
let presenceTimer: ReturnType<typeof setTimeout> | undefined
const postPresence = () => {
  figma.ui.postMessage({
    type: 'presence',
    currentPage: figma.currentPage.name,
    selected: figma.currentPage.selection.length,
    selectedKind: homogeneousKind(
      figma.currentPage.selection,
    ),
  })
}
const pushPresence = () => {
  const leading = presenceTimer === undefined
  if (presenceTimer !== undefined) {
    clearTimeout(presenceTimer)
  }
  if (leading) postPresence()
  presenceTimer = setTimeout(() => {
    presenceTimer = undefined
    postPresence()
  }, PRESENCE_DEBOUNCE_MS)
}
figma.on('currentpagechange', pushPresence)
figma.on('selectionchange', pushPresence)

// ── Change Feed (change-feed.md) ────────────────────────────────────────
// The agent's own writes are known HERE, in the command path. The filter is
// source-side because DocumentChange.origin === 'LOCAL' includes them, so a
// downstream consumer could never tell them apart.
//
// Membership is keyed on the COMMAND and OUTLIVES it: every event-causing
// dispatch opens a generation, and the scope retains the most recent
// RETAINED_COMMANDS of them (released wholesale once the agent goes idle for
// RETENTION_CEILING_MS). `documentchange` delivery is batched and unbounded,
// so a rule that expired on a timer failed OPEN — the deferred event landed
// after the window shut and the agent's own write was reported as the user's.
const writeScope = createWriteScope({
  resolve: id => figma.getNodeByIdAsync(id),
})
const feedAttributor = createSelfWriteAttributor(writeScope)
const feedAccum = createAccumulator(ACCUM_CAP)

// Component-index freshness: a change touching one of these types means the
// server's index no longer agrees with the DOCUMENT. It only SIGNALS — the
// server re-projects — so documentchange granularity is not load-bearing.
const INDEX_STALE_TYPES = new Set([
  'COMPONENT',
  'COMPONENT_SET',
  'INSTANCE',
])

const emitFlush = () => {
  const out = feedAccum.drain()
  // The flush window is over: the next one re-walks each id's locator, so a
  // node the user has since moved to another frame is located where it is
  // now. Immediately after the drain, and before the early return — a window
  // that produced no records still ends here.
  feedAttributor.resetWindow()
  // The ONLY deliberately empty frame is the opening flush, which the UI
  // sends on register — never this one. An `overflow` with nothing else to
  // carry still goes: the arm IS the message.
  if (
    out.changes.length === 0 &&
    !out.indexStale &&
    !out.overflow
  )
    return
  // Names → masks, ONCE, over the whole drained batch. It cannot happen
  // earlier: the table is a property of the FRAME, and a writer first
  // appearing late in the window would renumber bits already stamped.
  const minted = mintFrame(out.changes)
  try {
    figma.ui.postMessage({
      type: 'feed-flush',
      changes: minted.changes,
      ...(minted.writers !== undefined
        ? { writers: minted.writers }
        : {}),
      indexStale: out.indexStale,
      ...(out.overflow ? { overflow: true as const } : {}),
      at: Date.now(),
    })
  } catch {
    // The accumulator was drained BEFORE this, so the batch is already gone
    // and there is nothing to put back. `postMessage` rejects a value it
    // cannot structured-clone, and this runs from a bare setTimeout: without
    // the guard the whole flush vanishes with no arm and no record that
    // anything went missing. A plugin-side loss is reported, never silent.
    feedAccum.markOverflow()
    if (out.indexStale) feedAccum.markIndexStale()
    feedFlusher.schedule()
  }
}

const feedFlusher = createFlusher({
  debounceMs: FLUSH_DEBOUNCE_MS,
  maxWaitMs: FLUSH_MAX_WAIT_MS,
  minIntervalMs: Math.ceil(1000 / FEED_FRAMES_PER_SEC),
  emit: emitFlush,
})

// ONE documentchange listener: the feed needs every change, and the index's
// staleness is a projection of the same batch rather than a second pass.
figma.on('documentchange', event => {
  for (const change of event.documentChanges) {
    // Per change, not per batch: a removed / inaccessible node costs its own
    // record and nothing else. Losing the tail of a batch would silently drop
    // user edits, which is the one failure this feature exists to prevent.
    try {
      // indexStale is computed PRE-FILTER, on the RAW batch: the agent's own
      // component writes must still mark the index stale, because staleness
      // is the index's agreement with the DOCUMENT (component-index.md).
      const raw = change as { node?: { type?: string } }
      if (
        typeof raw.node?.type === 'string' &&
        INDEX_STALE_TYPES.has(raw.node.type)
      ) {
        feedAccum.markIndexStale()
      }
      const rec = feedAttributor.admit(change)
      if (rec !== null) feedAccum.add(rec)
    } catch {
      // removed / inaccessible node — ignore
    }
  }
  feedFlusher.schedule()
})

// Context listeners, registered separately from the presence ones above: the
// two consumers debounce differently and must not share a code path.
// The record is built FIRST: `admitContext` decides the page slot by
// MEMBERSHIP of the record's own id, so it needs the record.
figma.on('currentpagechange', () => {
  const rec: AttributedRecord = {
    op: 'page',
    id: figma.currentPage.id,
    name: figma.currentPage.name,
  }
  const stamped = feedAttributor.admitContext(rec)
  if (stamped === null) return
  feedAccum.add(stamped)
  feedFlusher.schedule()
})

figma.on('selectionchange', () => {
  const sel = figma.currentPage.selection
  const rec: AttributedRecord = {
    op: 'select',
    ids: sel.slice(0, SELECT_IDS_CAP).map(n => n.id),
  }
  // count carries the TRUE size only when the ids were truncated — a marquee
  // over a thousand nodes must not put a thousand ids on the wire (T10).
  if (sel.length > SELECT_IDS_CAP) rec.count = sel.length
  const stamped = feedAttributor.admitContext(rec)
  if (stamped === null) return
  feedAccum.add(stamped)
  feedFlusher.schedule()
})
// ── end Change Feed ─────────────────────────────────────────────────────

// Plugin Presence (Task 8): best-effort clean-close signal. On a clean
// close, tell the UI to send a `leave` frame so the relay drops the
// channel immediately instead of waiting for the ~60s heartbeat timeout.
// KNOWN RISK: figma.on('close') may not fire on every close path (or the
// iframe may be torn down before the UI can flush the frame) — that's
// acceptable, the heartbeat is the backstop.
figma.on('close', () => {
  figma.ui.postMessage({ type: 'leave' })
})

type PluginMessage =
  | {
      type: 'execute-command'
      id: string
      command: string
      params: Record<string, unknown>
      targetFileKey?: string | null
      /** The WRITER of this dispatch — meta.sessionId, forwarded by the UI
       *  realm. An INTERNAL field: `sessionId` already rides the wire's meta
       *  (request-envelope.md), so this adds nothing to the protocol. */
      sessionId?: string | null
    }
  | { type: 'get-identity' }
  | { type: 'storage-get'; key: string }
  | { type: 'storage-set'; key: string; value: unknown }
  | { type: 'storage-delete'; key: string }
  | { type: 'resize'; height: number }

// B24: `loadFontAsync` per text node made `create_tree` exceed its timeout at
// ~7 texts — one call in the sequence blocks ~11s while newly-created nodes are
// pending. Asked once per distinct font instead, the same tree builds in
// milliseconds. Session-scoped: a font stays loaded for the plugin's life.
const fontLoader = createFontLoader(async font => {
  await figma.loadFontAsync(font)
})

/**
 * One child of a PAGE / DOCUMENT at the read's own depth boundary — the shape
 * the server turns straight into an id-stub.
 *
 * It carries the two things a stub needs and the old three-key summary did not
 * (B51): the node's REAL size, and how many children it hides. Without the
 * size, every child of a page-rooted read came back `size: [0,0]` — a value
 * the file does not hold (B26: never present a value the engine is not
 * maintaining). Without `childCount`, the receipt reported the level as
 * childless, so `truncated` claimed a completeness the read did not have.
 *
 * A PAGE under a DOCUMENT has no width/height, so those keys are simply
 * omitted — a page has no size, and none is invented for it.
 */
const childBoundary = (
  child: BaseNode,
): Record<string, unknown> => {
  const kids = (child as Partial<ChildrenMixin>).children
  return {
    id: child.id,
    name: child.name,
    type: child.type,
    ...('width' in child
      ? {
          width: (child as SceneNode).width,
          height: (child as SceneNode).height,
        }
      : {}),
    childCount: Array.isArray(kids) ? kids.length : 0,
  }
}

// The `BaseNode`-typed face of enrich-nodes' structural reader, so the other
// context call sites in this file are unchanged.
const readContext = (n: BaseNode): string | undefined =>
  readNodeContext(n as unknown as LiveNode)

// The two globals enrich-nodes needs, feature-detected here (T7) so the module
// itself stays free of the Figma runtime and testable without it. A resolver
// left `undefined` means that half of the wrapper names is simply omitted —
// never a throw that would lose the whole read.
const enrichDeps = () => ({
  mixed: figma.mixed as symbol,
  getStyleName:
    typeof figma.getStyleByIdAsync === 'function'
      ? async (id: string) =>
          (await figma.getStyleByIdAsync(id))?.name
      : undefined,
  getVariableName:
    typeof figma.variables.getVariableByIdAsync ===
    'function'
      ? async (id: string) =>
          (await figma.variables.getVariableByIdAsync(id))
            ?.name
      : undefined,
})

// ─── binding (var()/style() wrappers, bind_variable, apply_style) ────────────

/**
 * A local-token lister, feature-detected at CALL time (the enrichDeps rule):
 * every one of these globals is optional in principle, and a plugin that
 * dereferenced them while loading would die before it could degrade. An absent
 * API throws here instead, which the binder catches into one warning (T7).
 */
const lister =
  <T>(
    label: string,
    pick: () => (() => Promise<T[]>) | undefined,
  ) =>
  (): Promise<T[]> => {
    const fn = pick()
    if (typeof fn !== 'function') {
      throw new Error(
        label + ' unavailable in this Figma version',
      )
    }
    return fn()
  }

/**
 * Name → variable/style lookups, cached for ONE command dispatch (`reset()`
 * runs at the top of handleCommand). A binding names a token, and only an
 * enumeration turns that name into the object Figma binds; a create_tree that
 * reuses eight tokens across a hundred nodes pays for one scan rather than one
 * per node.
 */
const bindingLookups = createBindingLookups({
  listVariables: lister('getLocalVariablesAsync', () =>
    figma.variables?.getLocalVariablesAsync?.bind(
      figma.variables,
    ),
  ),
  // B66 — only for naming a collection in a shadow report, and only asked for
  // when there is one to name, so a clean write never pays for this scan.
  listCollections: lister(
    'getLocalVariableCollectionsAsync',
    () =>
      figma.variables?.getLocalVariableCollectionsAsync?.bind(
        figma.variables,
      ),
  ),
  listStyles: {
    paint: lister('getLocalPaintStylesAsync', () =>
      figma.getLocalPaintStylesAsync?.bind(figma),
    ),
    text: lister('getLocalTextStylesAsync', () =>
      figma.getLocalTextStylesAsync?.bind(figma),
    ),
    effect: lister('getLocalEffectStylesAsync', () =>
      figma.getLocalEffectStylesAsync?.bind(figma),
    ),
    grid: lister('getLocalGridStylesAsync', () =>
      figma.getLocalGridStylesAsync?.bind(figma),
    ),
  },
})

/**
 * Every local variable and every collection NAME, as the file stands now (B66).
 *
 * Not the cached `bindingLookups` scan: this one is taken at a specific moment
 * — before `create_variables` adds anything — and the cache is keyed to the
 * dispatch, not to a moment inside it.
 *
 * Degrades to nothing (T7). A runtime that will not enumerate reports no
 * shadow, which is the same answer as a file that has none; a create must never
 * fail over a warning it could not compute.
 */
const localVariablesSnapshot = async (): Promise<{
  variables: VariableLike[]
  collectionNames: Record<string, string>
}> => {
  const empty = { variables: [], collectionNames: {} }
  const listVars =
    figma.variables?.getLocalVariablesAsync?.bind(
      figma.variables,
    )
  if (typeof listVars !== 'function') return empty
  let variables: VariableLike[]
  try {
    variables = (await listVars()) as VariableLike[]
  } catch {
    return empty
  }
  const collectionNames: Record<string, string> = {}
  const listCollections =
    figma.variables?.getLocalVariableCollectionsAsync?.bind(
      figma.variables,
    )
  if (typeof listCollections === 'function') {
    try {
      for (const c of await listCollections()) {
        collectionNames[c.id] = c.name
      }
    } catch {
      // A collection that will not name itself is named by id downstream.
    }
  }
  return { variables, collectionNames }
}

/** figma.variables.setBoundVariableForPaint + figma.mixed, feature-detected. */
const paintBindDeps = () => ({
  mixed: figma.mixed as unknown,
  setBoundVariableForPaint: (
    figma.variables as
      | {
          setBoundVariableForPaint?: (
            paint: unknown,
            f: 'color',
            v: unknown,
          ) => unknown
        }
      | undefined
  )?.setBoundVariableForPaint,
  // I59 — a gradient STOP binds on the ColorStop, not through the paint
  // setter, and the value it takes there is a VariableAlias this factory
  // mints. Feature-detected like every other gated member (T7).
  createVariableAlias: (
    figma.variables as
      | {
          createVariableAlias?: (v: unknown) => unknown
        }
      | undefined
  )?.createVariableAlias?.bind(figma.variables) as
    | ((v: unknown) => unknown)
    | undefined,
})

/** Everything the inline-wrapper binder needs: the two lookups + the paint deps. */
const wrapperBindDeps = () => ({
  ...paintBindDeps(),
  variableByName: bindingLookups.variableByName,
  variableShadows: bindingLookups.variableShadows,
  styleByName: bindingLookups.styleByName,
})

/**
 * The `depth` a read command carries, defaulting to 0 — the same default the
 * server's own read model applies when the caller names none.
 */
const readDepth = (
  params: Record<string, unknown>,
): number =>
  typeof params.depth === 'number' ? params.depth : 0

/**
 * One node's export, enriched to the read's own `depth`.
 *
 * `depth` is what the caller asked for — 0 (the node alone) through N, or -1
 * for every level. It bounds the enrichment ONLY: `exportAsync` returns the
 * whole subtree either way, and anything past `depth` collapses to an id-stub
 * server-side, so enriching it would buy nothing (T10).
 *
 * Every field JSON_REST_V1 cannot carry — vector geometry, pointCount, the
 * unrotated size, text runs, style/variable names, component.key — lands on
 * every node within `depth`, not just the root: see enrich-nodes.ts.
 */
const exportNodeDocument = async (
  node: BaseNode,
  depth: number,
): Promise<unknown> => {
  // A PAGE (or the DOCUMENT) cannot be exported: `exportAsync` is a SceneNode
  // call. So the read is ASSEMBLED from its children instead — and the depth
  // the caller asked for is spent on THEM (B51). It used to be ignored
  // entirely: a page-rooted `depth:2` returned byte-identical output to
  // `depth:1`, three keys per child and a fabricated `size: [0,0]` on each,
  // while `truncated: []` claimed the read had lost nothing.
  if (node.type === 'DOCUMENT' || node.type === 'PAGE') {
    const ctx = readContext(node)
    const kids =
      'children' in node
        ? (node as BaseNode & ChildrenMixin).children
        : []
    // depth 0 wants the page alone, so its children stay boundary rows and no
    // subtree is serialized — the cheap default read stays cheap. Any deeper
    // read exports each child at the depth left over, exactly as a read
    // ENTERED at that child would, so a descendant of a page is as complete as
    // a descendant of a frame.
    const children =
      depth === 0
        ? kids.map(childBoundary)
        : await Promise.all(
            kids.map(child =>
              exportPageChild(
                child,
                depth === -1 ? -1 : depth - 1,
              ),
            ),
          )
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      children,
      ...(ctx !== undefined ? { context: ctx } : {}),
    }
  }
  const exported = await (node as SceneNode).exportAsync({
    format: 'JSON_REST_V1',
  })
  if (
    typeof exported === 'object' &&
    exported !== null &&
    (exported as Record<string, unknown>).document
  ) {
    const doc = (exported as Record<string, unknown>)
      .document as Record<string, unknown>
    await enrichDocument(
      node as unknown as LiveNode,
      doc,
      depth,
      enrichDeps(),
    )
    return doc
  }
  throw new Error(
    'exportAsync returned unexpected type: ' +
      typeof exported,
  )
}

/**
 * One child of a page, exported — or named as the one node that could not be
 * (T7, *Reads degrade per node*).
 *
 * A page read now touches every child, where the old summary touched none, so
 * one stale handle would have cost the WHOLE page read. It costs that child:
 * the row comes back with whatever identity still reads plus a `readError`, and
 * every sibling is unaffected. The failing row carries NO `childCount` — the
 * read has no idea how many children it hides, and the server turns a row that
 * states a count into an id-stub, which has nowhere to put the failure.
 */
const exportPageChild = async (
  child: BaseNode,
  depth: number,
): Promise<unknown> => {
  try {
    return await exportNodeDocument(child, depth)
  } catch (err) {
    const readError =
      err instanceof Error ? err.message : String(err)
    try {
      const { childCount, ...identity } =
        childBoundary(child)
      return { ...identity, readError }
    } catch {
      // The handle answers nothing at all, its own id included.
      return { type: '', readError }
    }
  }
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  const CHARS =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let b64 = ''
  let i = 0
  while (i < bytes.length) {
    const b0 = bytes[i++]
    const b1 = i < bytes.length ? bytes[i++] : 0
    const b2 = i < bytes.length ? bytes[i++] : 0
    b64 += CHARS[b0 >> 2]
    b64 += CHARS[((b0 & 3) << 4) | (b1 >> 4)]
    b64 += CHARS[((b1 & 15) << 2) | (b2 >> 6)]
    b64 += CHARS[b2 & 63]
  }
  const pad = bytes.length % 3
  if (pad === 1) {
    b64 = b64.slice(0, -2) + '=='
  } else if (pad === 2) {
    b64 = b64.slice(0, -1) + '='
  }
  return b64
}

const bytesToString = (bytes: Uint8Array): string => {
  let result = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const end =
      i + chunkSize < bytes.length
        ? i + chunkSize
        : bytes.length
    const slice = bytes.slice(i, end)
    result += String.fromCharCode.apply(
      null,
      slice as unknown as number[],
    )
  }
  return result
}

// The WS wire keeps the STRING 'auto' for an auto column/row count because JSON
// can't carry Infinity. Translate it back to Figma's Infinity right before any
// assign to .layoutGrids (the READ side maps Infinity → 'auto' in gridToAst).
const reviveLayoutGrid = (g: unknown): LayoutGrid => {
  if (
    g !== null &&
    typeof g === 'object' &&
    (g as { count?: unknown }).count === 'auto'
  ) {
    return {
      ...(g as Record<string, unknown>),
      count: Infinity,
    } as unknown as LayoutGrid
  }
  return g as LayoutGrid
}

type ParentNode =
  | FrameNode
  | PageNode
  | SectionNode
  | ComponentNode
  | GroupNode

const applyCommonProperties = async (
  node: SceneNode,
  spec: Record<string, unknown>,
  _parent: ParentNode,
  warnings?: string[],
  // `deferSize: true` on the paths whose target is ARBITRARY — update_node and
  // the update_component slot loop. There the caller writes `size` ITSELF, with
  // applySizeVerified, after applyPostAppendProperties: `sizing` can overrule a
  // resize, so on a patch the size has to be written last and proven there
  // (B46). A create states its own type and takes the size here.
  opts?: { deferSize?: boolean },
): Promise<void> => {
  // Name
  if (spec.name !== undefined) {
    node.name = spec.name as string
  }

  // Size (B46)
  if (opts?.deferSize !== true) {
    applySize(node, spec.size, warnings)
  }

  // Position
  if (spec.position !== undefined) {
    const [x, y] = spec.position as [number, number]
    node.x = x
    node.y = y
  }

  // Type-specific geometry props: pointCount (POLYGON/STAR), innerRadius (STAR),
  // sectionContentsHidden (SECTION). Applied here (guarded by `'X' in node`) so
  // they take effect on BOTH create AND update — createSingleNode's type cases
  // set them on create too; without this branch update_node silently no-ops them
  // (the sectionContentsHidden:false bug found live 2026-07-17). `!== undefined`
  // so a `false` is honored, not dropped.
  if (
    spec.pointCount !== undefined &&
    'pointCount' in node
  ) {
    ;(
      node as unknown as { pointCount: number }
    ).pointCount = spec.pointCount as number
  }
  if (
    spec.innerRadius !== undefined &&
    'innerRadius' in node
  ) {
    ;(
      node as unknown as { innerRadius: number }
    ).innerRadius = spec.innerRadius as number
  }
  if (
    spec.sectionContentsHidden !== undefined &&
    'sectionContentsHidden' in node
  ) {
    ;(
      node as unknown as { sectionContentsHidden: boolean }
    ).sectionContentsHidden =
      spec.sectionContentsHidden as boolean
  }

  // Fills (already parsed to paint objects by server)
  if (spec.fills !== undefined) {
    const fills = spec.fills as (Paint & {
      imageUrl?: string
      imageHash?: string
      scaleMode?: string
    })[]
    const paintArray: Paint[] = []
    for (const fill of fills) {
      const raw = fill as unknown as Record<string, unknown>
      if (fill.type === 'IMAGE' && raw.imageUrl) {
        // Fetch image from URL and create ImagePaint.
        // Spread the server's already-parsed paint (it
        // carries rot/tile/op/blend/vis) and override only
        // what needs plugin-side work: resolve the URL to a
        // hash and drop the write-only imageUrl key.
        const { imageUrl, ...rest } = raw
        const image = await figma.createImageAsync(
          imageUrl as string,
        )
        paintArray.push({
          ...rest,
          type: 'IMAGE',
          imageHash: image.hash,
          scaleMode:
            (rest.scaleMode as ImagePaint['scaleMode']) ??
            'FILL',
        } as ImagePaint)
      } else if (fill.type === 'IMAGE' && raw.imageHash) {
        // Already carries a hash - spread through so
        // rot/tile/op/blend/vis survive, just default
        // scaleMode.
        paintArray.push({
          ...raw,
          scaleMode:
            (raw.scaleMode as ImagePaint['scaleMode']) ??
            'FILL',
        } as ImagePaint)
      } else {
        paintArray.push(fill)
      }
    }
    if ('fills' in node) {
      ;(node as GeometryMixin & SceneNode).fills =
        paintArray
    }
  }

  // Strokes
  if (spec.strokes !== undefined) {
    const strokes = spec.strokes as Paint[]
    const strokeArray: Paint[] = []
    for (const stroke of strokes) {
      strokeArray.push(stroke)
    }
    if ('strokes' in node) {
      ;(node as GeometryMixin & SceneNode).strokes =
        strokeArray
    }
  }

  // Stroke properties
  if (
    spec.strokeWeight !== undefined &&
    'strokeWeight' in node
  ) {
    ;(node as GeometryMixin & SceneNode).strokeWeight =
      spec.strokeWeight as number
  }
  // Per-side stroke weights [t,r,b,l] (B27) — pure helper, see
  // apply-node-fields.ts. The writer emits `strokeWeights` INSTEAD of
  // `strokeWeight` when the four sides differ, so the two never fight; a node
  // type without IndividualStrokesMixin collapses to the top side and warns,
  // where the type is known (T7).
  applyStrokeWeights(
    node as GeometryMixin & SceneNode,
    spec.strokeWeights,
    warnings,
  )
  if (
    spec.strokeAlign !== undefined &&
    'strokeAlign' in node
  ) {
    ;(node as GeometryMixin & SceneNode).strokeAlign =
      spec.strokeAlign as 'CENTER' | 'INSIDE' | 'OUTSIDE'
  }
  if (
    spec.strokeDash !== undefined &&
    'dashPattern' in node
  ) {
    ;(node as GeometryMixin & SceneNode).dashPattern =
      spec.strokeDash as number[]
  }

  // Stroke geometry (cap/join/miter) — pure helper, see
  // apply-node-fields.ts. The writer emits these flat keys from the
  // `stroke(...)` atom's {cap=,join=,miter=} channel (atomToStroke).
  applyStrokeGeometry(
    node as GeometryMixin & SceneNode,
    spec as {
      strokeCap?: unknown
      strokeJoin?: unknown
      strokeMiterLimit?: unknown
    },
  )

  // Corner radius — guard on capability so an incompatible node (e.g. a SLICE)
  // warns-and-continues in update_node rather than throwing → {error}.
  if (spec.radius !== undefined && 'cornerRadius' in node) {
    if (Array.isArray(spec.radius)) {
      const [tl, tr, br, bl] = spec.radius as [
        number,
        number,
        number,
        number,
      ]
      const rn = node as RectangleNode | FrameNode
      rn.topLeftRadius = tl
      rn.topRightRadius = tr
      rn.bottomRightRadius = br
      rn.bottomLeftRadius = bl
    } else {
      ;(
        node as RectangleNode | FrameNode | EllipseNode
      ).cornerRadius = spec.radius as number
    }
  }

  // Scalar visual properties
  if (spec.opacity !== undefined && 'opacity' in node) {
    ;(node as FrameNode).opacity = spec.opacity as number
  }
  if (spec.blendMode !== undefined && 'blendMode' in node) {
    ;(node as FrameNode).blendMode =
      spec.blendMode as BlendMode
  }
  if (spec.rotation !== undefined && 'rotation' in node) {
    ;(node as FrameNode).rotation = spec.rotation as number
  }
  if (spec.visible !== undefined)
    node.visible = spec.visible as boolean
  if (
    spec.clipsContent !== undefined &&
    'clipsContent' in node
  ) {
    ;(node as FrameNode).clipsContent =
      spec.clipsContent as boolean
  }

  // Export settings (presets) — pure helper, see apply-node-fields.ts. The
  // writer passes spec.exportSettings through untouched (already Figma's
  // ExportSettings[] shape).
  applyExportSettings(
    node as ExportMixin & SceneNode,
    spec.exportSettings,
  )

  // Effects (already parsed to effect objects by server)
  if (spec.effects !== undefined && 'effects' in node) {
    const effects = spec.effects as Effect[]
    // Ensure visible defaults
    ;(node as BlendMixin).effects = effects.map(
      function (e) {
        return Object.assign({}, e, {
          visible:
            (e as DropShadowEffect).visible !== undefined
              ? (e as DropShadowEffect).visible
              : true,
        })
      },
    )
  }

  // Layout (FRAME only). Partial layouts are honored: each field is applied
  // only when present, mirroring the server writer's PURE contract (see
  // apply-layout.ts).
  //
  // The sink is NOT optional here (B58). applyLayout reads every field back and
  // names the ones that did not hold — a UI selection on the target makes an
  // align write drop silently — and it was called without a sink, so those
  // notes (and the GRID capability degrade beside them) went nowhere.
  if (spec.layout !== undefined && 'layoutMode' in node) {
    applyLayout(
      node as FrameNode,
      spec.layout as AppliedLayout,
      warnings,
    )
  }

  // The four auto-layout size clamps are NOT applied here (B59). Figma judges
  // them against the node's PARENT — "Can only set maxWidth on auto layout
  // nodes and their children" — and on the create path a fresh node is still
  // parented to the current page at this point. They belong to
  // applyPostAppendProperties, beside the other parent-dependent writes.

  // Layout grids. The server writer converts grid atoms → COMPLETE Figma
  // LayoutGrid objects (via atomToGrid) and emits them as spec.grids; Figma's
  // own property is layoutGrids — applyGrids (apply-node-fields.ts) does the
  // assign. Capability-guard here (not inside the pure helper) so an
  // incompatible node warns-and-continues (T7) rather than throwing →
  // {error}. Each grid's auto count rides the wire as 'auto' (JSON has no
  // Infinity) → revive to Infinity.
  if (spec.grids !== undefined) {
    if ('layoutGrids' in node) {
      applyGrids(
        node as FrameNode,
        (spec.grids as unknown[]).map(reviveLayoutGrid),
      )
    } else {
      warnings?.push(
        'grids ignored — not supported on a ' +
          node.type +
          ' node',
      )
    }
  }

  // Apply resolved style IDs (server resolves style(name) → styleId)
  if (
    spec.fillStyleId !== undefined &&
    'fillStyleId' in node
  ) {
    ;(node as GeometryMixin & SceneNode).fillStyleId =
      spec.fillStyleId as string
  }
  if (
    spec.strokeStyleId !== undefined &&
    'strokeStyleId' in node
  ) {
    ;(node as GeometryMixin & SceneNode).strokeStyleId =
      spec.strokeStyleId as string
  }
  if (
    spec.effectStyleId !== undefined &&
    'effectStyleId' in node
  ) {
    ;(node as BlendMixin).effectStyleId =
      spec.effectStyleId as string
  }
  if (
    spec.textStyleId !== undefined &&
    'textStyleId' in node
  ) {
    ;(node as TextNode).textStyleId =
      spec.textStyleId as string
  }
  if (
    spec.context !== undefined &&
    'setSharedPluginData' in node
  ) {
    const raw = String(spec.context)
    ;(
      node as BaseNode & PluginDataMixin
    ).setSharedPluginData(
      CONTEXT_NS,
      CONTEXT_KEY,
      raw.trim() === '' ? '' : raw,
    )
  }
}

/**
 * A published KEY → the component it names, within a deadline.
 *
 * A published key may belong to a COMPONENT or a COMPONENT_SET — Figma has a
 * separate importer per kind and the key itself does not say which. Both run
 * concurrently, first fulfilment wins, and a set resolves to its
 * defaultVariant, because you instance a variant and never the set itself
 * (expression-formats.md). Sequential would not work: the wrong importer HANGS
 * rather than rejecting (import-by-key.ts), so a catch-and-fall-back never
 * reaches the second one.
 *
 * Module-level because two callers need it — `create_node`'s INSTANCE arm and
 * `update_component`'s INSTANCE_SWAP default (B70).
 */
const importComponentKey = (
  key: string,
): Promise<ComponentNode> =>
  importComponentByKeyWithDeadline(key, {
    component: k => figma.importComponentByKeyAsync(k),
    set: k => figma.importComponentSetByKeyAsync(k),
  })

/**
 * The node id an INSTANCE_SWAP `defaultValue` names (B70).
 *
 * Local first, and the order is not an optimisation. `importComponentByKeyAsync`
 * NEVER SETTLES on the key of a local unpublished component (import-by-key.ts),
 * so the commonest case in a working file — a component you just made — would
 * stall for the whole deadline before falling back. A document scan answers it
 * at once, and the import is left for the keys only a library can resolve.
 *
 * An unresolvable key is passed through UNCHANGED with a warning. Figma then
 * refuses it in its own words, on the existing catch, and the caller sees both
 * halves: what this could not resolve, and what Figma made of it.
 */
const resolveSwapDefault = async (
  property: string,
  type: unknown,
  defaultValue: unknown,
  warnings: string[],
): Promise<unknown> => {
  const key = instanceSwapKey(type, defaultValue)
  if (key === undefined) return defaultValue
  const local = figma.root
    .findAllWithCriteria({
      types: ['COMPONENT', 'COMPONENT_SET'],
    })
    .find(
      n =>
        (n as ComponentNode | ComponentSetNode).key === key,
    )
  if (local !== undefined) {
    return local.type === 'COMPONENT_SET'
      ? ((local as ComponentSetNode).defaultVariant?.id ??
          local.id)
      : local.id
  }
  try {
    return (await importComponentKey(key)).id
  } catch {
    warnings.push(unresolvedSwapKeyMessage(property, key))
    return defaultValue
  }
}

const applyPostAppendProperties = (
  node: SceneNode,
  spec: Record<string, unknown>,
  warnings?: string[],
  // `deferSizing: true` on the create_tree path, where the node's own FILL/HUG
  // resize has to wait for its children (B60). Every other caller writes the
  // sizing here, where it always has been.
  opts?: { deferSizing?: boolean },
): void => {
  // These must be set AFTER appendChild to auto-layout parent. On update_node
  // the target is an arbitrary pre-existing node, so an incompatible context
  // (e.g. layoutSizing on a child of a non-auto-layout parent) would THROW.
  // T7: degrade with a warning and continue rather than throwing → {error},
  // matching the x/y warn-and-continue path.

  // Sizing — see applySizing (apply-node-fields.ts). A FILL or HUG axis makes
  // Figma RESIZE the node, so on a tree the caller applies it itself, once the
  // node's children are in it and carry their constraints (B60).
  if (opts?.deferSizing !== true) {
    applySizing(node as FrameNode, spec.sizing, warnings)
  }

  // The four auto-layout size clamps (B59). Here rather than on the common
  // apply path because Figma accepts them only on an auto-layout frame or a
  // direct child of one, and until the append above the node's parent was
  // whatever page Figma auto-parented it to — which is how a TEXT node stating
  // `maxWidth` inside an auto-layout frame failed a create whose END state was
  // perfectly valid. A refusal here throws (the create rolls the tree back and
  // answers one error envelope): post-append, the node is where the spec put
  // it, so Figma is refusing the stated end state, not the timing.
  applyMinMax(
    node as FrameNode,
    spec as {
      minWidth?: unknown
      maxWidth?: unknown
      minHeight?: unknown
      maxHeight?: unknown
    },
    warnings,
  )

  // Layout positioning (ABSOLUTE)
  if (spec.layoutPositioning !== undefined) {
    try {
      ;(node as FrameNode).layoutPositioning =
        spec.layoutPositioning as 'AUTO' | 'ABSOLUTE'
      // An ABSOLUTE child escapes the auto-layout flow, but its x/y were set in
      // applyCommonProperties BEFORE appendChild — where the parent's auto-layout
      // overwrote them with a flow slot. Now that the node is ABSOLUTE, re-apply
      // the intended position so it lands where the spec asked.
      if (
        spec.layoutPositioning === 'ABSOLUTE' &&
        Array.isArray(spec.position)
      ) {
        const [px, py] = spec.position as [number, number]
        if (typeof px === 'number') {
          ;(node as LayoutMixin).x = px
        }
        if (typeof py === 'number') {
          ;(node as LayoutMixin).y = py
        }
      }
    } catch (e) {
      warnings?.push(
        'layoutPositioning not applicable on this node (' +
          node.type +
          '): ' +
          String(e),
      )
    }
  }

  // isMask / maskType — applied POST-append (mask clips siblings; node must be
  // parented first so Figma resolves the sibling context correctly).
  // Feature-detect with 'isMask' in node (not all nodes support masking).
  if (spec.isMask !== undefined) {
    if ('isMask' in node) {
      try {
        ;(node as SceneNode & { isMask: boolean }).isMask =
          spec.isMask as boolean
      } catch (e) {
        warnings?.push(
          'isMask could not be set: ' + String(e),
        )
      }
    }
  }
  if (spec.maskType !== undefined) {
    if ('maskType' in node) {
      try {
        ;(
          node as SceneNode & { maskType: string }
        ).maskType = spec.maskType as string
      } catch (e) {
        warnings?.push(
          'maskType could not be set: ' + String(e),
        )
      }
    } else {
      warnings?.push(
        'maskType not supported on this node type (' +
          node.type +
          ')',
      )
    }
  }

  // Constraints — set AFTER appendChild. On create the node isn't parented when
  // applyCommonProperties runs, so constraints set there don't stick; here the
  // node is already in the tree. Writer emits the ARRAY [h,v] (Plugin vocab);
  // Figma's setter wants {horizontal, vertical}. Capability-guard + warn (T7).
  if (spec.constraints !== undefined) {
    if ('constraints' in node) {
      const [h, v] = spec.constraints as [string, string]
      ;(node as ConstraintMixin & SceneNode).constraints = {
        horizontal: h as ConstraintType,
        vertical: v as ConstraintType,
      }
    } else {
      warnings?.push(
        'constraints ignored — not supported on a ' +
          node.type +
          ' node',
      )
    }
  }
}

/**
 * Write one range property, or say why it could not be written.
 *
 * T7 feature detection: `setRangeLineHeight` and friends are not on every
 * Figma runtime this plugin can be loaded into, and an older host must degrade
 * to "the range keeps the node-level value" rather than lose the node. The
 * missing-API warning is emitted ONCE per method however many runs asked for
 * it — fifty runs on an old host cost one line, not fifty (T4).
 *
 * A throw from Figma AFTER a successful feature check is a rejection of this
 * particular range, not of the node: it is reported and the remaining runs
 * still apply. Font availability is NOT handled here — every range font is
 * loaded up front, where a failure is fatal by design (see applyTextRuns).
 */
const setRangeProperty = (
  node: TextNode,
  method: string,
  op: RangeOp,
  value: unknown,
  warnings: string[] | undefined,
  declined: Set<string>,
): void => {
  const fn = (node as unknown as Record<string, unknown>)[
    method
  ]
  if (typeof fn !== 'function') {
    if (!declined.has(method)) {
      declined.add(method)
      warnings?.push(
        'text.runs: this Figma build exposes no ' +
          method +
          ' — those ranges keep the node-level value',
      )
    }
    return
  }
  try {
    ;(
      fn as (s: number, e: number, v: unknown) => void
    ).call(node, op.start, op.end, value)
  } catch (e) {
    warnings?.push(
      'text.runs: Figma rejected ' +
        method +
        ' on [' +
        String(op.start) +
        ',' +
        String(op.end) +
        ']: ' +
        String(e),
    )
  }
}

/**
 * Apply `text.runs` — the per-range overrides.
 *
 * Runs are applied LAST, after content and after every node-level text
 * property, because that is what "override" means: a range's font has to win
 * over the one the same spec just set on the whole node, and the ranges index
 * into `text.content`, which is written above.
 *
 * A run naming an unavailable FONT is fatal, deliberately and consistently
 * with the node-level font a few lines up: `loadFontAsync` throws, the caller
 * turns it into FONT_LOAD_FAILED, and the agent learns the font does not
 * exist. Rendering the range in whatever font happened to be there instead —
 * with or without a warning — is the silent substitution this surface has
 * repeatedly been checked for not doing.
 */
const applyTextRuns = async (
  node: TextNode,
  runs: unknown,
  warnings?: string[],
): Promise<void> => {
  const { ops, skipped } = runsToRangeOps(
    runs,
    node.characters.length,
  )
  for (const s of skipped) {
    warnings?.push('text.runs: ' + s)
  }
  if (ops.length === 0) {
    return
  }
  // Every range font, before any setRangeFontName — an unloaded range font
  // throws from inside the loop, having already applied the runs before it.
  for (const font of fontsToLoad(ops)) {
    await fontLoader.ensure(font)
  }
  const declined = new Set<string>()
  for (const op of ops) {
    if (op.fontName !== undefined) {
      setRangeProperty(
        node,
        'setRangeFontName',
        op,
        op.fontName,
        warnings,
        declined,
      )
    }
    if (op.fontSize !== undefined) {
      setRangeProperty(
        node,
        'setRangeFontSize',
        op,
        op.fontSize,
        warnings,
        declined,
      )
    }
    if (op.lineHeight !== undefined) {
      setRangeProperty(
        node,
        'setRangeLineHeight',
        op,
        op.lineHeight,
        warnings,
        declined,
      )
    }
    if (op.letterSpacing !== undefined) {
      setRangeProperty(
        node,
        'setRangeLetterSpacing',
        op,
        op.letterSpacing,
        warnings,
        declined,
      )
    }
    if (op.fills !== undefined) {
      setRangeProperty(
        node,
        'setRangeFills',
        op,
        op.fills,
        warnings,
        declined,
      )
    }
  }
}

const applyTextProperties = async (
  node: TextNode,
  spec: Record<string, unknown>,
  warnings?: string[],
): Promise<void> => {
  const text = spec.text as Record<string, unknown>
  if (!text) return

  const font = text.font as
    | {
        family: string
        style: string
        size: number
      }
    | undefined

  // A font MUST be loaded before ANY text property is written — including a
  // content-only patch, which writes the node's EXISTING font. So the patch
  // that names no font loads what the node already uses (every range of it:
  // fontName is figma.mixed on a multi-font node, and getRangeAllFontNames
  // answers uniformly for both). Without this the plainest patch there is —
  // "change this string" — would demand the agent restate the type.
  if (font !== undefined) {
    await fontLoader.ensure({
      family: font.family,
      style: font.style,
    })
    // Set font
    node.fontName = {
      family: font.family,
      style: font.style,
    }
    node.fontSize = font.size
  } else if (node.characters.length > 0) {
    for (const existing of node.getRangeAllFontNames(
      0,
      node.characters.length,
    )) {
      await fontLoader.ensure(existing)
    }
  } else if (node.fontName !== figma.mixed) {
    // An EMPTY text node has no range to ask about; its single fontName is
    // the one the first write will use.
    await fontLoader.ensure(node.fontName)
  }

  // Text auto-resize (set before content to avoid resize fighting)
  if (spec.textAutoResize !== undefined) {
    node.textAutoResize = spec.textAutoResize as
      | 'NONE'
      | 'WIDTH_AND_HEIGHT'
      | 'HEIGHT'
      | 'TRUNCATE'
  }

  // Set text content
  if (text.content !== undefined) {
    node.characters = text.content as string
  }

  // Alignment
  if (text.align !== undefined) {
    node.textAlignHorizontal = text.align as
      | 'LEFT'
      | 'CENTER'
      | 'RIGHT'
      | 'JUSTIFIED'
  }
  if (text.valign !== undefined) {
    node.textAlignVertical = text.valign as
      | 'TOP'
      | 'CENTER'
      | 'BOTTOM'
  }

  // Text color (from parsed paint)
  if (text.color !== undefined) {
    const paint = text.color as {
      type: string
      color: RGB
      opacity: number
    }
    if (paint.type === 'SOLID') {
      node.fills = [
        {
          type: 'SOLID',
          color: paint.color,
          opacity:
            paint.opacity !== undefined ? paint.opacity : 1,
        },
      ]
    }
  }

  // Line height
  if (text.lineHeight !== undefined) {
    const lh = text.lineHeight as {
      value?: number
      unit: string
    }
    if (lh.unit === 'AUTO') {
      node.lineHeight = { unit: 'AUTO' }
    } else if (lh.unit === 'PIXELS') {
      node.lineHeight = {
        value: lh.value as number,
        unit: 'PIXELS',
      }
    } else if (lh.unit === 'PERCENT') {
      node.lineHeight = {
        value: lh.value as number,
        unit: 'PERCENT',
      }
    }
  }

  // Letter spacing
  if (text.letterSpacing !== undefined) {
    const ls = text.letterSpacing as {
      value: number
      unit: string
    }
    node.letterSpacing = {
      value: ls.value,
      unit: ls.unit as 'PIXELS' | 'PERCENT',
    }
  }

  // Decoration
  if (text.decoration !== undefined) {
    node.textDecoration = text.decoration as
      | 'NONE'
      | 'UNDERLINE'
      | 'STRIKETHROUGH'
  }

  // Case
  if (text.case !== undefined) {
    node.textCase = text.case as
      | 'ORIGINAL'
      | 'UPPER'
      | 'LOWER'
      | 'TITLE'
      | 'SMALL_CAPS'
      | 'SMALL_CAPS_FORCED'
  }

  // Paragraph spacing
  if (text.paragraphSpacing !== undefined) {
    node.paragraphSpacing = text.paragraphSpacing as number
  }

  // Per-range overrides, LAST — see applyTextRuns for why the order is fixed.
  if (text.runs !== undefined) {
    await applyTextRuns(node, text.runs, warnings)
  }
}

/**
 * Write per-point detail onto the network Figma just rebuilt.
 *
 * Two-step and async by necessity: `vector.vectorPaths = …` discards the old
 * network and derives a fresh one from the path data, so corner radii and
 * stroke caps can only be stamped afterwards. Everything that can fail here
 * warns and continues — this is detail, and losing the node over one corner is
 * the worse trade (T7).
 *
 * The indices count points within one path, while the network numbers vertices
 * across the node; those agree only for a single-entry vector, which is what
 * the read emits this detail for. Several entries are declined out loud rather
 * than applied to whichever point the flat index happens to land on.
 */
const applyVectorPointDetail = async (
  vector: VectorNode,
  paths: readonly (VectorPath & {
    corners?: Record<number, number>
    caps?: Record<number, string>
    joins?: Record<number, string>
  })[],
  warnings?: string[],
): Promise<void> => {
  const nonEmpty = (
    m: Record<number, unknown> | undefined,
  ): boolean => m !== undefined && Object.keys(m).length > 0
  if (
    !paths.some(
      p =>
        nonEmpty(p.corners) ||
        nonEmpty(p.caps) ||
        nonEmpty(p.joins),
    )
  ) {
    return
  }
  if (paths.length > 1) {
    warnings?.push(
      'per-point detail ignored: this spec has ' +
        String(paths.length) +
        ' paths, and a point index cannot be attributed to one of them — ' +
        'supply the shape as a single path to style its points',
    )
    return
  }
  if (
    !('vectorNetwork' in vector) ||
    typeof vector.setVectorNetworkAsync !== 'function'
  ) {
    warnings?.push(
      'per-point detail ignored: this Figma build exposes no writable vector ' +
        'network — the shape is correct but its corners stay sharp and its ' +
        'caps and joins stay as the node-level ones',
    )
    return
  }
  try {
    const network = vector.vectorNetwork
    const patched = applyPointDetail(network.vertices, {
      corners: paths[0].corners,
      caps: paths[0].caps as
        | Record<number, StrokeCap>
        | undefined,
      joins: paths[0].joins as
        | Record<number, StrokeJoin>
        | undefined,
    })
    await vector.setVectorNetworkAsync({
      ...network,
      vertices: patched.vertices,
    })
    if (patched.skipped.length > 0) {
      warnings?.push(
        'per-point detail skipped at index ' +
          patched.skipped.join(', ') +
          ': the path has only ' +
          String(network.vertices.length) +
          ' points',
      )
    }
  } catch (e) {
    warnings?.push(
      'per-point detail rejected by Figma: ' + String(e),
    )
  }
}

/**
 * Write a vector's geometry: the paths, then the per-point detail they carry.
 *
 * ONE function for create and update (B45). It used to be inline in the VECTOR
 * arm of the create switch, so `update_node` — which never enters that switch —
 * accepted `vectorPaths`, changed nothing, and answered `warnings: []` while a
 * sibling field in the same patch landed. The canonical atom a read emits has
 * to be writable back (T2), and it is only writable back where the write path
 * is shared.
 *
 * The server hands each path over as `{windingRule, data, corners?}`. Only the
 * first two are Figma's shape — the radii, caps and joins live on the network,
 * and are written after, because assigning `vectorPaths` rebuilds it.
 */
const applyVectorPaths = async (
  vector: VectorNode,
  raw: unknown,
  warnings?: string[],
): Promise<void> => {
  const paths = raw as (VectorPath & {
    corners?: Record<number, number>
    caps?: Record<number, string>
    joins?: Record<number, string>
  })[]
  try {
    vector.vectorPaths = paths.map(
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
      'vectorPaths rejected by Figma: ' + String(e),
    )
    // The network was not rebuilt, so per-point detail has nothing to land on.
    return
  }
  await applyVectorPointDetail(vector, paths, warnings)
}

// The builder proper: create the node by type, configure it, append it. On a
// throw it leaves the half-built node wherever it got to — which is why nothing
// calls it directly. `createSingleNode` below wraps it with the rollback that
// makes that impossible to observe. `track` publishes the node to that wrapper
// the instant Figma hands it over, because that instant is already too late to
// be silent about: Figma auto-parents a fresh node to the current page.
const buildSingleNode = async (
  spec: Record<string, unknown>,
  parent: ParentNode,
  // THREADED, never inferred: dispatches interleave at every await, so a node
  // created after a font load would be claimed under whichever session
  // dispatched in the meantime — and that misattribution lands on the SILENCE
  // side, suppressing the record for a session that did not cause it.
  writer: string,
  track: <T extends SceneNode>(node: T) => T,
  warnings?: string[],
  // B35's sink. The NODE goes in, not a snapshot of its x/y, so the caller
  // reads the position this child ended the level with rather than the one it
  // held before its siblings arrived.
  placed?: Placement[],
  // B60. Passed through to applyPostAppendProperties: on the tree path the
  // caller owns the sizing write, because only it knows when this node's
  // children are in place.
  opts?: { deferSizing?: boolean },
): Promise<SceneNode> => {
  const type = spec.type as string
  let node: SceneNode

  switch (type) {
    case 'FRAME':
      node = figma.createFrame()
      break
    case 'RECTANGLE':
      node = figma.createRectangle()
      break
    case 'ELLIPSE': {
      const ellipse = track(figma.createEllipse())
      if (spec.arcData !== undefined) {
        ellipse.arcData = spec.arcData as ArcData
      }
      node = ellipse
      break
    }
    case 'TEXT':
      node = figma.createText()
      break
    case 'LINE':
      node = figma.createLine()
      break
    case 'POLYGON': {
      const polygon = track(figma.createPolygon())
      if (spec.pointCount !== undefined) {
        polygon.pointCount = spec.pointCount as number
      }
      node = polygon
      break
    }
    case 'STAR': {
      const star = track(figma.createStar())
      if (spec.pointCount !== undefined) {
        star.pointCount = spec.pointCount as number
      }
      if (spec.innerRadius !== undefined) {
        star.innerRadius = spec.innerRadius as number
      }
      node = star
      break
    }
    case 'VECTOR': {
      const vector = track(figma.createVector())
      if (
        'vectorPaths' in vector &&
        spec.vectorPaths !== undefined
      ) {
        await applyVectorPaths(
          vector,
          spec.vectorPaths,
          warnings,
        )
      }
      node = vector
      break
    }
    case 'SECTION': {
      const section = track(figma.createSection())
      if (spec.sectionContentsHidden !== undefined) {
        section.sectionContentsHidden =
          spec.sectionContentsHidden as boolean
      }
      node = section
      break
    }
    case 'SLICE':
      node = figma.createSlice()
      break
    case 'INSTANCE': {
      const compRef = spec.component as
        | {
            key?: string
            id?: string
            remote?: boolean
            properties?: Record<string, string | boolean>
          }
        | undefined
      // A published key may belong to a COMPONENT or a COMPONENT_SET — Figma
      // has a separate importer per kind and the key itself does not say
      // which. Both run concurrently, first fulfilment wins, and a set
      // resolves to its defaultVariant: the same rule the local-id path
      // below applies, because you instance a variant and never the set
      // itself (expression-formats.md). Sequential would not work — the
      // wrong importer HANGS rather than rejecting (see import-by-key.ts),
      // so a catch-and-fall-back never reaches the second one.
      const importByKey = importComponentKey
      // Resolve the main component. Two paths:
      //   1. REMOTE (compRef.remote===true AND key present): prefer
      //      importComponentByKeyAsync(key) first — the local id is a
      //      foreign-file node id that won't resolve in a different file
      //      (M14, T2). Fall back to id if the import fails (T7).
      //   2. LOCAL (no remote hint): id-first (unchanged behavior) → key.
      // A COMPONENT_SET resolves to its defaultVariant (you instance a
      // variant, not the set itself).
      let component: ComponentNode | undefined
      if (
        compRef?.remote === true &&
        compRef.key !== undefined
      ) {
        // Remote/published: key-first with id fallback (T7).
        try {
          component = await importByKey(compRef.key)
        } catch {
          warnings?.push(
            'remote component key ' +
              compRef.key +
              ' failed to import; falling back to local id',
          )
          if (compRef.id !== undefined) {
            const found = await figma.getNodeByIdAsync(
              compRef.id,
            )
            if (
              found !== null &&
              found.type === 'COMPONENT'
            ) {
              component = found
            } else if (
              found !== null &&
              found.type === 'COMPONENT_SET'
            ) {
              component = found.defaultVariant ?? undefined
            }
          }
          if (component === undefined) {
            throw new Error(
              'INSTANCE remote component key failed to import and no valid local id fallback: ' +
                compRef.key,
            )
          }
        }
      } else if (compRef?.id !== undefined) {
        const found = await figma.getNodeByIdAsync(
          compRef.id,
        )
        if (found === null) {
          throw new Error(
            'INSTANCE component.id not found: ' +
              compRef.id,
          )
        }
        if (found.type === 'COMPONENT') {
          component = found
        } else if (found.type === 'COMPONENT_SET') {
          component = found.defaultVariant ?? undefined
          if (component === undefined) {
            throw new Error(
              'INSTANCE component.id is a COMPONENT_SET with no default variant: ' +
                compRef.id,
            )
          }
        } else {
          throw new Error(
            'INSTANCE component.id must reference a COMPONENT or COMPONENT_SET, got ' +
              found.type +
              ': ' +
              compRef.id,
          )
        }
      } else if (compRef?.key !== undefined) {
        component = await importByKey(compRef.key)
      } else {
        throw new Error(
          'INSTANCE requires component.id (local component node) or component.key (published/library component or component set)',
        )
      }
      const instance = track(component.createInstance())
      if (compRef.properties) {
        // Figma's setProperties requires EXACT property keys (e.g. "Label#1:0"
        // for TEXT/BOOLEAN/INSTANCE_SWAP; VARIANT props use the bare name).
        // Resolve friendly names against the freshly-created instance's keys so
        // callers may pass "Label" instead of "Label#1:0".
        const { resolved, warnings: resolveWarnings } =
          resolveInstanceProps(
            compRef.properties,
            Object.keys(instance.componentProperties),
          )
        for (const w of resolveWarnings) {
          warnings?.push(w)
        }
        if (Object.keys(resolved).length > 0) {
          instance.setProperties(resolved)
        }
      }
      node = instance
      break
    }
    // NOTE (issue #3): the TEXT_PATH case was removed here. figma.createTextPath
    // is a real API but its fields (vectorNodeId/startSegment/startPosition) were
    // never specced/wired, so the server now rejects type:'TEXT_PATH' up front
    // against CREATABLE_TYPES (shared by create_node and create_tree) — this
    // handler was unreachable. Deferred to the spec-completeness phase; see
    // docs/deferred-capabilities.md.
    case 'SLOT': {
      // SLOT in create_node context: create a FRAME placeholder and WARN (T7) —
      // the agent asked for a SLOT and is getting a FRAME, so it must be told.
      // Actual SLOT promotion happens in update_component via component.createSlot().
      node = figma.createFrame()
      warnings?.push(
        'SLOT requested via create_node was created as a FRAME placeholder; real SLOT promotion happens in update_component via slots param',
      )
      break
    }
    default:
      throw new Error('Unsupported node type: ' + type)
  }

  // The types that create clean (FRAME, RECTANGLE, TEXT, …) reach the wrapper's
  // rollback here; the ones that configure themselves first tracked earlier, and
  // re-tracking the same node is a no-op.
  track(node)

  // Belt-and-braces: the node is still parented to the current page here, so
  // this contributes the TOUCHED half only (its closure is empty). It exists
  // for the path where the append below throws and the node is removed again
  // — Figma still emits CREATE + DELETE for it.
  writeScope.claim(writer, node)

  // Apply common properties (fills, strokes, effects, etc.)
  await applyCommonProperties(node, spec, parent, warnings)

  // Apply text-specific properties (requires font loading)
  if (type === 'TEXT') {
    await applyTextProperties(
      node as TextNode,
      spec,
      warnings,
    )
  }

  // Append to parent — T7: Figma blocks appendChild into non-SLOT instance
  // descendants at runtime. Catch the raw throw and re-raise as a clear
  // structured message that callers convert to { error }.
  try {
    parent.appendChild(node)
  } catch {
    // The node exists and cannot be placed. Removing it is the wrapper's job —
    // this rethrow only has to say WHY, in words the caller can act on.
    throw new Error(
      'Cannot append into this parent: only a component SLOT accepts ' +
        'children inside an instance (got ' +
        parent.type +
        '). To fill a slot, target the slot node.',
    )
  }

  // Apply post-append properties (FILL sizing, ABSOLUTE positioning).
  // `warnings` is threaded, not omitted: applyPostAppendProperties degrades
  // rather than throws (T7), and the message is the ONLY signal the caller
  // gets. Dropping the array here made every create-path degrade silent while
  // the identical update_node path reported it — e.g. `sizing:['FILL',…]` on a
  // child of a SLOT, which Figma rejects ("node must be an auto-layout frame
  // or a child of an auto-layout frame"), leaving the node FIXED with no
  // notice. A build then ships a node sized differently than it asked for.
  applyPostAppendProperties(node, spec, warnings, opts)

  // warn-on-no-op (T7, B35): the append just handed this node's x/y to the
  // parent's auto-layout, and the creation default (B29) is what put that
  // layout on a frame the caller said nothing about. Recorded rather than
  // warned, because the caller holds the SIBLINGS: fifty children of one frame
  // are one warning, not fifty (T4). Recorded HERE, after
  // applyPostAppendProperties, because `layoutPositioning:'ABSOLUTE'` is the
  // escape hatch and it is set there — a node that escaped kept its position
  // and has nothing to report.
  placed?.push({ position: spec.position, node })

  // Bindings LAST: `var(surface/2)#141B2E` sets the paint above and binds the
  // token here, so the binding always lands on a node that already looks
  // right — and on a TEXT node, after applyTextProperties has set the font a
  // style(...) would otherwise be detached by.
  await applyWrapperBindings(
    node as unknown as BindTargetNode,
    spec.bindings,
    wrapperBindDeps(),
    warnings ?? [],
  )

  // B61 — did the stated `size` survive? A LEAF is finished here: its sizing is
  // written and it has no subtree to change the box afterwards, so this is
  // where the answer is true. A node whose sizing was DEFERRED (create_tree, a
  // node with children) is judged by its caller, after the deferred collapse —
  // judging it here would call every hugging frame a failure in the window
  // between its own append and its children.
  if (opts?.deferSizing !== true) {
    verifyCreatedSize(
      node as unknown as SizeTarget,
      spec.size,
      warnings,
      spec.sizing,
    )
  }

  // THE load-bearing claim: the node is in its real parent and its
  // auto-layout sizing is set, so `hugs()` can decide and the reflow closure
  // is the true one. The POC measured both — the at-creation closure is
  // EMPTY every time, so neither call replaces the other.
  writeScope.claim(writer, node)

  return node
}

// Create one node, or leave the document exactly as it was found.
//
// Figma parents a freshly created node to the current page the moment createX()
// returns, so a half-built node is already on the canvas — named, visible, and
// addressable by nobody. Its id only reaches a caller when this function
// RETURNS it (create_tree's `created[]` pushes after the call), so every throw
// in between used to strand a node the caller was never told to clean up: B14's
// debris, and the half of B10(b) the error envelope could not confess to.
// overview.md — "never partially succeeds" — makes that the document's problem
// to not have, so the node is removed on the way out.
const createSingleNode = async (
  spec: Record<string, unknown>,
  parent: ParentNode,
  writer: string,
  warnings?: string[],
  placed?: Placement[],
  opts?: { deferSizing?: boolean },
): Promise<SceneNode> => {
  let held: SceneNode | undefined
  const track = <T extends SceneNode>(node: T): T => {
    held = node
    return node
  }
  try {
    return await buildSingleNode(
      spec,
      parent,
      writer,
      track,
      warnings,
      placed,
      opts,
    )
  } catch (err) {
    // `removed` guard: a node can already be gone (a throw from Figma's own
    // teardown), and removing twice throws over the top of the real error.
    if (held !== undefined && !held.removed) {
      held.remove()
    }
    throw err
  }
}

const createTreeNode = async (
  spec: Record<string, unknown>,
  parent: ParentNode,
  writer: string,
  refs?: Record<string, Record<string, unknown>>,
  // refStack tracks the chain of { ref } keys currently being resolved so a
  // cyclic pool (a→b→a, or a self-ref) is caught and rejected as a clean
  // {error} instead of recursing forever and freezing the Figma UI.
  refStack: string[] = [],
  // Every node this call realizes, pushed AS IT IS CREATED — parent before
  // children, so the array is the root first then depth-first creation order.
  // It is what the tool surface answers as `ids[]` (tool-surface.md:
  // `create_tree(...) → {root, ids[]}`): without it the N-1 non-root nodes of
  // a tree are unaddressable until a follow-up read. A `{ id }` clone counts
  // as ONE realized node — its descendants come along but are not enumerated
  // (walking every clone's subtree is unbounded work, T10).
  created?: string[],
  // Threaded for the same reason `created` is: a degrade can happen at ANY
  // depth of the tree, and the caller only ever sees the root's reply. Without
  // one accumulator spanning the recursion, a lossy write on a grandchild —
  // e.g. `sizing:['FILL',…]` on a child of a SLOT, which Figma rejects — is
  // silently discarded (T7 violation).
  warnings?: string[],
  // B35's sink for THIS node, owned by the caller that appended it (its own
  // children get a fresh one below). Threaded through the `{ ref }` expansion
  // so a ref-built child records the position its POOL spec stated — the
  // wrapper never carries one.
  placed?: Placement[],
): Promise<SceneNode> => {
  const type = spec.type as string

  // Ref-pool reference: { ref } — rebuild refs[key] FRESH on each reuse so N
  // uses of one ref yield N independent subtrees, not N shared references.
  if (spec.ref !== undefined && spec.type === undefined) {
    const refKey = spec.ref as string
    const refSpec = refs?.[refKey]
    if (!refSpec) {
      throw new Error('Ref not found in pool: ' + refKey)
    }
    if (refStack.includes(refKey)) {
      throw new Error(
        'Cyclic ref in pool: ' +
          [...refStack, refKey].join(' -> '),
      )
    }
    // The expansion recurses with the SAME accumulator: a { ref } realizes its
    // whole rebuilt subtree, and every node of it is a node this call created.
    return createTreeNode(
      refSpec,
      parent,
      writer,
      refs,
      [...refStack, refKey],
      created,
      warnings,
      placed,
    )
  }

  // Clone reference: { id } with no type
  if (spec.id !== undefined && spec.type === undefined) {
    const existing = await resolveNodeId(spec.id as string)
    if (!existing)
      throw new Error(
        'Node not found for clone: ' + spec.id,
      )

    if (existing.type === 'COMPONENT') {
      // COMPONENT → create INSTANCE
      const instance = (
        existing as ComponentNode
      ).createInstance()
      // T7: same instance-lock guard as createSingleNode — wrap and re-raise.
      try {
        parent.appendChild(instance)
      } catch {
        instance.remove()
        throw new Error(
          'Cannot append into this parent: only a component SLOT accepts ' +
            'children inside an instance (got ' +
            parent.type +
            '). To fill a slot, target the slot node.',
        )
      }
      writeScope.claim(writer, instance)
      created?.push(instance.id)
      return instance
    }
    if (existing.type === 'INSTANCE') {
      // INSTANCE → create another instance of same component
      const mainComp = (existing as InstanceNode)
        .mainComponent
      if (mainComp) {
        const instance = mainComp.createInstance()
        try {
          parent.appendChild(instance)
        } catch {
          instance.remove()
          throw new Error(
            'Cannot append into this parent: only a component SLOT accepts ' +
              'children inside an instance (got ' +
              parent.type +
              '). To fill a slot, target the slot node.',
          )
        }
        writeScope.claim(writer, instance)
        created?.push(instance.id)
        return instance
      }
    }
    // Default: clone
    const cloned = (existing as SceneNode).clone()
    try {
      parent.appendChild(cloned)
    } catch {
      cloned.remove()
      throw new Error(
        'Cannot append into this parent: only a component SLOT accepts ' +
          'children inside an instance (got ' +
          parent.type +
          '). To fill a slot, target the slot node.',
      )
    }
    writeScope.claim(writer, cloned)
    created?.push(cloned.id)
    return cloned
  }

  // NOTE (issue #2): the composite-via-children cases (GROUP, TRANSFORM_GROUP,
  // BOOLEAN_OPERATION) were removed. The server now rejects these unspecced
  // types up front in create-tree.ts (against the SAME CREATABLE_TYPES list
  // create_node uses), so they can never reach this create-type switch. Their
  // handlers here were unreachable — the ref ({ ref }) and clone ({ id }) paths
  // above return before this point, so a clone-by-id of an existing
  // BOOLEAN_OPERATION / GROUP still works. Booleans are authored via boolean_op.

  // Children first (for FRAME, SECTION, etc.) — the node needs to know whether
  // it has any BEFORE it is built, because a node that does keeps its stated
  // size until they are in it (B60 below).
  const children = spec.children as
    | Record<string, unknown>[]
    | undefined
  const hasChildren =
    Array.isArray(children) && children.length > 0

  // Regular node: create, apply properties, append — and, when it has children,
  // NOT its own sizing (B60). A `FILL` or `HUG` axis makes Figma RESIZE the
  // node, and applied at its own append that resize lands before the node has
  // any children: the ones that arrive afterwards are authored against a box
  // that has already moved, and no constraint of theirs ever re-anchors them,
  // because the resize that would have done it happened before they existed.
  // Live: a `[296,140]` NONE-layout media frame ended 174 wide, and the
  // MAX/MAX badge authored at x=238 read back at 183. A faithful re-anchor
  // across the whole 296→174 collapse puts it at 116; 183 is what is left when
  // the child moves only with the part of the collapse that happened after it
  // existed. Its y drifted 106→198 on a frame whose stated and final height
  // were both 140, which is what a box that was not the authored one looks
  // like from the inside. So a parent keeps the size the spec stated while its
  // subtree is built, and its collapse comes after — every change to the box
  // then re-anchors the child, and MAX deltas telescope to the full 296→174.
  // A LEAF defers nothing: its sizing is written where it always was, inside
  // applyPostAppendProperties.
  const node = await createSingleNode(
    spec,
    parent,
    writer,
    warnings,
    placed,
    { deferSizing: hasChildren },
  )
  // Pushed BEFORE the children recurse, so the order is root-first depth-first.
  created?.push(node.id)

  // B35 + T4: this level's children collect here and are reported ONCE, by the
  // parent that placed them. Read after the loop AND after this node's own
  // resize, so the x/y each child is judged on is the one it ended the level
  // with — an auto-layout that centres or space-betweens moves every earlier
  // child as later ones arrive, and a FILL collapse re-anchors them all.
  const childPlacements: Placement[] = []
  if (hasChildren && 'appendChild' in node) {
    for (const childSpec of children as Record<
      string,
      unknown
    >[]) {
      await createTreeNode(
        childSpec,
        node as ParentNode,
        writer,
        refs,
        refStack,
        created,
        warnings,
        childPlacements,
      )
    }
  }

  if (hasChildren) {
    // The deferred FILL/HUG resize. Every child of this node is placed and
    // carries its constraints now, so Figma re-anchors them as the box changes
    // — which is exactly what a MAX/MAX child of a shrinking NONE-layout frame
    // asked for. Outside the `'appendChild' in node` guard on purpose: a node
    // that could not take the children it stated still has a sizing to honour.
    applySizing(node as FrameNode, spec.sizing, warnings)
    // B69 — and FIXED freezes the box the hug just produced, it does not
    // restore the one the spec stated. So the stated size goes back on, on the
    // axes the caller explicitly pinned. Between the sizing and the verify on
    // purpose: the pin is what makes the resize stick, and the verify has to
    // judge the box this node actually ends with.
    repinFixedSize(
      node as unknown as SizeTarget,
      spec.size,
      spec.sizing,
      warnings,
    )
    // B61 — and only NOW is this node's box the one it will keep, so only now
    // can the stated size be judged. A layout-bearing frame that stated both a
    // size and a layout is hugged away here, silently, unless this says so.
    verifyCreatedSize(
      node as unknown as SizeTarget,
      spec.size,
      warnings,
      spec.sizing,
    )
  }

  if (childPlacements.length > 0) {
    const discarded = discardedPositionsWarning(
      node,
      childPlacements,
    )
    if (discarded !== undefined) {
      warnings?.push(discarded)
    }
  }

  return node
}

// Apply per-variable metadata (aliases / scopes / codeSyntax /
// hiddenFromPublishing) — the SHARED apply path mirroring update_variables'
// per-variable edits, used by create_variables so create reaches parity with
// update. Each member is feature-detected and degrades with a warning (T7),
// never throwing. `aliases` maps a mode NAME → target variable id; that mode is
// set to a VARIABLE_ALIAS of the target via setValueForMode (async target read).
const applyVariableMeta = async (
  variable: Variable,
  meta: {
    name: string
    aliases?: Record<string, string>
    scopes?: string[]
    codeSyntax?: Record<string, string>
    hiddenFromPublishing?: boolean
  },
  // I70 — the collection's modes, not a name→id map: a mode reference resolves
  // by NAME first and by ID second (variable-modes.ts), so an id that came out
  // of a read still lands instead of being skipped as an unknown mode.
  modes: readonly ModeLike[],
  warnings: string[],
): Promise<void> => {
  if (meta.aliases !== undefined) {
    const aliasFactory = (
      figma.variables as VariablesAPI & {
        createVariableAlias?: (v: Variable) => VariableAlias
      }
    ).createVariableAlias
    for (const [modeName, targetId] of Object.entries(
      meta.aliases,
    )) {
      const modeId = modeIdFor(modeName, modes)
      if (modeId === undefined) {
        warnings.push(
          'unknown mode "' +
            modeName +
            '" for variable "' +
            meta.name +
            '" alias; skipped',
        )
        continue
      }
      if (
        typeof aliasFactory !== 'function' ||
        typeof variable.setValueForMode !== 'function'
      ) {
        warnings.push(
          'createVariableAlias unavailable; alias for "' +
            meta.name +
            '" not set',
        )
        continue
      }
      try {
        const target =
          await figma.variables.getVariableByIdAsync(
            targetId,
          )
        if (!target) {
          warnings.push(
            'alias target not found: ' +
              targetId +
              ' for variable "' +
              meta.name +
              '"',
          )
          continue
        }
        variable.setValueForMode(
          modeId,
          aliasFactory(target),
        )
      } catch (e) {
        warnings.push(
          'alias not set for variable "' +
            meta.name +
            '" mode "' +
            modeName +
            '": ' +
            String(e),
        )
      }
    }
  }
  if (meta.scopes !== undefined) {
    try {
      variable.scopes = meta.scopes as VariableScope[]
    } catch (e) {
      warnings.push(
        'scopes not settable on "' +
          meta.name +
          '": ' +
          String(e),
      )
    }
  }
  if (meta.codeSyntax !== undefined) {
    if (
      typeof variable.setVariableCodeSyntax === 'function'
    ) {
      for (const [platform, value] of Object.entries(
        meta.codeSyntax,
      )) {
        try {
          variable.setVariableCodeSyntax(
            platform as CodeSyntaxPlatform,
            value,
          )
        } catch (e) {
          warnings.push(
            'codeSyntax not set (' +
              platform +
              ') on "' +
              meta.name +
              '": ' +
              String(e),
          )
        }
      }
    } else {
      warnings.push(
        'setVariableCodeSyntax unavailable; codeSyntax not set on "' +
          meta.name +
          '"',
      )
    }
  }
  if (meta.hiddenFromPublishing !== undefined) {
    try {
      variable.hiddenFromPublishing =
        meta.hiddenFromPublishing
    } catch (e) {
      warnings.push(
        'hiddenFromPublishing not settable on "' +
          meta.name +
          '": ' +
          String(e),
      )
    }
  }
}

// Resolve ONE node id, for every entry point that takes one. Plain scene-node
// ids go through getNodeByIdAsync. A COMPOUND instance-child id
// ("I<inst>;<child>", e.g. a SLOT inside an instance) is NOT resolvable that
// way — the call reaches for Figma's network and hangs (live-verified
// 2026-07-17), which offline is a "check your internet connection" error on an
// id the document already holds (B34). Those resolve through the leading
// instance instead: see resolve-node.ts for the two id families and why a walk
// alone cannot answer both (B53).
//
// Every tool interface stays as it was (T6): the two forms are the same
// parameter, and which one the caller holds is not something it should have to
// know. An instance sublayer's id is compound whenever it has an instance above
// it, and that id is exactly what the previous read handed the agent — so every
// entry that takes a caller-supplied SCENE-NODE id resolves through here, read
// and write alike. There is no third rule and no exception list to remember:
// the entries below that still call getNodeByIdAsync do so because what they
// hold is NOT a sublayer address, never because the defect was thought unlikely
// to reach them.
//
// The write half was the sharper failure. The bare call does not always fail:
// live 2026-08-17, `update_node` on `I298:7524;298:7511` answered "Unable to
// establish connection to Figma after 10 seconds" and then SUCCEEDED on retry.
// A resolve that depends on the network is a coin flip, and a coin flip under
// an apply-or-warn contract is worse than a refusal — the caller cannot tell a
// node that would not take the write from one the plugin never reached.
//
// NOT routed, deliberately: page ids (`set_current_page`, `duplicate_page`,
// search's `pageId`) are never compound; a component/style/variable id is not a
// node id at all; the rollback resolver only ever sees ids this plugin minted;
// and the change-feed's `writeScope` already refuses anything but a plain
// `<n>:<n>` before it resolves (feed/write-scope.ts, PLAIN_NODE_ID).
const nodeResolver = createNodeResolver({
  getNodeById: async id =>
    (await figma.getNodeByIdAsync(
      id,
    )) as unknown as LiveNode | null,
  exportOf: async node => {
    const raw = await (
      node as unknown as SceneNode
    ).exportAsync({ format: 'JSON_REST_V1' })
    const doc = (raw as unknown as Record<string, unknown>)
      .document
    return typeof doc === 'object' && doc !== null
      ? (doc as RawNode)
      : undefined
  },
})

const resolveNodeId = async (
  nodeId: string,
): Promise<BaseNode | null> =>
  (await nodeResolver.resolve(
    nodeId,
  )) as unknown as BaseNode | null

/**
 * One node's read, from the node itself or from its ancestor's export.
 *
 * `undefined` means no such node — the caller words the miss, because get_node
 * and get_nodes spell it differently.
 *
 * The second route exists because a handle is not always usable. Content inside
 * a slot-hosted INSTANCE has an address Figma composed from a stale parent id,
 * so every property read on it throws, `exportAsync` included. The export of
 * the instance above it already describes that node — the parent read serves it
 * from there — so a direct read of the same id serves it the same way, with the
 * same `readError` on it. An id a read EMITS is an id a read RESOLVES (T2), and
 * reading a node on its own must not say less than reading it through its
 * parent.
 */
const readNodeDocument = async (
  nodeId: string,
  depth: number,
): Promise<unknown | undefined> => {
  /**
   * The node as its ancestor's export describes it, enriched by whatever the
   * live handle will still answer.
   *
   * A slice is a DEGRADED read, and `declareDegradedRead` is what makes it say
   * so — see resolve-node.ts for why a silent thin row is the one outcome this
   * fallback must never produce.
   */
  const slice = async (
    live: BaseNode | null,
    reason: string,
  ): Promise<Record<string, unknown> | undefined> => {
    const exported = await nodeResolver.exportedNode(nodeId)
    if (exported === undefined) return undefined
    // The index is reused for the length of the dispatch and enrichDocument
    // merges into the object it is given, so the read gets its own copy.
    const doc = JSON.parse(
      JSON.stringify(exported),
    ) as Record<string, unknown>
    await enrichDocument(
      (live ?? {}) as unknown as LiveNode,
      doc,
      depth,
      enrichDeps(),
    )
    declareDegradedRead(doc, reason)
    return doc
  }
  const node = await resolveNodeId(nodeId)
  if (node === null) {
    return slice(null, slicedReadMessage(nodeId))
  }
  try {
    return await exportNodeDocument(node, depth)
  } catch (err) {
    const sliced = await slice(
      node,
      err instanceof Error ? err.message : String(err),
    )
    // No export to fall back on — the failure is the answer, not a miss.
    if (sliced === undefined) throw err
    return sliced
  }
}

// resolveStyle: shared helper for update_styles and delete_styles.
// Looks up a BaseStyle by `id` (direct async lookup) or by `name`+`type`
// (linear scan of the matching local-style lister). Returns null when not found.
//
// Deliberately NOT the cached `bindingLookups.styleByName` an inline
// `style(Name)` write uses: these two tools RENAME and DELETE styles entry by
// entry, so a scan cached across one dispatch would answer a later entry from a
// document that no longer exists. Binding never mutates the style table, which
// is what makes caching safe there and not here.
const resolveStyle = async (entry: {
  id?: string
  name?: string
  type?: StyleCategory
}): Promise<BaseStyle | null> => {
  if (entry.id !== undefined) {
    return figma.getStyleByIdAsync(entry.id)
  }
  if (
    entry.name === undefined ||
    entry.type === undefined
  ) {
    return null
  }
  const listers = {
    paint: figma.getLocalPaintStylesAsync,
    text: figma.getLocalTextStylesAsync,
    effect: figma.getLocalEffectStylesAsync,
    grid: figma.getLocalGridStylesAsync,
  }
  const list = await listers[entry.type]()
  return (
    (list as BaseStyle[]).find(
      s => s.name === entry.name,
    ) ?? null
  )
}

const handleCommand = async (
  command: string,
  params: Record<string, unknown>,
  writer: string,
): Promise<unknown> => {
  // Name lookups are cached for the length of ONE dispatch: a tree pays for one
  // enumeration, and the next command still sees variables/styles this one (or
  // the designer) created. A batch re-dispatches per op, so each op re-reads.
  bindingLookups.reset()
  // Same bound, same reason, for the exports that resolve a compound id: a
  // multi-id read pays for one export per instance, and a write in the previous
  // command can never be answered from a document that predates it.
  nodeResolver.reset()
  switch (command) {
    case 'get_document_info':
      return {
        name: figma.root.name,
        currentPage: {
          id: figma.currentPage.id,
          name: figma.currentPage.name,
        },
      }

    // close_plugin (internal lifecycle command, NOT an MCP tool — see overview
    // Connection lifecycle): tear down via figma.closePlugin() so the dev
    // rebuild → close → reopen reload loop picks up new code. Fire-and-forget —
    // closePlugin() severs the connection, so the caller detects closure by the
    // command/STATUS timing out, not by an ack (which would race iframe
    // teardown). The return is best-effort and usually unreached.
    case 'close_plugin': {
      const closeMessage =
        typeof params.message === 'string'
          ? params.message
          : undefined
      figma.closePlugin(closeMessage)
      return { closing: true }
    }

    // status (D1): the LIVE context the user is looking at — current page,
    // selection, and viewport. Connection state (connected/channel) is added
    // SERVER-side; this case supplies only the plugin-known live context. This
    // is the documented READ path for the viewport (set_focus is the writer).
    case COMMANDS.STATUS:
      return {
        currentPage: {
          id: figma.currentPage.id,
          name: figma.currentPage.name,
        },
        selection: figma.currentPage.selection.map(n => ({
          id: n.id,
          name: n.name,
          type: n.type,
        })),
        viewport: {
          center: figma.viewport.center,
          zoom: figma.viewport.zoom,
        },
      }

    case COMMANDS.GET_SELECTION:
      return figma.currentPage.selection.map(node => ({
        id: node.id,
        name: node.name,
        type: node.type,
      }))

    // set_selection: SELECTION ONLY (does not scroll — pair with set_focus).
    // Resolves the ids to scene nodes on the current page; ids that don't
    // resolve to a selectable scene node are skipped. Returns {selectedCount}.
    case COMMANDS.SET_SELECTION: {
      const ids = (params.nodeIds as string[]) ?? []
      const nodes: SceneNode[] = []
      const skipped: string[] = []
      const offPage: string[] = []
      for (const id of ids) {
        const n = await resolveNodeId(id)
        // Only scene nodes are selectable; `visible` is present on every
        // SceneNode and absent on PAGE/DOCUMENT, so it's a sound guard.
        if (!n || !('visible' in n)) {
          skipped.push(id)
          continue
        }
        // getNodeByIdAsync resolves nodes on ANY page, but the selection can
        // only hold nodes on the current page. T7: a cross-page id degrades to
        // a warning (skipped) rather than throwing on assignment.
        const sn = n as SceneNode
        let onCurrentPage = false
        let walk: BaseNode | null = sn
        while (walk !== null) {
          if (walk === figma.currentPage) {
            onCurrentPage = true
            break
          }
          walk = walk.parent
        }
        if (onCurrentPage) {
          nodes.push(sn)
        } else {
          offPage.push(id)
        }
      }
      figma.currentPage.selection = nodes
      const warnings: string[] = []
      if (skipped.length > 0) {
        warnings.push(
          'skipped ' +
            skipped.length +
            ' unresolved id(s): ' +
            skipped.join(', '),
        )
      }
      if (offPage.length > 0) {
        warnings.push(
          'skipped ' +
            offPage.length +
            ' cross-page id(s) not on the current page: ' +
            offPage.join(', '),
        )
      }
      return { selectedCount: nodes.length, warnings }
    }

    case COMMANDS.GET_NODE: {
      // B34/B53 — readNodeDocument, not getNodeByIdAsync: a compound
      // instance-child id is what the previous read handed the agent, and
      // resolving it the bare way reaches for the network and times out.
      //
      // The read's own depth bounds the enrichment: every node get_node
      // returns COMPLETE is enriched, and nothing past it (the server stubs
      // those). Default 0 — the node alone — matching the server's own.
      const doc = await readNodeDocument(
        params.nodeId as string,
        readDepth(params),
      )
      if (doc === undefined) {
        return { error: 'Node not found: ' + params.nodeId }
      }
      return doc
    }

    // inspect returns the SAME raw export the reader consumes; the server's
    // read model decides depth/budget. Resolves nodeId → pageId → current
    // selection → current page. With no nodeId/pageId and a MULTI-node
    // selection it returns an ARRAY of raw exports (one per selected node); the
    // server wraps those in a SELECTION forest so depth/budget/receipt bound the
    // whole set. A single selected node returns that node's export; an empty
    // selection falls back to the current page.
    case COMMANDS.INSPECT: {
      let target: BaseNode | null = null
      if (params.nodeId !== undefined) {
        // Same route as get_node: a slot-hosted id resolves, and one whose
        // live handle cannot describe itself is served from the export.
        const doc = await readNodeDocument(
          params.nodeId as string,
          readDepth(params),
        )
        if (doc === undefined) {
          return {
            error: 'Node not found: ' + params.nodeId,
          }
        }
        return doc
      }
      if (params.pageId !== undefined) {
        target = await resolveNodeId(
          params.pageId as string,
        )
      } else {
        const sel = figma.currentPage.selection
        if (sel.length > 1) {
          // Multi-selection → forest of all selected nodes. Resolve every
          // export before returning (each exportNodeDocument is async).
          // Each selected node is its own root, so each gets the depth the
          // caller asked for — the server's +1 for the synthetic SELECTION
          // wrapper is a server-side concern and is already accounted for in
          // the depth it sends.
          return Promise.all(
            sel.map(node =>
              exportNodeDocument(node, readDepth(params)),
            ),
          )
        }
        target =
          sel.length === 1 ? sel[0] : figma.currentPage
      }
      if (!target) {
        return {
          error:
            'Node not found: ' + (params.pageId as string),
        }
      }
      // inspect sends an ALREADY-RESOLVED depth (a budget-only read resolves
      // to -1 there, because that is how deep the budget fill may reach).
      return exportNodeDocument(target, readDepth(params))
    }

    // get_nodes: one entry per id — a raw export (the same shape get_node /
    // inspect return, which the server's toNodeSpec consumes) or {id, error}
    // for a miss. The server splits them into {results, errors[]}.
    case COMMANDS.GET_NODES: {
      const nodeIds = (params.nodeIds as string[]) || []
      return Promise.all(
        nodeIds.map(async nodeId => {
          // Per id, not per call (T7): one id that cannot be read costs its
          // own row and nothing else. Search hydrates its result page through
          // here, so one bad row used to cost the whole page of fields.
          try {
            // Each explicitly-requested id is its own root, at the one depth
            // the call carries.
            const doc = await readNodeDocument(
              nodeId,
              readDepth(params),
            )
            return (
              doc ?? { id: nodeId, error: 'Node not found' }
            )
          } catch (err) {
            return {
              id: nodeId,
              error:
                err instanceof Error
                  ? err.message
                  : String(err),
            }
          }
        }),
      )
    }

    // list_pages: document + page enumeration (Rule A; bounded). The server
    // wraps this in { docName, results, truncated:false }.
    case COMMANDS.LIST_PAGES:
      return {
        docName: figma.root.name,
        results: figma.root.children.map(page => ({
          id: page.id,
          name: page.name,
          isCurrent: page.id === figma.currentPage.id,
          childCount: page.children
            ? page.children.length
            : 0,
        })),
      }

    case COMMANDS.EXPORT: {
      const exportNode = (await resolveNodeId(
        params.nodeId as string,
      )) as SceneNode | null
      if (!exportNode) {
        return { error: 'Node not found: ' + params.nodeId }
      }
      const exportFormat =
        (params.format as 'PNG' | 'JPG' | 'SVG' | 'PDF') ||
        'PNG'
      const exportScale = (params.scale as number) || 1
      const bytes = await exportNode.exportAsync({
        format: exportFormat,
        constraint: { type: 'SCALE', value: exportScale },
      })
      const data =
        exportFormat === 'SVG'
          ? bytesToString(bytes)
          : bytesToBase64(bytes)
      return {
        format: exportFormat,
        scale: exportScale,
        data,
      }
    }

    // get_styles: each entry carries the raw figma VALUE the server renders to
    // a view atom (paint→hex, text→font, effect/grid→head). Uses the ASYNC
    // style getters; the server applies the type/id filters.
    //
    // `values` carries the style's WHOLE content — every paint, every effect,
    // every grid. A style owns its field, so what it supplies is a list, and
    // `value` (the first entry) cannot answer whether the resolved list a write
    // carried is the one the style holds. The get_styles READ still renders
    // `value`; `values` is what the styled-field write face resolves against.
    case COMMANDS.GET_STYLES: {
      const paintStylesRaw =
        await figma.getLocalPaintStylesAsync()
      const paint = paintStylesRaw.map(s => ({
        id: s.id,
        name: s.name,
        value: s.paints[0],
        values: [...s.paints],
        ...(s.description
          ? { description: s.description }
          : {}),
      }))
      const textStylesRaw =
        await figma.getLocalTextStylesAsync()
      const text = textStylesRaw.map(s => ({
        id: s.id,
        name: s.name,
        value: {
          family: s.fontName.family,
          style: s.fontName.style,
          size: s.fontSize,
          lineHeight: s.lineHeight,
          letterSpacing: s.letterSpacing,
        },
        ...(s.description
          ? { description: s.description }
          : {}),
      }))
      const effectStylesRaw =
        await figma.getLocalEffectStylesAsync()
      const effect = effectStylesRaw.map(s => ({
        id: s.id,
        name: s.name,
        value: s.effects[0],
        values: [...s.effects],
        ...(s.description
          ? { description: s.description }
          : {}),
      }))
      // One grid → the wire shape, so `value` and every entry of `values`
      // are shaped by the same function (Infinity has no JSON spelling —
      // an auto count crosses as the string 'auto').
      const wireGrid = (g: LayoutGrid) => ({
        pattern: g.pattern,
        alignment:
          'alignment' in g
            ? (g as RowsColsLayoutGrid).alignment
            : undefined,
        count:
          'count' in g
            ? (g as RowsColsLayoutGrid).count === Infinity
              ? 'auto'
              : (g as RowsColsLayoutGrid).count
            : undefined,
        sectionSize:
          'sectionSize' in g
            ? (g as RowsColsLayoutGrid).sectionSize
            : undefined,
        gutterSize:
          'gutterSize' in g
            ? (g as RowsColsLayoutGrid).gutterSize
            : undefined,
        offset:
          'offset' in g
            ? (g as RowsColsLayoutGrid).offset
            : undefined,
        visible: g.visible,
      })
      const gridStylesRaw =
        await figma.getLocalGridStylesAsync()
      const grid = gridStylesRaw.map(s => {
        const grids = s.layoutGrids ?? []
        const g = grids[0] as LayoutGrid | undefined
        return {
          id: s.id,
          name: s.name,
          value: g ? wireGrid(g) : undefined,
          values: grids.map(wireGrid),
          ...(s.description
            ? { description: s.description }
            : {}),
        }
      })
      return { paint, text, effect, grid }
    }

    // get_components: rich per-entry shape — key, type, page, the full
    // componentPropertyDefinitions (incl. variantOptions for VARIANT), the
    // variant axes, and the per-property defaults. The server applies the
    // name query filter.
    case COMMANDS.GET_COMPONENTS: {
      // The containing PAGE's name. A component is routinely organised
      // inside a frame or section (the normal UI-kit layout), not parented
      // directly to the page, so walk ancestors up to the first PAGE
      // instead of checking only the immediate parent.
      const pageNameOf = (
        node: BaseNode,
      ): string | null => {
        let p: BaseNode | null = node.parent
        while (p) {
          if (p.type === 'PAGE') {
            return p.name
          }
          p = p.parent
        }
        return null
      }

      const componentSets = figma.root.findAllWithCriteria({
        types: ['COMPONENT_SET'],
      })
      const components = figma.root.findAllWithCriteria({
        types: ['COMPONENT'],
      })

      // get_components' `properties` projection (READ) — shares
      // projectComponentDefs with update_component (WRITE) so the shape is
      // identical by construction, not convention (read == write, T2).
      const defaultsOf = (
        defs: ComponentPropertyDefinitions,
      ): Record<string, unknown> =>
        Object.fromEntries(
          Object.entries(defs).map(([k, d]) => [
            k,
            d.defaultValue,
          ]),
        )

      // T7 resilience: a ComponentSet with conflicting/incomplete variants makes
      // Figma THROW ("Component set for node has existing errors") when reading
      // variantProperties / componentPropertyDefinitions. Guard EACH set (and
      // each standalone component) individually so one malformed node degrades to
      // a warnings[] entry — naming the node + reason — and every other component
      // still returns, instead of sinking the whole read into {error}.
      const componentWarnings: string[] = []

      const setMap: Record<string, unknown> = {}
      for (const cs of componentSets) {
        // Base identity is read with cheap props that don't throw; the variant
        // projection (which can throw) is layered on inside the try.
        const base = {
          id: cs.id,
          name: cs.name,
          key: cs.key,
          type: cs.type,
          page: pageNameOf(cs),
        }
        try {
          const variantAxes: Record<string, string[]> = {}
          if (cs.children) {
            for (const variant of cs.children) {
              const props = (variant as ComponentNode)
                .variantProperties
              if (props) {
                for (const pkey of Object.keys(props)) {
                  if (!variantAxes[pkey]) {
                    variantAxes[pkey] = []
                  }
                  if (
                    !variantAxes[pkey].includes(props[pkey])
                  ) {
                    variantAxes[pkey].push(props[pkey])
                  }
                }
              }
            }
          }
          const csDefs =
            cs.componentPropertyDefinitions || {}
          setMap[cs.id] = {
            ...base,
            properties: projectComponentDefs(csDefs),
            variantAxes:
              Object.keys(variantAxes).length > 0
                ? variantAxes
                : undefined,
            defaults: defaultsOf(csDefs),
            ...(readContext(cs) !== undefined
              ? { context: readContext(cs) }
              : {}),
            ...(cs.description
              ? { description: cs.description }
              : {}),
          }
        } catch (e) {
          // Degrade: include the set WITHOUT its variant info and warn.
          setMap[cs.id] = {
            ...base,
            ...(readContext(cs) !== undefined
              ? { context: readContext(cs) }
              : {}),
            ...(cs.description
              ? { description: cs.description }
              : {}),
          }
          componentWarnings.push(
            'component set "' +
              cs.name +
              '" (' +
              cs.id +
              ') skipped variant projection: ' +
              String(e),
          )
        }
      }

      const standaloneComponents: unknown[] = []
      for (const comp of components) {
        if (
          comp.parent &&
          comp.parent.type === 'COMPONENT_SET'
        ) {
          continue
        }
        try {
          const compDefs =
            comp.componentPropertyDefinitions || {}
          standaloneComponents.push({
            id: comp.id,
            name: comp.name,
            key: comp.key,
            type: comp.type,
            page: pageNameOf(comp),
            properties: projectComponentDefs(compDefs),
            defaults: defaultsOf(compDefs),
            ...(readContext(comp) !== undefined
              ? { context: readContext(comp) }
              : {}),
            ...(comp.description
              ? { description: comp.description }
              : {}),
          })
        } catch (e) {
          // Degrade: include the component WITHOUT its property info and warn.
          standaloneComponents.push({
            id: comp.id,
            name: comp.name,
            key: comp.key,
            type: comp.type,
            page: pageNameOf(comp),
            ...(readContext(comp) !== undefined
              ? { context: readContext(comp) }
              : {}),
            ...(comp.description
              ? { description: comp.description }
              : {}),
          })
          componentWarnings.push(
            'component "' +
              comp.name +
              '" (' +
              comp.id +
              ') skipped property projection: ' +
              String(e),
          )
        }
      }

      // Remote/library discovery (T10 — the live timeout fix). This walks EVERY
      // instance in the document (findAllWithCriteria(['INSTANCE'])) and resolves
      // each one's mainComponent to index library mains — O(all instances). On a
      // real UI-kit document that exceeds the 30s command timeout, while the
      // LOCAL scan above is cheap. So it is OPT-IN: skipped entirely unless the
      // caller asks for it via includeRemote. Default (false) → remote is empty.
      const includeRemote = params.includeRemote === true
      const remoteMap: Record<
        string,
        {
          key: string
          name: string
          instancesCount: number
          context?: string
          description?: string
        }
      > = {}
      // B8 — scan budget (T10): bounding the O(all-instances) remote-discovery
      // walk to avoid exceeding the 30 s command timeout on large UI-kit docs.
      // Defaults: 2 000 instances scanned, 500 distinct remote mains. The caller
      // may override MAX_INSTANCES via params.maxInstances (optional; no wire-
      // version bump — the field is simply ignored by older servers).
      const MAX_INSTANCES =
        typeof params.maxInstances === 'number' &&
        params.maxInstances > 0
          ? (params.maxInstances as number)
          : 2000
      const MAX_REMOTE_MAINS = 500
      let scanTruncated = false
      let scanned = 0

      if (includeRemote) {
        const instances = figma.root.findAllWithCriteria({
          types: ['INSTANCE'],
        })
        for (const inst of instances) {
          if (
            scanned >= MAX_INSTANCES ||
            Object.keys(remoteMap).length >=
              MAX_REMOTE_MAINS
          ) {
            scanTruncated = true
            break
          }
          scanned++
          const main = inst.mainComponent
          if (main && main.remote) {
            const mkey = main.key
            if (!remoteMap[mkey]) {
              remoteMap[mkey] = {
                key: mkey,
                name: main.name,
                instancesCount: 0,
                ...(readContext(main) !== undefined
                  ? { context: readContext(main) }
                  : {}),
                ...(main.description
                  ? { description: main.description }
                  : {}),
              }
            }
            remoteMap[mkey].instancesCount++
          }
        }
      }

      const localAll = Object.values(setMap).concat(
        standaloneComponents,
      )
      const remoteAll = Object.values(remoteMap)

      // Base reply: always carry local + remote (partial if scan was truncated).
      const reply: {
        local: typeof localAll
        remote: typeof remoteAll
        warnings?: string[]
        scanTruncated?: boolean
        scanned?: number
        found?: number
      } = { local: localAll, remote: remoteAll }

      // warnings[] rides on the success reply only when a node degraded (T7);
      // a clean read carries no `warnings` key — same shape the server expects.
      if (componentWarnings.length > 0) {
        reply.warnings = componentWarnings
      }

      // B8 scan-budget metadata: lets the server surface a truncation WARNING.
      if (scanTruncated) {
        reply.scanTruncated = true
        reply.scanned = scanned
        reply.found = remoteAll.length
      }

      return reply
    }

    // search (Rule A): the plugin SCANS the requested scope and returns the RAW
    // candidate nodes — it does NOT filter, project, or paginate. The SERVER
    // owns match + fields + limit + cursor. We emit { results: [candidate…] }
    // where each candidate carries the fields the server's matcher / projection
    // read (id, name, type, size).
    case COMMANDS.SEARCH: {
      const scope = (params.scope as string) || 'document'

      // I65 — a `scope:'page'` that names no page used to answer
      // "Page not found: undefined": the missing id was forwarded as it
      // arrived and printed back as if the caller had typed it. The
      // neighbouring `inspect({pageId?})` already means the CURRENT page when
      // the id is omitted, and two sibling reads meaning two different things
      // by "this page" is the T1 failure. The choice is stated in the reply's
      // warnings[] — a scope the tool picked is a fact the caller has to see.
      const pageScope = resolvePageScope(
        params.pageId as string | undefined,
        figma.currentPage,
      )

      // Collect the root subtrees to scan based on scope. (selection scope
      // builds its candidates directly below — no shared root.)
      const roots: (BaseNode & ChildrenMixin)[] = []
      if (scope === 'node') {
        const target = await resolveNodeId(
          params.nodeId as string,
        )
        // A typo'd / deleted / non-container nodeId is a genuine not-found,
        // not a zero-match — surface {error} so it is distinguishable (T7).
        if (!target || !('findAll' in target)) {
          return {
            error: 'Node not found: ' + params.nodeId,
          }
        }
        roots.push(target as BaseNode & ChildrenMixin)
      } else if (scope === 'page') {
        if (pageScope.pageId === undefined) {
          return {
            error:
              'search: scope "page" needs a pageId — this document exposes no current page to fall back to.',
          }
        }
        const pageNode = await figma.getNodeByIdAsync(
          pageScope.pageId,
        )
        if (!pageNode || pageNode.type !== 'PAGE') {
          return {
            error: 'Page not found: ' + pageScope.pageId,
          }
        }
        roots.push(pageNode as PageNode)
      } else {
        // document (default): a page may be restricted via pageId.
        const pageId = params.pageId as string | undefined
        if (pageId) {
          const pageNode =
            await figma.getNodeByIdAsync(pageId)
          if (pageNode && pageNode.type === 'PAGE') {
            roots.push(pageNode as PageNode)
          }
        } else {
          for (const page of figma.root.children) {
            roots.push(page)
          }
        }
      }

      const toCandidate = (
        fn: SceneNode,
      ): Record<string, unknown> => ({
        id: fn.id,
        name: fn.name,
        type: fn.type,
        size:
          'width' in fn && 'height' in fn
            ? [
                (fn as SceneNode & { width: number }).width,
                (fn as SceneNode & { height: number })
                  .height,
              ]
            : undefined,
        ...(fn && readContext(fn) !== undefined
          ? { context: readContext(fn) }
          : {}),
      })

      // B2 — depth bounds the SCAN SCOPE (descent depth), NOT the output shape:
      // candidates are still returned as a flat list. -1 (or omitted) scans the
      // whole subtree; 0 scans only the root; N descends N levels. This replaces
      // the former unbounded findAll(() => true) so the agent can cap traversal.
      const rawDepth = params.depth as number | undefined
      const scanDepth =
        rawDepth === undefined ? -1 : rawDepth

      // B3 + B4 — conditional per-candidate metadata collection. These flags are
      // set by the SERVER only when the request actually needs them (a
      // reverse-lookup match key or the `characters` projection), because each
      // is an async/extra-cost per-node call. An unhinted scan pays nothing.
      const collectComponentRef =
        params.collectComponentRef === true
      const collectStyleId = params.collectStyleId === true
      const collectVariableId =
        params.collectVariableId === true
      const collectCharacters =
        params.collectCharacters === true
      const needsEnrich =
        collectComponentRef ||
        collectStyleId ||
        collectVariableId ||
        collectCharacters

      // What the scan could not read, named rather than thrown (T7). A node
      // written into a component SLOT keeps its pre-append id, so the handles
      // below it carry addresses composed from a stale id and refuse — `in
      // get_children: The node … does not exist`. One of those in a
      // document-wide scan used to kill the whole search; then it became a
      // warning, which still LOST the node (B48). Now the failure names the
      // node it was reached THROUGH, and that node's export supplies the whole
      // subtree (the repair pass after the candidate loop). A warning is what
      // is left when even that cannot be done.
      const skipped: string[] = []
      // I65 — the page the tool chose, said first: it explains every row
      // below it, so it belongs above the per-node degrades.
      if (scope === 'page' && pageScope.note !== undefined) {
        skipped.push(pageScope.note)
      }
      // Even the id in a warning has to be read defensively: a stale handle
      // answers NOTHING, its own id included.
      const idOf = (node: BaseNode): string => {
        try {
          return node.id
        } catch {
          return UNREADABLE_NODE
        }
      }

      // The nodes the walk starts from. For a container root (page / node
      // subtree) the root itself is level 0, so its direct children are level
      // 1: a page root is not a candidate (we want its descendants), so the
      // descent starts at each child and depth=0 yields the page's immediate
      // children. For `selection` the selected nodes ARE level 0.
      const starts: SceneNode[] = []
      if (scope === 'selection') {
        for (const sel of figma.currentPage.selection) {
          starts.push(sel)
        }
      } else {
        for (const root of roots) {
          // A root is a node too: listing its children reads it, so a root
          // that has gone stale degrades like any other node instead of
          // aborting the scan of the roots beside it.
          try {
            if ('children' in root) {
              for (const child of (root as ChildrenMixin)
                .children) {
                starts.push(child)
              }
            }
          } catch (err) {
            skipped.push(
              'search: skipped the children of ' +
                idOf(root) +
                ': ' +
                messageOf(err),
            )
          }
        }
      }

      // The walk itself lives in search-scan.ts, where it can be run against a
      // fake document — `code.ts` cannot be imported outside Figma, and B62
      // was a one-word defect in this recursion that nothing could see. A -1
      // host there means nothing covers the failure: a scan START has no
      // ancestor in `scanned`, so a failure on one stays a warning.
      const { scanned, failures } = scanFrom(
        starts,
        scanDepth,
      )

      // Enrich the flat candidate list. The base candidate (id/name/type/size)
      // is cheap and always present; the reverse-lookup metadata + characters
      // are attached only when hinted (B3/B4) so the server's buildMatcher can
      // filter and projectNode can map `characters`.
      // A candidate that cannot be READ is skipped and named (into `skipped`
      // above), never thrown: one broken node costs one candidate, not the
      // scan.
      const candidates: (
        | Record<string, unknown>
        | undefined
      )[] = []
      for (let index = 0; index < scanned.length; index++) {
        const fn = scanned[index].node
        candidates.push(undefined)
        try {
          const candidate = toCandidate(fn)

          if (needsEnrich) {
            // B4 — characters: TEXT nodes expose their text content as a flat
            // string for copy-inventory scans (non-text nodes leave it undefined).
            if (collectCharacters && fn.type === 'TEXT') {
              candidate.characters = (
                fn as TextNode
              ).characters
            }

            // B3 — instancesOf / componentKey: resolve the INSTANCE's main
            // component (async). `instancesOf` matches by the main component's
            // NAME; `componentKey` matches by its KEY. Failures degrade silently
            // (the candidate simply won't match those keys).
            if (
              collectComponentRef &&
              fn.type === 'INSTANCE'
            ) {
              const main = await (fn as InstanceNode)
                .getMainComponentAsync()
                .catch(() => null)
              if (main) {
                candidate.componentKey = main.key
                candidate.instancesOf = main.name
                // B56 — a VARIANT's own name is `State=Error`; the FAMILY is
                // named on its set (`State block`), and the set name is the
                // only one a human ever sees. The matcher tests both, so carry
                // both. Guarded on its own: the candidate must not be lost
                // because a parent read threw.
                const set = componentSetOf(main)
                if (set !== undefined) {
                  candidate.instancesOfSet = set
                }
              }
            }

            // B3 — styleId: any of the node's style references. The server's
            // matcher tests a single `styleId`, so expose the bound style ids and
            // let buildMatcher match if ANY equals the requested id (see match.ts).
            if (collectStyleId) {
              const styleIds: string[] = []
              const g = fn as Partial<{
                fillStyleId: string | symbol
                strokeStyleId: string | symbol
                effectStyleId: string | symbol
                gridStyleId: string | symbol
                textStyleId: string | symbol
              }>
              for (const key of [
                'fillStyleId',
                'strokeStyleId',
                'effectStyleId',
                'gridStyleId',
                'textStyleId',
              ] as const) {
                const v = g[key]
                // figma.mixed is a symbol; only collect concrete string ids.
                if (typeof v === 'string' && v.length > 0) {
                  styleIds.push(v)
                }
              }
              if (styleIds.length > 0) {
                candidate.styleIds = styleIds
              }
            }

            // B3 — variableId: the ids bound on the node via boundVariables.
            // boundVariables maps a field → VariableAlias{id} (or an array of
            // them for paints/strokes). Flatten every bound id so the matcher can
            // match if ANY equals the requested variableId.
            if (
              collectVariableId &&
              'boundVariables' in fn
            ) {
              const bound = (
                fn as SceneNode & {
                  boundVariables?: Record<string, unknown>
                }
              ).boundVariables
              if (bound) {
                const ids: string[] = []
                const pushAlias = (a: unknown): void => {
                  const id = (a as { id?: string } | null)
                    ?.id
                  if (typeof id === 'string') {
                    ids.push(id)
                  }
                }
                for (const val of Object.values(bound)) {
                  if (Array.isArray(val)) {
                    for (const a of val) {
                      pushAlias(a)
                    }
                  } else {
                    pushAlias(val)
                  }
                }
                if (ids.length > 0) {
                  candidate.variableIds = ids
                }
              }
            }
          }

          candidates[index] = candidate
        } catch (err) {
          // `idOf`, not `fn.id`: the scan read this id once, but the node can
          // go stale between the walk and the enrichment.
          failures.push({
            at: index,
            host: scanned[index].parentIndex,
            message:
              'search: skipped ' +
              idOf(fn) +
              ': ' +
              messageOf(err),
          })
        }
      }

      // B48 — repair, don't just report. A failure above means the live walk
      // reached a node whose address was composed from a stale id (see
      // canonical-ids.ts). The node it was reached THROUGH still reads, and its
      // export names every node under it canonically — so export that host once
      // and let it speak for the subtree the walk could not reach. The decision
      // of what to KEEP from the live scan is repairScan's, and it is
      // deliberately conservative: only a row the export does not name at all
      // is dropped. This call is the only thing this switch case owns — how to
      // ask Figma for one host's export.
      const repaired = await repairScan({
        scanned,
        candidates,
        failures,
        hints: {
          characters: collectCharacters,
          variableIds: collectVariableId,
          componentRef: collectComponentRef,
        },
        // B56 — a repaired INSTANCE names its main by id; `match:{instancesOf}`
        // matches on the NAME. A main component is a plain, top-level node, so
        // its handle answers even when the instance's own sublayers do not.
        componentRefOf: collectComponentRef
          ? async componentId => {
              const main =
                await figma.getNodeByIdAsync(componentId)
              return main === null
                ? undefined
                : {
                    key: (main as ComponentNode).key,
                    name: main.name,
                    setName: componentSetOf(
                      main as unknown as {
                        name?: unknown
                        parent?: unknown
                      },
                    ),
                  }
            }
          : undefined,
        // The WHOLE export, not just `document` (B56). `components` says what
        // each `componentId` in the subtree is called and which set it belongs
        // to, and `componentSets` names the family — the two maps this call
        // used to drop on the floor, leaving a repaired INSTANCE with an id and
        // no name for it.
        exportHost: async index => {
          try {
            const raw = (await scanned[
              index
            ].node.exportAsync({
              format: 'JSON_REST_V1',
            })) as unknown as Record<string, unknown>
            const document = raw.document
            if (
              typeof document !== 'object' ||
              document === null
            ) {
              return undefined
            }
            return {
              document: document as Record<string, unknown>,
              components:
                raw.components as ExportedHost['components'],
              componentSets:
                raw.componentSets as ExportedHost['componentSets'],
            }
          } catch {
            // The host cannot describe itself either — the failures it would
            // have covered stay warnings.
            return undefined
          }
        },
      })
      skipped.push(...repaired.warnings)

      // warnings[] rides on the SUCCESS reply and is omitted when empty — the
      // same shape every other degrading read answers with.
      const searchReply: {
        results: Record<string, unknown>[]
        warnings?: string[]
      } = { results: repaired.results }
      if (skipped.length > 0) {
        searchReply.warnings = skipped
      }
      return searchReply
    }

    // create_node (M2 single-node): the spec is a FigmaWritePayload already
    // converted on the server's grammar write face (atom leaves parsed; name
    // fallback applied). Resolve parent (parentId, else the current page),
    // create the node by type, apply via applyCommonProperties / (TEXT)
    // applyTextProperties, append, then applyPostAppendProperties (FILL/ABSOLUTE
    // ordering). Children are out of scope (the server strips them) — guard and
    // warn if any slip through; never recurse. Returns {id,name,type,warnings}.
    case COMMANDS.CREATE_NODE: {
      const parentNode =
        params.parentId !== undefined
          ? await resolveNodeId(params.parentId as string)
          : figma.currentPage
      if (!parentNode || !('appendChild' in parentNode)) {
        return {
          error:
            'Parent not found or cannot have children: ' +
            params.parentId,
        }
      }
      const parent = parentNode as ParentNode
      const spec = params.spec as Record<string, unknown>
      const warnings: string[] = []
      if (
        spec.children !== undefined &&
        Array.isArray(spec.children) &&
        (spec.children as unknown[]).length > 0
      ) {
        warnings.push(
          'children ignored — create_node creates a single node; use create_tree (M3) for nested creation',
        )
      }
      try {
        // B35: one node, so the sink can only ever hold one entry — and
        // `discardedPositionsWarning` renders that as the singular sentence.
        const placed: Placement[] = []
        const created = await createSingleNode(
          spec,
          parent,
          writer,
          warnings,
          placed,
        )
        const discarded = discardedPositionsWarning(
          parent,
          placed,
        )
        if (discarded !== undefined) {
          warnings.push(discarded)
        }
        return {
          id: created.id,
          name: created.name,
          type: created.type,
          warnings,
        }
      } catch (err) {
        // T7: a blocked append (e.g. into a non-SLOT instance descendant)
        // returns a clear structured error, not a raw uncaught exception.
        // createSingleNode re-raises the clear slot-fill message (see the
        // appendChild wrap above); surface it directly as { error }.
        return {
          error:
            err instanceof Error
              ? err.message
              : String(err),
        }
      }
    }

    // create_tree (M3 REBUILD): build a nested tree from a converted
    // TreeNodeSpec. params = { tree, parentId?, refs? }. parentId omitted →
    // current page. The recursive builder createTreeNode creates each node by
    // type, appendChild, then applyPostAppendProperties (FILL/ABSOLUTE) per
    // level and loadFontAsync before text. `{ ref }` rebuilds refs[key] fresh;
    // `{ id }` clones the existing node.
    case COMMANDS.CREATE_TREE: {
      const treeParentNode =
        params.parentId !== undefined
          ? await resolveNodeId(params.parentId as string)
          : figma.currentPage
      if (
        !treeParentNode ||
        !('appendChild' in treeParentNode)
      ) {
        return {
          error:
            'Parent not found or cannot have children: ' +
            params.parentId,
        }
      }
      const treeParent = treeParentNode as ParentNode
      const treeSpec = params.tree as Record<
        string,
        unknown
      >
      const treeRefs = params.refs as
        | Record<string, Record<string, unknown>>
        | undefined
      // `createdIds` is the harvest the server answers as `ids[]`: root
      // first, then depth-first in creation order. It is also the rollback
      // ledger, which is why it lives out here — the catch below has to undo
      // exactly what this call made, and it can only know that from here.
      const createdIds: string[] = []
      // Collected across the WHOLE recursion, then answered once on the root's
      // reply — the only reply the caller sees. Omitted when empty so a clean
      // build's envelope stays clean.
      const treeWarnings: string[] = []
      try {
        // B35: the ROOT's own placement. Every deeper level is reported by the
        // parent that placed it, inside createTreeNode — this sink covers the
        // one node no parent in the recursion owns.
        const rootPlaced: Placement[] = []
        const treeResult = await createTreeNode(
          treeSpec,
          treeParent,
          writer,
          treeRefs,
          [],
          createdIds,
          treeWarnings,
          rootPlaced,
        )
        const rootDiscarded = discardedPositionsWarning(
          treeParent,
          rootPlaced,
        )
        if (rootDiscarded !== undefined) {
          treeWarnings.push(rootDiscarded)
        }
        return {
          id: treeResult.id,
          name: treeResult.name,
          type: treeResult.type,
          ids: createdIds,
          ...(treeWarnings.length > 0
            ? { warnings: treeWarnings }
            : {}),
        }
      } catch (err) {
        // T7: a blocked append (e.g. into a non-SLOT instance descendant)
        // returns a clear structured error, not a raw uncaught exception.
        //
        // And the error is the WHOLE answer: overview.md — "either fully
        // succeeds or returns one error envelope — it never partially
        // succeeds". A half-built tree left standing would make that sentence
        // false and hand the caller debris it holds no id for (B14), so every
        // node this call created comes back out before the envelope goes.
        const message =
          err instanceof Error ? err.message : String(err)
        const stranded = await rollbackCreated(
          createdIds,
          id => figma.getNodeByIdAsync(id),
        )
        return {
          error:
            stranded.length > 0
              ? message +
                ' (rollback incomplete — ' +
                stranded.length +
                ' node(s) remain: ' +
                stranded.join(', ') +
                ')'
              : message,
        }
      }
    }

    // create_component (PROMOTE-ONLY, un-overloaded per spec): componentize an
    // existing node via createComponentFromNode(), optionally rename / set
    // description. The build-from-spec overload (+ its orphan cleanup) was
    // removed — build with create_node / create_tree first, then promote.
    case COMMANDS.CREATE_COMPONENT: {
      const ccName = params.name as string | undefined
      const ccDescription = params.description as
        | string
        | undefined
      const found = await resolveNodeId(
        params.nodeId as string,
      )
      if (!found) {
        return {
          error: 'Node not found: ' + params.nodeId,
        }
      }
      const sourceNode = found as SceneNode
      const comp = figma.createComponentFromNode(sourceNode)
      // The component takes the source node's place in the tree, so its
      // closure is the real one at this point.
      writeScope.claim(writer, comp)
      if (ccName !== undefined) comp.name = ccName
      if (ccDescription !== undefined)
        comp.description = ccDescription
      return {
        id: comp.id,
        key: comp.key,
        name: comp.name,
        type: comp.type,
      }
    }

    // update_component: add/edit/delete componentPropertyDefinitions, set the
    // description, and (T7-gated) expose nested instances. Each step is wrapped
    // so a single failure degrades into a warning rather than aborting the rest.
    case COMMANDS.UPDATE_COMPONENT: {
      const compNode = await resolveNodeId(
        params.componentId as string,
      )
      if (!compNode) {
        return {
          error:
            'Component not found: ' + params.componentId,
        }
      }
      if (
        compNode.type !== 'COMPONENT' &&
        compNode.type !== 'COMPONENT_SET'
      ) {
        return {
          error:
            'Node is not a component or component set: ' +
            params.componentId,
        }
      }
      const comp = compNode as
        | ComponentNode
        | ComponentSetNode
      const ucWarnings: string[] = []
      // add. addComponentProperty returns the CANONICAL property id
      // (e.g. "Label#1:0") that agents need for later setProperties. It is
      // surfaced inside the returned `properties` array (the entry's `id`).
      //
      // B3 binding: if targetNodeId is provided, resolve the child and set
      // componentPropertyReferences to bind the property to that node's field.
      // If targetNodeId is absent, warn (T7 honesty: set_instance will be inert).
      // field is inferred from type when omitted: TEXT→characters, BOOLEAN→visible,
      // INSTANCE_SWAP→mainComponent. MERGE into existing refs (never clobber).
      const addProps = params.add as
        | {
            name: string
            type: string
            defaultValue: string | boolean
            targetNodeId?: string
            field?:
              | 'characters'
              | 'visible'
              | 'mainComponent'
          }[]
        | undefined
      if (addProps) {
        for (const p of addProps) {
          try {
            // B70 — an INSTANCE_SWAP default is a component NODE ID, and this
            // surface documented the KEY. Both spellings are accepted; a key
            // is resolved here, before Figma ever sees it.
            const canonicalId = comp.addComponentProperty(
              p.name,
              p.type as ComponentPropertyType,
              (await resolveSwapDefault(
                p.name,
                p.type,
                p.defaultValue,
                ucWarnings,
              )) as string | boolean,
            )
            if (p.targetNodeId) {
              // Resolve the binding after adding the property.
              const child = await resolveNodeId(
                p.targetNodeId,
              )
              if (child === null || child === undefined) {
                ucWarnings.push(
                  'targetNodeId "' +
                    p.targetNodeId +
                    '" not found — property "' +
                    p.name +
                    '" added but binding skipped',
                )
              } else {
                // Infer field from property type when not specified.
                const inferredField =
                  p.field ??
                  (p.type === 'TEXT'
                    ? 'characters'
                    : p.type === 'BOOLEAN'
                      ? 'visible'
                      : 'mainComponent')
                try {
                  const bindable = child as unknown as {
                    componentPropertyReferences?: Record<
                      string,
                      string
                    > | null
                  }
                  const existing =
                    bindable.componentPropertyReferences ??
                    {}
                  ;(
                    child as unknown as {
                      componentPropertyReferences: Record<
                        string,
                        string
                      >
                    }
                  ).componentPropertyReferences = {
                    ...existing,
                    [inferredField]: canonicalId,
                  }
                } catch (e) {
                  ucWarnings.push(
                    'Failed to bind property "' +
                      p.name +
                      '" to node "' +
                      p.targetNodeId +
                      '" field "' +
                      inferredField +
                      '": ' +
                      String(e),
                  )
                }
              }
            } else {
              // T7 honesty: no targetNodeId → property is unbound.
              ucWarnings.push(
                'property "' +
                  p.name +
                  '" added but no targetNodeId given — it is unbound and set_instance will be inert',
              )
            }
          } catch (e) {
            ucWarnings.push(
              'Failed to add property "' +
                p.name +
                '": ' +
                String(e),
            )
          }
        }
      }
      // edit
      const editProps = params.edit as
        | {
            name: string
            newName?: string
            defaultValue?: string | boolean
          }[]
        | undefined
      if (editProps) {
        for (const p of editProps) {
          try {
            const opts: {
              name?: string
              defaultValue?: string | boolean
            } = {}
            if (p.newName !== undefined)
              opts.name = p.newName
            if (p.defaultValue !== undefined) {
              // B70, the same currency one door over. An edit states no type,
              // so it is read off the definition the property already has —
              // and a property this component does not define resolves to no
              // type, which resolves nothing and lets Figma word the refusal.
              opts.defaultValue = (await resolveSwapDefault(
                p.name,
                comp.componentPropertyDefinitions?.[p.name]
                  ?.type,
                p.defaultValue,
                ucWarnings,
              )) as string | boolean
            }
            comp.editComponentProperty(p.name, opts)
          } catch (e) {
            ucWarnings.push(
              'Failed to edit property "' +
                p.name +
                '": ' +
                String(e),
            )
          }
        }
      }
      // delete (M22a). Three ways a removal used to end in silence, all closed:
      //   - the caller passes the bare NAME the reply showed, while the
      //     definitions are keyed by the canonical id — resolvePropertyKey
      //     accepts either, and names the candidates when a name is ambiguous;
      //   - the property does not exist — the refusal lists what does;
      //   - Figma REFUSES the removal without throwing (a SLOT property, a
      //     variant property of a set) — the definitions are re-read after the
      //     call and a survivor is named.
      // Never ok with an unchanged property list and empty warnings (M22).
      const delProps = params.delete as string[] | undefined
      if (delProps) {
        for (const requested of delProps) {
          const found = resolvePropertyKey(
            (comp.componentPropertyDefinitions ??
              {}) as PropertyDefs,
            requested,
          )
          if (found.key === undefined) {
            ucWarnings.push(
              'Failed to delete property: ' + found.error,
            )
            continue
          }
          const { key } = found
          try {
            comp.deleteComponentProperty(key)
          } catch (e) {
            ucWarnings.push(
              'Failed to delete property "' +
                key +
                '": ' +
                String(e),
            )
            continue
          }
          if (
            key in (comp.componentPropertyDefinitions ?? {})
          ) {
            ucWarnings.push(undeletedMessage(key))
          }
        }
      }
      // description
      if (params.description !== undefined) {
        comp.description = params.description as string
      }
      // expose nested instances (T7-gated)
      const exposeIds = params.expose as
        | string[]
        | undefined
      if (exposeIds && exposeIds.length > 0) {
        for (const eid of exposeIds) {
          const en = await resolveNodeId(eid)
          const exposable = en as
            | (InstanceNode & {
                isExposedInstance?: boolean
              })
            | null
          if (
            exposable &&
            'isExposedInstance' in exposable
          ) {
            try {
              ;(
                exposable as { isExposedInstance: boolean }
              ).isExposedInstance = true
            } catch (e) {
              ucWarnings.push(
                'Failed to expose instance "' +
                  eid +
                  '": ' +
                  String(e),
              )
            }
          } else {
            ucWarnings.push(
              'exposeNestedInstances unavailable for "' +
                eid +
                '"; expose skipped',
            )
          }
        }
      }
      // slots: create new empty SLOT nodes (T7-gated).
      // createSlot() takes NO argument — it creates a brand-new empty SLOT node
      // inside the component and returns it (auto-named "Slot"); we name it via
      // the returned node's .name. No pre-existing child needed.
      // createSlot is absent from typings ≤1.123.0 — cast + feature-detect.
      // Guard: createSlot is per-component; skip + warn if comp is a COMPONENT_SET.
      //
      // B30: an entry may also carry a SPEC (already converted server-side).
      // The fresh slot is born 100×100 FIXED with an opaque #FFFFFF fill, so a
      // usable slot otherwise costs two update_node follow-ups. Applying it
      // here runs the SAME pipeline every other write runs — literal fields,
      // then post-append fields, then the bindings an inline var()/style()
      // wrapper asked for. The layout in that spec may be the server's
      // creation default rather than the caller's (B29); nothing here can or
      // need tell them apart.
      const slotEntries = params.slots as
        | SlotEntry[]
        | undefined
      const slotsCreated: string[] = []
      const slotsSkipped: string[] = []
      if (slotEntries && slotEntries.length > 0) {
        const slotNames = slotEntries.map(
          e => readSlotEntry(e).name,
        )
        if (comp.type === 'COMPONENT_SET') {
          for (const name of slotNames) {
            slotsSkipped.push(name)
          }
          ucWarnings.push(
            'createSlot is per-component, not available on COMPONENT_SET; slot(s) skipped: ' +
              slotNames.join(', '),
          )
        } else {
          const compWithSlot = comp as ComponentNode & {
            createSlot?: () => { name: string } | undefined
          }
          if (!compWithSlot.createSlot) {
            for (const name of slotNames) {
              slotsSkipped.push(name)
            }
            ucWarnings.push(
              'createSlot unavailable in this Figma version; slot(s) not created',
            )
          } else {
            for (const entry of slotEntries) {
              const { name, spec } = readSlotEntry(entry)
              // ONLY createSlot itself decides created-vs-skipped. Once it has
              // returned, the SLOT is in the document — naming it, claiming it
              // or applying its spec can all fail without un-creating it, and
              // reporting it as skipped would send the agent looking for a node
              // that is really there (and really unnamed).
              let slot: { name: string } | undefined
              try {
                slot = compWithSlot.createSlot!()
              } catch (e) {
                slotsSkipped.push(name)
                ucWarnings.push(
                  'Failed to create slot "' +
                    name +
                    '": ' +
                    String(e),
                )
                continue
              }
              slotsCreated.push(name)
              if (!slot) {
                continue
              }
              // Every note this slot produces goes to a LOCAL sink and is
              // prefixed with the slot's name before joining the reply: N slots
              // failing the same way would otherwise emit N identical strings
              // and the agent could not tell which one to fix.
              const slotWarnings: string[] = []
              try {
                if (name) slot.name = name
                // createSlot() returns a node already inside the component;
                // the local typing is a minimal { name } shape, hence the
                // cast.
                writeScope.claim(
                  writer,
                  slot as unknown as BaseNode,
                )
              } catch (e) {
                slotWarnings.push(
                  'created, but could not be named: ' +
                    String(e),
                )
              }
              // I60 — where inside the component this slot goes. Done BEFORE
              // the spec is applied, so the layout the spec asks for is written
              // to a node that already sits under its real parent — the same
              // reason B59 moved the clamps past the append.
              const wantedParent = spec?.parentId
              if (typeof wantedParent === 'string') {
                const target =
                  await resolveNodeId(wantedParent)
                const refusal = slotParentRefusal(
                  target as SlotParentNode | null,
                  comp,
                  wantedParent,
                )
                if (refusal !== undefined) {
                  slotWarnings.push(refusal)
                } else {
                  try {
                    ;(
                      target as unknown as ParentNode
                    ).appendChild(
                      slot as unknown as SceneNode,
                    )
                  } catch (e) {
                    slotWarnings.push(
                      'parentId "' +
                        wantedParent +
                        '" refused the slot (' +
                        String(e) +
                        '); it stays at the component root',
                    )
                  }
                }
              }
              if (spec) {
                const slotNode =
                  slot as unknown as SceneNode
                try {
                  await applyCommonProperties(
                    slotNode,
                    spec,
                    comp as ParentNode,
                    slotWarnings,
                    { deferSize: true },
                  )
                  applyPostAppendProperties(
                    slotNode,
                    spec,
                    slotWarnings,
                  )
                  // LAST, and after the sizing above: a slot that states a size
                  // is pinned FIXED by the creation default, and the pin has to
                  // be on the node before the resize can hold (B46).
                  applySizeVerified(
                    slotNode,
                    spec.size,
                    slotWarnings,
                    { statedSizing: spec.sizing },
                  )
                  // Same order as every other write path: literal first,
                  // binding second.
                  await applyWrapperBindings(
                    slotNode as unknown as BindTargetNode,
                    spec.bindings,
                    wrapperBindDeps(),
                    slotWarnings,
                  )
                } catch (e) {
                  slotWarnings.push(
                    'created, but its spec could not be fully applied: ' +
                      String(e),
                  )
                }
                // warn-on-no-op (T7), the same list update_node runs: a field
                // this node type cannot carry was dropped by the appliers'
                // capability guards, and on a slot that silence would hide the
                // headline feature failing (a SLOT without layoutMode would
                // take the layout nowhere and say nothing).
                slotWarnings.push(
                  ...capabilityWarnings(slotNode, spec),
                )
              }
              for (const w of slotWarnings) {
                ucWarnings.push('slot "' + name + '": ' + w)
              }
            }
          }
        }
      }
      // update_component's `properties` projection (WRITE) — shares
      // projectComponentDefs with get_components (READ) so each added property's
      // id is carried in the SAME shape and round-trips get_components by
      // construction (read == write, T2).
      const ucDefs = comp.componentPropertyDefinitions || {}
      const ucProperties = projectComponentDefs(ucDefs)
      return {
        id: comp.id,
        properties: ucProperties,
        slotsCreated,
        slotsSkipped,
        warnings: ucWarnings,
      }
    }

    // combine_variants: combine ≥2 components into a variant set. Resolves the
    // parent (parentId else the first component's parent) and combines. Ids that
    // aren't found / aren't a COMPONENT are DROPPED with a warning (honest
    // partial success — never silently swallowed); a requested parent that can't
    // bear children is also reported rather than silently ignored.
    case COMMANDS.COMBINE_VARIANTS: {
      const cvIds = (params.componentIds as string[]) ?? []
      const cvComps: ComponentNode[] = []
      const cvDropped: string[] = []
      const cvWarnings: string[] = []
      for (const cid of cvIds) {
        const n = await resolveNodeId(cid)
        if (n && n.type === 'COMPONENT') {
          cvComps.push(n as ComponentNode)
        } else {
          cvDropped.push(cid)
        }
      }
      if (cvDropped.length > 0) {
        cvWarnings.push(
          'combine_variants ignored ' +
            cvDropped.length +
            ' id(s) that are not a COMPONENT: ' +
            cvDropped.join(', '),
        )
      }
      if (cvComps.length < 2) {
        return {
          error:
            'Need at least 2 components for combine_variants',
        }
      }
      const cvParentNode =
        params.parentId !== undefined
          ? await resolveNodeId(params.parentId as string)
          : cvComps[0].parent
      let cvParent: BaseNode & ChildrenMixin
      if (cvParentNode && 'appendChild' in cvParentNode) {
        cvParent = cvParentNode as BaseNode & ChildrenMixin
      } else {
        // Fall back to the first component's parent — but only if it can host
        // children. A parentless first component (parent === null) would make
        // combineAsVariants throw an opaque exception, so return a clean
        // {error} instead of casting null to a non-null parent.
        const fallbackParent = cvComps[0].parent
        if (
          !fallbackParent ||
          !('appendChild' in fallbackParent)
        ) {
          return {
            error: 'No valid parent for the variant set',
          }
        }
        if (params.parentId !== undefined) {
          cvWarnings.push(
            'Requested parent "' +
              String(params.parentId) +
              '" cannot contain the variant set; used the first component\'s parent instead.',
          )
        }
        cvParent = fallbackParent as BaseNode &
          ChildrenMixin
      }
      // Multi-axis variant-name warning (T7/T9): Figma derives variant axes from
      // each component NAME via the `Property=Value, Property2=Value2`
      // convention. A name WITHOUT `=` packs its whole value into one anonymous
      // axis (the `Style=PrimaryLarge` class problem), so the set won't form a
      // CLEAN one-property-per-axis grouping. Detect this from the source names
      // before combining and nudge toward one property per axis. (A name with a
      // single comma-free `Prop=Value` pair is the clean single-axis case.)
      const cvUnaxised = cvComps
        .filter(c => !c.name.includes('='))
        .map(c => c.name)
      if (cvUnaxised.length > 0) {
        cvWarnings.push(
          'combine_variants: ' +
            cvUnaxised.length +
            ' component name(s) do not use the "Property=Value" axis convention (' +
            cvUnaxised.join(', ') +
            '); the variant set will not form a clean axis set. Name each variant one property per axis (e.g. "Style=Primary, Size=Large").',
        )
      }
      const cs = figma.combineAsVariants(cvComps, cvParent)
      writeScope.claim(writer, cs)
      if (params.name !== undefined)
        cs.name = params.name as string
      return {
        id: cs.id,
        key: cs.key,
        name: cs.name,
        type: cs.type,
        variantAxes: cs.variantGroupProperties,
        warnings: cvWarnings,
      }
    }

    // swap_component: point an instance at a different main component. Remote-
    // capable: a LOCAL mainComponentId resolves directly (and WINS if both are
    // given); otherwise a `key` is resolved via importComponentByKeyAsync, which
    // is feature-detected + T7-degraded (a failed import warns, never throws).
    // The actual swap also degrades into a warning (T7) — never throw.
    case COMMANDS.SWAP_COMPONENT: {
      const scInst = await resolveNodeId(
        params.instanceId as string,
      )
      if (!scInst) {
        return {
          error: 'Instance not found: ' + params.instanceId,
        }
      }
      if (scInst.type !== 'INSTANCE') {
        return {
          error:
            'Node is not an instance: ' + params.instanceId,
        }
      }
      const scWarnings: string[] = []
      const inst = scInst as InstanceNode
      const scMainId = params.mainComponentId as
        | string
        | undefined
      const scKey = params.key as string | undefined
      let scMain: ComponentNode | null = null
      if (scMainId !== undefined) {
        // LOCAL path (wins if both given).
        const found = await resolveNodeId(scMainId)
        if (!found || found.type !== 'COMPONENT') {
          return {
            error: 'Main component not found: ' + scMainId,
          }
        }
        scMain = found as ComponentNode
      } else if (scKey !== undefined) {
        // REMOTE path: import the component by key (T7 feature-detect/degrade).
        const importer = (
          figma as typeof figma & {
            importComponentByKeyAsync?: (
              key: string,
            ) => Promise<ComponentNode>
          }
        ).importComponentByKeyAsync
        if (typeof importer !== 'function') {
          return {
            id: inst.id,
            mainComponent: null,
            warnings: [
              'importComponentByKeyAsync unavailable in this Figma version; remote swap skipped',
            ],
          }
        }
        try {
          // Deadlined + concurrent: `importer` alone never settles for a key
          // it cannot import, so this catch was previously unreachable.
          scMain = await importComponentByKeyWithDeadline(
            scKey,
            {
              component: k => importer(k),
              set: k =>
                figma.importComponentSetByKeyAsync(k),
            },
          )
        } catch (e) {
          return {
            id: inst.id,
            mainComponent: null,
            warnings: [
              'importComponentByKeyAsync failed for key "' +
                scKey +
                '": ' +
                String(e) +
                '; remote swap skipped',
            ],
          }
        }
      } else {
        return {
          error:
            'swap_component requires mainComponentId (local) or key (remote)',
        }
      }
      try {
        inst.swapComponent(scMain)
      } catch (e) {
        scWarnings.push(
          'swapComponent failed: ' + String(e),
        )
      }
      const swapped = await inst
        .getMainComponentAsync()
        .catch(() => null)
      return {
        id: inst.id,
        mainComponent: swapped ? swapped.id : scMain.id,
        warnings: scWarnings,
      }
    }

    // set_instance: set instance properties via setProperties and/or apply
    // per-node overrides. setProperties failures degrade (T7); per-node override
    // application is limited via the plugin API → warn rather than fail. The
    // RAW Figma inst2.componentProperties ({ [name]:{type,value} }) is echoed
    // back; the SERVER splits it into the read-twin { variantProperties?,
    // componentProperties? } shape (C3 / T2).
    case COMMANDS.SET_INSTANCE: {
      const siInst = await resolveNodeId(
        params.instanceId as string,
      )
      if (!siInst) {
        return {
          error: 'Instance not found: ' + params.instanceId,
        }
      }
      if (siInst.type !== 'INSTANCE') {
        return {
          error:
            'Node is not an instance: ' + params.instanceId,
        }
      }
      const inst2 = siInst as InstanceNode
      const siWarnings: string[] = []
      const siProps = params.properties as
        | Record<string, string | boolean>
        | undefined
      const siOverridesRaw = params.overrides as
        | unknown[]
        | undefined
      // T7: set_instance is a WRITE path. A call with neither properties nor
      // overrides mutates nothing — warn rather than returning a silent no-op
      // success (consistent with the warn-on-no-op convention in update_node).
      if (
        (!siProps || Object.keys(siProps).length === 0) &&
        (!siOverridesRaw || siOverridesRaw.length === 0)
      ) {
        siWarnings.push(
          'no properties or overrides supplied; nothing changed',
        )
      }
      if (siProps && Object.keys(siProps).length > 0) {
        // Resolve friendly property names to the EXACT keys setProperties needs
        // (e.g. "Label" → "Label#1:0"; VARIANT props keep their bare name)
        // against the instance's current keys. Unknown/ambiguous names warn and
        // are skipped rather than failing the whole call.
        const { resolved, warnings: resolveWarnings } =
          resolveInstanceProps(
            siProps,
            Object.keys(inst2.componentProperties),
          )
        for (const w of resolveWarnings) {
          siWarnings.push(w)
        }
        if (Object.keys(resolved).length > 0) {
          try {
            inst2.setProperties(resolved)
          } catch (e) {
            siWarnings.push(
              'setProperties failed: ' + String(e),
            )
          }
        }
      }
      const siOverrides = params.overrides as
        | { path: string; field: string; value: string }[]
        | undefined
      if (siOverrides && siOverrides.length > 0) {
        siWarnings.push(
          'Per-node overrides are not yet applied; ' +
            siOverrides.length +
            ' override(s) skipped',
        )
      }
      return {
        id: inst2.id,
        componentProperties: inst2.componentProperties,
        warnings: siWarnings,
      }
    }

    case COMMANDS.CREATE_FROM_SVG: {
      const svgParent = await resolveNodeId(
        params.parentId as string,
      )
      if (!svgParent || !('appendChild' in svgParent)) {
        return {
          error: 'Parent not found: ' + params.parentId,
        }
      }
      const svgFrame = figma.createNodeFromSvg(
        params.svg as string,
      )
      // Paired with the post-append claim below: createNodeFromSvg returns a
      // frame that already has children but no real parent, so the two
      // claims differ by the ANCESTOR half of the closure.
      writeScope.claim(writer, svgFrame)
      if (params.name) {
        svgFrame.name = params.name as string
      }
      if (params.size) {
        const [w, h] = params.size as [number, number]
        svgFrame.resize(w, h)
      }
      ;(svgParent as FrameNode).appendChild(svgFrame)
      writeScope.claim(writer, svgFrame)
      return {
        id: svgFrame.id,
        name: svgFrame.name,
        type: svgFrame.type,
        childCount: svgFrame.children.length,
      }
    }

    case COMMANDS.UPDATE_NODE: {
      const node = await resolveNodeId(
        params.nodeId as string,
      )
      if (!node) {
        return { error: 'Node not found: ' + params.nodeId }
      }
      const spec = params.spec as Record<string, unknown>
      const warnings: string[] = []
      const parent = node.parent as ParentNode | null

      // warn-on-no-op: x/y on an auto-layout flow child is ignored by Figma.
      if (
        spec.position !== undefined &&
        parent !== null &&
        'layoutMode' in parent &&
        (parent as FrameNode).layoutMode !== 'NONE' &&
        (node as FrameNode).layoutPositioning !== 'ABSOLUTE'
      ) {
        warnings.push(
          'x/y ignored on an auto-layout child (set layoutPositioning:ABSOLUTE first)',
        )
        delete spec.position
      }

      // B58 — this write may complete the SPACE_BETWEEN + bound-gap pair against
      // what the node ALREADY holds. The server refuses the pair when one call
      // carries both halves; only here is the node's current align and gap
      // binding in hand, and reading them costs nothing extra. Refused BEFORE
      // anything is applied, so a rejected update has changed nothing.
      const gapConflict = updateLayoutConflict(
        node as GapConflictNode,
        spec.layout as { align?: unknown } | undefined,
        spec.bindings as
          | { kind?: unknown; field?: unknown }[]
          | undefined,
      )
      if (gapConflict !== undefined) {
        return { error: gapConflict }
      }

      // warn-on-no-op (T7): a patched property that the target node type does
      // not support is dropped by applyCommonProperties' `'X' in node` guards.
      // On update_node the target is arbitrary, so name the dropped field
      // rather than skipping silently. The list is SHARED with the
      // update_component slot loop — the same silence, the same wording.
      warnings.push(...capabilityWarnings(node, spec))

      // warn-on-no-op (T7, B6): the document/root node's .name is read-only in
      // the plugin API — the setter silently no-ops. Renaming the file is
      // impossible via the plugin API, so push an honest warning and drop
      // spec.name so applyCommonProperties skips the no-op assignment.
      if (
        spec.name !== undefined &&
        node.type === 'DOCUMENT'
      ) {
        warnings.push(
          'name ignored — the file/document node cannot be renamed via the Figma plugin API',
        )
        delete spec.name
      }

      // Geometry FIRST, and before applyCommonProperties (B45). Assigning
      // vectorPaths rebuilds the network and resizes the node to the new path
      // bounds, so a `size` stated in the same patch has to be applied after it
      // — the order the create path has always used. A node type that has no
      // vectorPaths at all is named by capabilityWarnings above.
      if (
        spec.vectorPaths !== undefined &&
        'vectorPaths' in node
      ) {
        await applyVectorPaths(
          node as VectorNode,
          spec.vectorPaths,
          warnings,
        )
      }

      await applyCommonProperties(
        node as SceneNode,
        spec,
        parent as ParentNode,
        warnings,
        { deferSize: true },
      )
      if (node.type === 'TEXT' && spec.text !== undefined) {
        await applyTextProperties(
          node as TextNode,
          spec,
          warnings,
        )
      }
      applyPostAppendProperties(
        node as SceneNode,
        spec,
        warnings,
      )
      // Size LAST of the geometry, and PROVEN (B46). Other fields of the same
      // patch move it — the text write, and `sizing` in
      // applyPostAppendProperties — so a resize applied first is not what the
      // caller ends up with, and a read-back taken first is not the patch's
      // outcome. Written here, `{size, sizing:['FIXED','FIXED']}` lands in ONE
      // call, and `{size, sizing:['FILL',…]}` is reported instead of silently
      // handing the axis back. Bindings run after and are allowed to win —
      // literal first, binding second — but none of them writes a size.
      applySizeVerified(
        node as SceneNode,
        spec.size,
        warnings,
        { statedSizing: spec.sizing },
      )
      // Same order as the create path: literal first, binding second.
      await applyWrapperBindings(
        node as unknown as BindTargetNode,
        spec.bindings,
        wrapperBindDeps(),
        warnings,
      )

      return {
        id: node.id,
        name: node.name,
        type: node.type,
        warnings,
      }
    }

    case COMMANDS.BIND_VARIABLE: {
      const node = await resolveNodeId(
        params.nodeId as string,
      )
      if (!node) {
        return { error: 'Node not found: ' + params.nodeId }
      }
      const warnings: string[] = []

      // ── M13: per-collection explicit mode-set ────────────────────────────
      // Process the mode map BEFORE the field-binding branch so a pure mode-set
      // call (no variableId/field) returns immediately after processing.
      const modeMap = params.mode as
        | Record<
            string,
            {
              modeId?: string
              modeName?: string
              clearMode?: boolean
            }
          >
        | undefined

      if (modeMap !== undefined) {
        const modeHost = node as SceneNode & {
          setExplicitVariableModeForCollection?: (
            collection: VariableCollection,
            modeId: string,
          ) => void
          clearExplicitVariableModeForCollection?: (
            collection: VariableCollection,
          ) => void
        }

        for (const [collectionId, entry] of Object.entries(
          modeMap,
        )) {
          try {
            // Resolve the collection OBJECT (not string-id overload which is
            // @deprecated and throws under documentAccess:'dynamic-page').
            const collection =
              await figma.variables.getVariableCollectionByIdAsync(
                collectionId,
              )
            if (!collection) {
              warnings.push(
                'collection not found: ' +
                  collectionId +
                  '; mode pin skipped',
              )
              continue
            }

            if (entry.clearMode === true) {
              // clear-mode path
              if (
                typeof modeHost.clearExplicitVariableModeForCollection !==
                'function'
              ) {
                warnings.push(
                  'clearExplicitVariableModeForCollection unavailable in this Figma version; mode clear skipped for collection ' +
                    collectionId,
                )
                continue
              }
              modeHost.clearExplicitVariableModeForCollection(
                collection,
              )
              continue
            }

            // Resolve modeId from modeId or modeName
            let resolvedModeId: string | undefined =
              entry.modeId
            if (
              resolvedModeId === undefined &&
              entry.modeName !== undefined
            ) {
              const found = (
                collection.modes as {
                  modeId: string
                  name: string
                }[]
              ).find(m => m.name === entry.modeName)
              if (!found) {
                warnings.push(
                  'unknown mode "' +
                    entry.modeName +
                    '" in collection ' +
                    collectionId +
                    '; mode pin skipped',
                )
                continue
              }
              resolvedModeId = found.modeId
            }

            if (resolvedModeId === undefined) {
              warnings.push(
                'mode entry for collection ' +
                  collectionId +
                  ' must specify modeId, modeName, or clearMode; skipped',
              )
              continue
            }

            // Feature-detect (T7): warn+skip if API absent.
            if (
              typeof modeHost.setExplicitVariableModeForCollection !==
              'function'
            ) {
              warnings.push(
                'setExplicitVariableModeForCollection unavailable in this Figma version; mode pin skipped for collection ' +
                  collectionId,
              )
              continue
            }

            // Use the OBJECT overload (not the deprecated string-id overload
            // which throws under documentAccess:'dynamic-page').
            modeHost.setExplicitVariableModeForCollection(
              collection,
              resolvedModeId,
            )
          } catch (e) {
            // Per-entry try/catch: one bad entry never sinks the rest (T7).
            warnings.push(
              'mode pin failed for collection ' +
                collectionId +
                ': ' +
                String(e),
            )
          }
        }
      }

      // If this is a pure mode-set call (no variableId/field), return now.
      if (
        params.variableId === undefined &&
        params.field === undefined
      ) {
        return { id: node.id, warnings }
      }

      // ── Field CLEAR (B58) ────────────────────────────────────────────────
      // Writing a literal over a bound field does NOT unbind it — proven live:
      // `{gap: 16}` on a token-bound bar left `var(space/16)16` in place. So
      // taking a token OFF a field needs its own door, and this is it. It runs
      // BEFORE the variable lookup, because a clear names no variable.
      if (params.clear === true) {
        const clearField = params.field as string
        if (
          clearField === 'fills' ||
          clearField === 'strokes'
        ) {
          // Paint bindings live per PAINT (setBoundVariableForPaint), not on
          // the node field, so this route cannot reach them. Say so (T7)
          // rather than reporting a clear that did not happen.
          return {
            error:
              'bind_variable cannot clear a `' +
              clearField +
              '` binding: paint variables bind per paint, not on the node field. ' +
              'Re-write the paint with a plain atom (no var() wrapper) to replace it.',
          }
        }
        clearNodeField(
          node as unknown as BindTargetNode,
          clearField,
          warnings,
        )
        return { id: node.id, warnings }
      }

      // ── Field binding (original path) ─────────────────────────────────────
      const variable =
        await figma.variables.getVariableByIdAsync(
          params.variableId as string,
        )
      if (!variable) {
        return {
          error: 'Variable not found: ' + params.variableId,
        }
      }
      const field = params.field as string

      // B58 — binding a token to the gap of a SPACE_BETWEEN node builds the
      // self-contradictory pair by the other door: no layout write is involved,
      // and the result is destroyed the first time anyone clicks the node.
      const bindConflict = bindFieldConflict(
        node as GapConflictNode,
        field,
      )
      if (bindConflict !== undefined) {
        return { error: bindConflict }
      }

      // Paint fields (fills/strokes) are NOT members of VariableBindableNodeField,
      // so node.setBoundVariable('fills', v) would throw. They bind per-paint via
      // figma.variables.setBoundVariableForPaint(paint,'color',variable), then the
      // paint array is re-assigned. Feature-detect it (T7): warn+skip if absent.
      //
      // Both routes live in bind-wrappers.ts, because an INLINE `var(name)value`
      // written through create/update binds through the very same code — one
      // binding implementation, one set of degrade messages (T8).
      if (field === 'fills' || field === 'strokes') {
        bindPaintField(
          node as unknown as BindTargetNode,
          field,
          variable,
          paintBindDeps(),
          warnings,
        )
        return { id: node.id, warnings }
      }

      bindNodeField(
        node as unknown as BindTargetNode,
        field,
        variable,
        warnings,
      )
      return { id: node.id, warnings }
    }

    case COMMANDS.GET_VARIABLES: {
      const collectionId = params.collectionId as
        | string
        | undefined
      const collections =
        await figma.variables.getLocalVariableCollectionsAsync()
      const filtered =
        collectionId !== undefined
          ? collections.filter(c => c.id === collectionId)
          : collections
      const results = await Promise.all(
        filtered.map(async c => ({
          id: c.id,
          name: c.name,
          modes: c.modes,
          variables: (
            await Promise.all(
              c.variableIds.map(async id => {
                const v =
                  await figma.variables.getVariableByIdAsync(
                    id,
                  )
                if (!v) {
                  return null
                }
                // B2: aliases — emit a mode-keyed map {modeId: targetId} so
                // the server can translate to {modeName: targetId}, matching
                // the write shape consumed by create/update_variables (T2).
                const aliases: Record<string, string> = {}
                for (const [modeId, val] of Object.entries(
                  v.valuesByMode,
                )) {
                  if (
                    typeof val === 'object' &&
                    val !== null &&
                    (val as { type?: string }).type ===
                      'VARIABLE_ALIAS' &&
                    typeof (val as { id?: unknown }).id ===
                      'string'
                  ) {
                    aliases[modeId] = (
                      val as { id: string }
                    ).id
                  }
                }
                return {
                  id: v.id,
                  name: v.name,
                  resolvedType: v.resolvedType,
                  valuesByMode: v.valuesByMode,
                  aliases,
                  scopes: v.scopes,
                  codeSyntax: v.codeSyntax,
                  hiddenFromPublishing:
                    v.hiddenFromPublishing,
                }
              }),
            )
          ).filter(v => v !== null),
        })),
      )
      return { results }
    }

    // list_fonts: group listAvailableFontsAsync() by family, optionally
    // filtered by a case-insensitive family substring.
    case COMMANDS.LIST_FONTS: {
      const fonts = await figma.listAvailableFontsAsync()
      const byFamily: Record<string, string[]> = {}
      for (const f of fonts) {
        const fam = f.fontName.family
        if (!byFamily[fam]) {
          byFamily[fam] = []
        }
        if (!byFamily[fam].includes(f.fontName.style)) {
          byFamily[fam].push(f.fontName.style)
        }
      }
      let results = Object.keys(byFamily).map(family => ({
        family,
        styles: byFamily[family],
      }))
      const fontQuery = params.query as string | undefined
      if (fontQuery !== undefined) {
        const needle = fontQuery.toLowerCase()
        results = results.filter(r =>
          r.family.toLowerCase().includes(needle),
        )
      }
      return { results }
    }

    // get_reactions: prototype reactions on a node. Degrade (NEVER throw) when
    // the node is missing or has no reactions API.
    case COMMANDS.GET_REACTIONS: {
      const nodeId = params.nodeId as string
      const node = await resolveNodeId(nodeId)
      if (!node) {
        return {
          nodeId,
          reactions: [],
          warnings: ['Node not found: ' + nodeId],
        }
      }
      if ('reactions' in node) {
        return {
          nodeId,
          reactions:
            (node as SceneNode & { reactions: unknown[] })
              .reactions ?? [],
        }
      }
      return {
        nodeId,
        reactions: [],
        warnings: ['Node has no reactions'],
      }
    }

    // get_plugin_data: this plugin's data on a node; shared data when a
    // namespace is given. Degrade (NEVER throw) when the node is missing.
    case COMMANDS.GET_PLUGIN_DATA: {
      const nodeId = params.nodeId as string
      const node = await resolveNodeId(nodeId)
      if (!node || !('getPluginDataKeys' in node)) {
        return {
          nodeId,
          pluginData: {},
          warnings: ['Node not found: ' + nodeId],
        }
      }
      const dataNode = node as BaseNode & PluginDataMixin
      const pluginData = Object.fromEntries(
        dataNode
          .getPluginDataKeys()
          .map(k => [k, dataNode.getPluginData(k)]),
      )
      const namespace = params.namespace as
        | string
        | undefined
      if (namespace !== undefined) {
        const sharedPluginData = Object.fromEntries(
          dataNode
            .getSharedPluginDataKeys(namespace)
            .map(k => [
              k,
              dataNode.getSharedPluginData(namespace, k),
            ]),
        )
        return { nodeId, pluginData, sharedPluginData }
      }
      return { nodeId, pluginData }
    }

    // get_annotations: editorType-gated → degrade (NEVER throw) to an empty
    // Rule-A result with a warning when annotations are unavailable. Annotations
    // live on the NODE (node.annotations), so feature-detect 'annotations' in node.
    case COMMANDS.GET_ANNOTATIONS: {
      const degrade = {
        results: [] as unknown[],
        truncated: false,
        warnings: [
          'Annotations API unavailable in this editor; returning empty.',
        ],
      }
      try {
        const targets: BaseNode[] = []
        const explicit = params.nodeId !== undefined
        if (explicit) {
          const node = await resolveNodeId(
            params.nodeId as string,
          )
          // An explicit, unresolvable nodeId is a genuine not-found — surface
          // it as a warning (T7) so the agent can tell it apart from "node has
          // zero annotations", never a silent empty success.
          if (!node) {
            return {
              results: [],
              truncated: false,
              warnings: [
                'Node not found: ' + params.nodeId,
              ],
            }
          }
          targets.push(node)
        } else {
          for (const sel of figma.currentPage.selection) {
            targets.push(sel)
          }
        }
        // Multi-selection reads tag each annotation with its source nodeId so
        // the flat result remains attributable and can be regrouped/fed back to
        // the single-node set_annotations writer (T2). The single-node path
        // (explicit nodeId / a 1-node selection) stays bare for a clean
        // round-trip.
        const tag = !explicit && targets.length > 1
        const collected: unknown[] = []
        let supported = false
        for (const node of targets) {
          if ('annotations' in node) {
            supported = true
            const anns =
              (
                node as SceneNode & {
                  annotations?: unknown[]
                }
              ).annotations ?? []
            for (const a of anns) {
              collected.push(
                tag
                  ? { ...(a as object), nodeId: node.id }
                  : a,
              )
            }
          }
        }
        if (targets.length > 0 && !supported) {
          return degrade
        }
        return { results: collected, truncated: false }
      } catch {
        return degrade
      }
    }

    // delete_node: capture {id,name,type} BEFORE removing so the reply still
    // describes the now-gone node. Missing node → {error}.
    //
    // PAGE branch (T7 / T1 symmetry):
    //   • Last remaining page → hard {error} — Figma forbids a pageless doc.
    //   • Deleting the current page → auto-switch THEN remove (pure capability;
    //     the switch is required for page.remove() to not throw). Switch rule
    //     (T6/P1 — documented mechanical choice): previous sibling, else next
    //     (pages[idx-1] ?? pages[idx+1]). Feature-detect setCurrentPageAsync:
    //     absent on older runtimes → degrade (warn, skip remove) rather than
    //     letting page.remove() throw.
    //   • Returns {id,name,type,currentPageId} so the new active page is
    //     machine-visible in the reply.
    case COMMANDS.DELETE_NODE: {
      const nodeId = params.nodeId as string
      const node = await resolveNodeId(nodeId)
      if (!node) {
        return { error: 'Node not found: ' + nodeId }
      }
      const info = {
        id: node.id,
        name: node.name,
        type: node.type,
      }
      if (node.type === 'PAGE') {
        const pages = figma.root.children
        if (pages.length <= 1) {
          return {
            error:
              'Cannot delete the last remaining page: ' +
              node.id,
          }
        }
        if (node.id === figma.currentPage.id) {
          if (
            typeof figma.setCurrentPageAsync !== 'function'
          ) {
            return {
              ...info,
              warnings: [
                'setCurrentPageAsync unavailable; current page not switched — remove skipped',
              ],
            }
          }
          const idx = pages.findIndex(p => p.id === node.id)
          const next = pages[idx - 1] ?? pages[idx + 1]
          await figma.setCurrentPageAsync(next as PageNode)
        }
        node.remove()
        return {
          ...info,
          currentPageId: figma.currentPage.id,
        }
      }
      node.remove()
      return info
    }

    // set_focus: scroll + zoom the viewport so the resolved nodes are in view.
    // CANVAS only — does not change selection (pair with set_selection). Ids
    // that don't resolve to a scene node are skipped (same guard as
    // set_selection: 'visible' is on every SceneNode, absent on PAGE/DOCUMENT).
    case COMMANDS.SET_FOCUS: {
      const ids = (params.nodeIds as string[]) ?? []
      const nodes: SceneNode[] = []
      const missing: string[] = []
      for (const id of ids) {
        const n = await resolveNodeId(id)
        if (n && 'visible' in n) {
          nodes.push(n as SceneNode)
        } else {
          missing.push(id)
        }
      }
      figma.viewport.scrollAndZoomIntoView(nodes)
      // T7: ids that don't resolve to a scene node are surfaced in warnings[]
      // (never a silent no-op / hallucinated success). requested/focused let the
      // agent compare against the input even when nothing resolved.
      return {
        viewport: {
          center: figma.viewport.center,
          zoom: figma.viewport.zoom,
        },
        requested: ids.length,
        focused: nodes.length,
        warnings:
          missing.length > 0
            ? [
                'set_focus: ' +
                  missing.join(', ') +
                  ' did not resolve to a scene node and were skipped',
              ]
            : [],
      }
    }

    // clone_node: node.clone() (count times), optionally reparented into
    // parentId at index. Each clone is appended (or inserted) and reported as
    // {id,name,type}. Missing source/parent → {error}.
    case COMMANDS.CLONE_NODE: {
      const srcId = params.nodeId as string
      const source = await resolveNodeId(srcId)
      if (!source || !('clone' in source)) {
        return {
          error:
            'Node not found or not cloneable: ' + srcId,
        }
      }
      const src = source as SceneNode
      let dest: ParentNode | null =
        src.parent as ParentNode | null
      if (params.parentId !== undefined) {
        const p = await resolveNodeId(
          params.parentId as string,
        )
        if (!p || !('appendChild' in p)) {
          return {
            error:
              'Parent not found or cannot have children: ' +
              params.parentId,
          }
        }
        dest = p as ParentNode
      }
      if (!dest) {
        return {
          error: 'No parent to place the clone under.',
        }
      }
      const count = (params.count as number) ?? 1
      const index = params.index as number | undefined
      // Validate index up front so an out-of-range value returns a clean,
      // actionable {error} instead of degrading to a raw RangeError string from
      // insertChild. The first clone inserts at `index`; each later clone grows
      // the list by 1, so `index+i` stays in range once `index` itself is valid.
      if (index !== undefined) {
        const childCount = (
          dest as ParentNode & {
            children: readonly SceneNode[]
          }
        ).children.length
        if (index < 0 || index > childCount) {
          return {
            error:
              'clone_node index ' +
              index +
              ' is out of range for the parent (0..' +
              childCount +
              ')',
          }
        }
      }
      const clones: {
        id: string
        name: string
        type: string
      }[] = []
      for (let i = 0; i < count; i++) {
        const clone = src.clone()
        if (index !== undefined) {
          dest.insertChild(index + i, clone)
        } else {
          dest.appendChild(clone)
        }
        writeScope.claim(writer, clone)
        clones.push({
          id: clone.id,
          name: clone.name,
          type: clone.type,
        })
      }
      return clones
    }

    // reparent_node: move a node under a new parent. insertChild at index when
    // given, else appendChild. For a NON-auto-layout new parent we preserve the
    // child's VISUAL (absolute) position across the move — appendChild keeps the
    // raw relative x/y, which otherwise makes the node jump. For an auto-layout
    // new parent we leave x/y so the node re-flows in the layout. THE PAGE is a
    // non-auto-layout parent too (B55): it carries no absoluteTransform, and
    // treating that as an unknown origin skipped the preservation on the most
    // common move of all — un-nesting to the canvas. reparent-position.ts owns
    // that decision and is unit-tested on its own.
    // Missing node/parent → {error}.
    case COMMANDS.REPARENT_NODE: {
      const nodeId = params.nodeId as string
      const node = await resolveNodeId(nodeId)
      if (!node || !('parent' in node)) {
        return { error: 'Node not found: ' + nodeId }
      }
      const newParent = await resolveNodeId(
        params.parentId as string,
      )
      if (!newParent || !('appendChild' in newParent)) {
        return {
          error:
            'Parent not found or cannot have children: ' +
            params.parentId,
        }
      }
      const parent = newParent as ParentNode
      const child = node as SceneNode
      // Capture the child's absolute origin BEFORE the move — appendChild keeps
      // the raw parent-relative x/y, so without this the node jumps.
      const childOrigin = originOf(child as Placeable)
      const index = params.index as number | undefined
      if (index !== undefined) {
        parent.insertChild(index, child)
      } else {
        parent.appendChild(child)
      }
      // Recompute the child's parent-relative x/y so its CANVAS position is
      // unchanged. reparentPlacement answers undefined when the new parent owns
      // placement (auto-layout / GRID re-flow) or when an origin is unknown.
      // B55: a PAGE has no absoluteTransform, and reading that as "unknown"
      // is what dropped the node's position every time it was un-nested.
      const placement = reparentPlacement(
        childOrigin,
        parent as Placeable,
      )
      if (
        placement !== undefined &&
        'x' in child &&
        'y' in child
      ) {
        ;(child as SceneNode & { x: number; y: number }).x =
          placement.x
        ;(child as SceneNode & { x: number; y: number }).y =
          placement.y
      }
      return {
        id: child.id,
        name: child.name,
        type: child.type,
        parentId: parent.id,
      }
    }

    // reorder_children: reorder a parent's children to match nodeIds. The id
    // set is SET-EQUALITY validated against the actual children — a mismatch
    // WARNS (T7) and only the ids present in both sets are reordered; we never
    // throw. Reorder via insertChild (re-inserting at the target index moves
    // an existing child). Missing parent → {error}.
    case COMMANDS.REORDER_CHILDREN: {
      const parentId = params.parentId as string
      const parentNode = await resolveNodeId(parentId)
      if (!parentNode || !('children' in parentNode)) {
        return {
          error:
            'Parent not found or has no children: ' +
            parentId,
        }
      }
      const parent = parentNode as ParentNode & {
        children: readonly SceneNode[]
      }
      const requested = (params.nodeIds as string[]) ?? []
      const actualIds = parent.children.map(c => c.id)
      const actualSet = new Set(actualIds)
      const requestedSet = new Set(requested)
      const warnings: string[] = []

      const missing = requested.filter(
        id => !actualSet.has(id),
      )
      const extra = actualIds.filter(
        id => !requestedSet.has(id),
      )
      if (missing.length > 0 || extra.length > 0) {
        warnings.push(
          'reorder_children id set differs from the parent children: ' +
            'not children=[' +
            missing.join(',') +
            '], omitted=[' +
            extra.join(',') +
            ']. Only matching ids were reordered.',
        )
      }

      // Reorder only the requested ids that are actually children. Insert each
      // at its target index in turn (insertChild on an existing child moves it).
      const ordered = requested.filter(id =>
        actualSet.has(id),
      )
      let pos = 0
      for (const id of ordered) {
        const child = parent.children.find(c => c.id === id)
        if (child) {
          parent.insertChild(pos, child)
          pos++
        }
      }
      return {
        parentId: parent.id,
        order: parent.children.map(c => c.id),
        warnings,
      }
    }

    // boolean_op: combine ≥2 nodes into a BooleanOperationNode via
    // figma.union/subtract/intersect/exclude. parentId omitted → first node's
    // parent. Missing nodes/parent → {error}.
    case COMMANDS.BOOLEAN_OP: {
      const ids = (params.nodeIds as string[]) ?? []
      const op = params.op as string
      const nodes: SceneNode[] = []
      for (const id of ids) {
        const n = await resolveNodeId(id)
        if (n && 'type' in n) {
          nodes.push(n as SceneNode)
        }
      }
      if (nodes.length < 2) {
        return {
          error:
            'boolean_op requires at least 2 resolvable nodes.',
        }
      }
      let boolParent: ParentNode | null
      if (params.parentId !== undefined) {
        const p = await resolveNodeId(
          params.parentId as string,
        )
        if (!p || !('appendChild' in p)) {
          return {
            error:
              'Parent not found or cannot have children: ' +
              params.parentId,
          }
        }
        boolParent = p as ParentNode
      } else {
        boolParent = nodes[0].parent as ParentNode | null
      }
      if (!boolParent) {
        return {
          error: 'No parent for the boolean result.',
        }
      }
      let boolNode: BooleanOperationNode
      switch (op) {
        case 'UNION':
          boolNode = figma.union(nodes, boolParent)
          break
        case 'SUBTRACT':
          boolNode = figma.subtract(nodes, boolParent)
          break
        case 'INTERSECT':
          boolNode = figma.intersect(nodes, boolParent)
          break
        case 'EXCLUDE':
          boolNode = figma.exclude(nodes, boolParent)
          break
        default:
          return {
            error: 'Unknown boolean op: ' + op,
          }
      }
      writeScope.claim(writer, boolNode)
      return {
        id: boolNode.id,
        name: boolNode.name,
        type: boolNode.type,
      }
    }

    // flatten: flatten ≥1 nodes into a single vector via figma.flatten.
    // parentId omitted → first node's parent. Missing nodes/parent → {error}.
    case COMMANDS.FLATTEN: {
      const ids = (params.nodeIds as string[]) ?? []
      const nodes: SceneNode[] = []
      for (const id of ids) {
        const n = await resolveNodeId(id)
        if (n && 'type' in n) {
          nodes.push(n as SceneNode)
        }
      }
      if (nodes.length < 1) {
        return {
          error:
            'flatten requires at least 1 resolvable node.',
        }
      }
      let flatParent: ParentNode | null
      if (params.parentId !== undefined) {
        const p = await resolveNodeId(
          params.parentId as string,
        )
        if (!p || !('appendChild' in p)) {
          return {
            error:
              'Parent not found or cannot have children: ' +
              params.parentId,
          }
        }
        flatParent = p as ParentNode
      } else {
        flatParent = nodes[0].parent as ParentNode | null
      }
      if (!flatParent) {
        return {
          error: 'No parent for the flattened result.',
        }
      }
      const vector = figma.flatten(nodes, flatParent)
      writeScope.claim(writer, vector)
      return {
        id: vector.id,
        name: vector.name,
        type: vector.type,
      }
    }

    // group_nodes: group ≥1 existing nodes into a GROUP via figma.group.
    // parentId omitted → first node's parent. Missing nodes/parent → {error}.
    // T7: feature-detect figma.group before calling.
    case COMMANDS.GROUP_NODES: {
      if (typeof figma.group !== 'function') {
        figma.notify(
          'group_nodes: figma.group API is unavailable in this runtime.',
          { error: true },
        )
        return {
          error:
            'group_nodes: figma.group is unavailable in this Figma runtime.',
        }
      }
      const ids = (params.nodeIds as string[]) ?? []
      const nodes: SceneNode[] = []
      for (const id of ids) {
        const n = await resolveNodeId(id)
        if (n && 'type' in n) {
          nodes.push(n as SceneNode)
        }
      }
      if (nodes.length < 1) {
        return {
          error:
            'group_nodes requires at least 1 resolvable node.',
        }
      }
      let groupParent: ParentNode | null
      if (params.parentId !== undefined) {
        const p = await resolveNodeId(
          params.parentId as string,
        )
        if (!p || !('appendChild' in p)) {
          return {
            error:
              'Parent not found or cannot have children: ' +
              params.parentId,
          }
        }
        groupParent = p as ParentNode
      } else {
        groupParent = nodes[0].parent as ParentNode | null
      }
      if (!groupParent) {
        return {
          error: 'No parent for the grouped result.',
        }
      }
      const group = figma.group(nodes, groupParent)
      writeScope.claim(writer, group)
      return {
        id: group.id,
        name: group.name,
        type: group.type,
      }
    }

    // transform_group: apply a repeat-pattern transform to ≥1 existing nodes
    // via figma.transformGroup() → TransformGroupNode (a REPEAT-pattern feature:
    // linear/radial repeat — NOT general grouping; that is group_nodes / M10b).
    //
    // T7: feature-detect figma.transformGroup before calling. This is a niche
    // API added in @figma/plugin-typings 1.130.0; the repo pins 1.123.0 so
    // runtime absence is the EXPECTED outcome. If absent → clear error (the
    // controller decides ship-vs-defer).
    case COMMANDS.TRANSFORM_GROUP: {
      // T7 — feature guard first.
      if (
        typeof (figma as unknown as Record<string, unknown>)
          .transformGroup !== 'function'
      ) {
        figma.notify(
          'transform_group: figma.transformGroup API is unavailable in this runtime.',
          { error: true },
        )
        return {
          error:
            'transform_group: figma.transformGroup is unavailable in this Figma runtime.',
        }
      }
      const tgIds = (params.nodeIds as string[]) ?? []
      const tgNodes: SceneNode[] = []
      for (const id of tgIds) {
        const n = await resolveNodeId(id)
        if (n && 'type' in n) {
          tgNodes.push(n as SceneNode)
        }
      }
      if (tgNodes.length < 1) {
        return {
          error:
            'transform_group requires at least 1 resolvable node.',
        }
      }
      let tgParent: ParentNode | null
      if (params.parentId !== undefined) {
        const p = await resolveNodeId(
          params.parentId as string,
        )
        if (!p || !('appendChild' in p)) {
          return {
            error:
              'Parent not found or cannot have children: ' +
              params.parentId,
          }
        }
        tgParent = p as ParentNode
      } else {
        tgParent = tgNodes[0].parent as ParentNode | null
      }
      if (!tgParent) {
        return {
          error:
            'No parent for the transform group result.',
        }
      }
      try {
        const tgIndex = tgParent.children
          ? tgParent.children.length
          : 0
        const modifiers = (params.modifiers ??
          []) as unknown[]
        // Cast: figma.transformGroup not in typings 1.123.0 — safe cast.
        const transformGroupFn = (
          figma as unknown as Record<string, Function>
        ).transformGroup
        const tgNode = transformGroupFn(
          tgNodes,
          tgParent,
          tgIndex,
          modifiers,
        )
        // A creation choke point like the rest, though the API is absent
        // from the pinned runtime, so this claim rarely fires.
        writeScope.claim(writer, tgNode as BaseNode)
        return {
          id: tgNode.id,
          name: tgNode.name,
          type: tgNode.type,
        }
      } catch (err) {
        return {
          error:
            'transform_group failed: ' +
            (err instanceof Error
              ? err.message
              : String(err)),
        }
      }
    }

    // create_page: add a new page and name it.
    case COMMANDS.CREATE_PAGE: {
      const page = figma.createPage()
      writeScope.claim(writer, page)
      page.name = params.name as string
      return { id: page.id, name: page.name }
    }

    // set_current_page: switch the active page. Missing/non-PAGE → {error}.
    case COMMANDS.SET_CURRENT_PAGE: {
      const pageId = params.pageId as string
      const page = await figma.getNodeByIdAsync(pageId)
      if (!page || page.type !== 'PAGE') {
        return { error: 'Page not found: ' + pageId }
      }
      await figma.setCurrentPageAsync(page as PageNode)
      return {
        currentPage: { id: page.id, name: page.name },
      }
    }

    // duplicate_page: clone an existing page, optionally renaming the clone.
    // Missing/non-PAGE → {error}.
    case COMMANDS.DUPLICATE_PAGE: {
      const pageId = params.pageId as string
      const page = await figma.getNodeByIdAsync(pageId)
      if (!page || page.type !== 'PAGE') {
        return { error: 'Page not found: ' + pageId }
      }
      const dup = (page as PageNode).clone()
      writeScope.claim(writer, dup)
      if (params.name !== undefined) {
        dup.name = params.name as string
      }
      return { id: dup.id, name: dup.name }
    }

    // create_image: register an image and return its hash. T7 degrade — when
    // createImageAsync is unavailable or fetching/decoding fails, return
    // {warnings} (NO hash, NO error) so the server reports success-with-warning.
    // Supply EXACTLY ONE of url (fetched via createImageAsync) or bytes
    // (raw bytes via createImage).
    case COMMANDS.CREATE_IMAGE: {
      const url = params.url as string | undefined
      const bytes = params.bytes as number[] | undefined
      if (url !== undefined) {
        if (typeof figma.createImageAsync !== 'function') {
          return {
            warnings: [
              'createImageAsync unavailable in this Figma version; image not created',
            ],
          }
        }
        try {
          const image = await figma.createImageAsync(url)
          return { hash: image.hash }
        } catch (e) {
          return {
            warnings: [
              'createImageAsync failed (network/feature unavailable): ' +
                String(e),
            ],
          }
        }
      }
      if (bytes !== undefined) {
        try {
          const image = figma.createImage(
            new Uint8Array(bytes),
          )
          return { hash: image.hash }
        } catch (e) {
          return {
            warnings: [
              'createImage failed (invalid bytes/feature unavailable): ' +
                String(e),
            ],
          }
        }
      }
      return { error: 'create_image requires url or bytes' }
    }

    // set_plugin_data: write a single plugin-data key (shared when a namespace
    // is given). Missing/incapable node → {error}. Twin of get_plugin_data.
    case COMMANDS.SET_PLUGIN_DATA: {
      const nodeId = params.nodeId as string
      const node = await resolveNodeId(nodeId)
      if (!node || !('setPluginData' in node)) {
        return { error: 'Node not found: ' + nodeId }
      }
      const dataNode = node as BaseNode & PluginDataMixin
      const key = params.key as string
      const value = params.value as string
      const namespace = params.namespace as
        | string
        | undefined
      if (namespace !== undefined) {
        dataNode.setSharedPluginData(namespace, key, value)
      } else {
        dataNode.setPluginData(key, value)
      }
      return { id: node.id }
    }

    // set_reactions: replace a node's prototype reactions. T7 — feature-detect
    // setReactionsAsync and degrade to {id,warnings} (NEVER {error}) on a
    // missing API or a failed assignment; only a missing node yields {error}.
    case COMMANDS.SET_REACTIONS: {
      const nodeId = params.nodeId as string
      const node = await resolveNodeId(nodeId)
      if (!node) {
        return { error: 'Node not found: ' + nodeId }
      }
      const r = node as SceneNode & {
        setReactionsAsync?: (
          reactions: unknown[],
        ) => Promise<void>
      }
      if (typeof r.setReactionsAsync !== 'function') {
        return {
          id: node.id,
          warnings: [
            'setReactionsAsync unavailable in this Figma version; reactions not set',
          ],
        }
      }
      try {
        await r.setReactionsAsync(
          params.reactions as unknown as Reaction[],
        )
        return { id: node.id, warnings: [] }
      } catch (e) {
        return {
          id: node.id,
          warnings: [
            'Failed to set reactions: ' + String(e),
          ],
        }
      }
    }

    // set_annotations: replace a node's annotations. T7 editorType-gated —
    // feature-detect 'annotations' on the node and degrade to {id,warnings}
    // (NEVER {error}/throw) when absent; only a missing node yields {error}.
    case COMMANDS.SET_ANNOTATIONS: {
      const nodeId = params.nodeId as string
      const node = await resolveNodeId(nodeId)
      if (!node) {
        return { error: 'Node not found: ' + nodeId }
      }
      if (!('annotations' in node)) {
        return {
          id: node.id,
          warnings: [
            'Annotations API unavailable in this editor; annotations not set',
          ],
        }
      }
      try {
        // Strip the optional `nodeId` attribution tag that a multi-selection
        // get_annotations read adds, so a tagged annotation round-trips cleanly
        // through this single-node writer without leaking an extraneous key.
        const incoming =
          params.annotations as unknown as (Annotation & {
            nodeId?: string
          })[]
        const cleaned = incoming.map(a => {
          if (a && typeof a === 'object' && 'nodeId' in a) {
            const { nodeId: _drop, ...rest } = a
            return rest as Annotation
          }
          return a as Annotation
        })
        ;(
          node as SceneNode & {
            annotations?: unknown[]
          }
        ).annotations = cleaned
        return { id: node.id, warnings: [] }
      } catch (e) {
        return {
          id: node.id,
          warnings: [
            'Failed to set annotations: ' + String(e),
          ],
        }
      }
    }

    // create_variables: address a collection, then add variables to it with
    // per-mode values. The server has already CONVERTED COLOR values to
    // {r,g,b,a}; FLOAT/STRING/BOOLEAN pass through. valuesByMode is keyed by
    // mode NAME — resolved to mode ids against the TARGET collection's modes
    // (an unknown mode name is reported as a warning, never throws). T7:
    // feature-detect createVariableCollection / createVariable / setValueForMode.
    //
    // I63 — the call used to call createVariableCollection unconditionally, so
    // a second call with the same name forked a duplicate and said nothing.
    // The target is now resolved first (variable-collection-target.ts): an
    // existing name EXTENDS its collection and says so, an ambiguous name is
    // refused, and only an unused name creates.
    case COMMANDS.CREATE_VARIABLES: {
      const vars = figma.variables as VariablesAPI & {
        createVariableCollection?: (
          name: string,
        ) => VariableCollection
        createVariable?: (
          name: string,
          collection: VariableCollection,
          type: VariableResolvedDataType,
        ) => Variable
      }
      if (
        typeof vars.createVariableCollection !== 'function'
      ) {
        return {
          error:
            'Variables API unavailable in this Figma version',
        }
      }
      // B66 — the file as it stands BEFORE this call, so a name that collides
      // with an existing one can be reported. Read first for that reason: once
      // the collection exists, its own variables are in the list and every
      // created name looks like its own shadow. T7 throughout — a runtime that
      // will not enumerate simply reports no shadows.
      const existingVariables =
        await localVariablesSnapshot()
      // I63 — which collection this call means, decided before anything is
      // made. The enumeration is the same one the shadow snapshot already
      // read, so it costs no extra round trip.
      const existingCollections = Object.entries(
        existingVariables.collectionNames,
      ).map(([id, name]) => ({ id, name }))
      const target = resolveCollectionTarget(
        {
          collectionId: params.collectionId as
            | string
            | undefined,
          collection: params.collection as
            | string
            | undefined,
        },
        existingCollections,
      )
      if (target.kind === 'unaddressed') {
        return {
          error:
            'create_variables needs a collection: pass `collection` (a name) ' +
            'or `collectionId` (an exact address).',
        }
      }
      if (target.kind === 'missing') {
        return {
          error: 'Collection not found: ' + target.id,
        }
      }
      if (target.kind === 'ambiguous') {
        return {
          error: ambiguousCollectionError(
            target.name,
            target.ids,
          ),
        }
      }
      const warnings: string[] = []
      // T7: the collection-level factory failing is a genuine failure (nothing
      // to return) → {error}, not a degrade. An EXTEND makes nothing, so it
      // has no factory to fail — it resolves the handle it was given.
      let collection: VariableCollection
      if (target.kind === 'create') {
        try {
          collection = vars.createVariableCollection(
            target.name,
          )
        } catch (e) {
          return {
            error:
              'createVariableCollection failed for "' +
              target.name +
              '": ' +
              String(e),
          }
        }
      } else {
        const held =
          await figma.variables.getVariableCollectionByIdAsync(
            target.id,
          )
        if (!held) {
          return {
            error: 'Collection not found: ' + target.id,
          }
        }
        collection = held
        warnings.push(
          extendedCollectionWarning(
            collection.name,
            collection.id,
          ),
        )
      }
      const extending = target.kind === 'extend'

      // Build the mode NAME → modeId map. A NEW collection starts with one
      // default mode; the first requested mode renames it, the rest are added.
      //
      // An EXTEND never renames (I63). The collection's modes already carry
      // values for every variable in it, so renaming the first one to whatever
      // this call happens to list would rewrite the meaning of data this call
      // did not write. A mode the collection lacks is ADDED; one it already
      // has is simply used.
      const requestedModes =
        (params.modes as string[] | undefined) ?? []
      const modeNamesNow = (): string[] =>
        collection.modes.map(m => m.name)
      const addOneMode = (modeName: string): void => {
        if (typeof collection.addMode === 'function') {
          try {
            collection.addMode(modeName)
          } catch (e) {
            warnings.push(
              'addMode failed for "' +
                modeName +
                '": ' +
                String(e),
            )
          }
        } else {
          warnings.push(
            'addMode unavailable in this Figma version; mode "' +
              modeName +
              '" not added',
          )
        }
      }
      if (requestedModes.length > 0 && extending) {
        for (const modeName of requestedModes) {
          if (!modeNamesNow().includes(modeName)) {
            addOneMode(modeName)
          }
        }
      } else if (requestedModes.length > 0) {
        if (typeof collection.renameMode === 'function') {
          // T7: a duplicate/invalid rename degrades to a warning rather than
          // throwing the whole call into {error}.
          try {
            collection.renameMode(
              collection.modes[0].modeId,
              requestedModes[0],
            )
          } catch (e) {
            warnings.push(
              'renameMode failed for default mode → "' +
                requestedModes[0] +
                '": ' +
                String(e),
            )
          }
        } else {
          // T7: feature-detected absent is NOT a silent no-op — warn so the
          // agent knows the default mode kept its original name (and any value
          // keyed to the requested mode will then fall through as 'unknown mode').
          warnings.push(
            'renameMode unavailable in this Figma version; default mode not renamed to "' +
              requestedModes[0] +
              '"',
          )
        }
        for (const modeName of requestedModes.slice(1)) {
          addOneMode(modeName)
        }
      }
      // I63 — the names the TARGET collection already holds. A second variable
      // of one name inside one collection makes the name ambiguous in the very
      // scope Figma says it is unique in, so the create is skipped and named
      // rather than made.
      const heldNames = new Set<string>()
      for (const v of existingVariables.variables) {
        if (
          typeof v.name === 'string' &&
          v.variableCollectionId === collection.id
        ) {
          heldNames.add(v.name)
        }
      }

      const inVars =
        (params.variables as
          | {
              name: string
              type: VariableResolvedDataType
              valuesByMode: Record<string, unknown>
              aliases?: Record<string, string>
              scopes?: string[]
              codeSyntax?: Record<string, string>
              hiddenFromPublishing?: boolean
            }[]
          | undefined) ?? []
      const created: { id: string; name: string }[] = []
      for (const spec of inVars) {
        if (typeof vars.createVariable !== 'function') {
          warnings.push(
            'createVariable unavailable; variable "' +
              spec.name +
              '" not created',
          )
          continue
        }
        // I63 — the fork, one level down. Skipped and named, never made.
        if (heldNames.has(spec.name)) {
          warnings.push(
            duplicateVariableWarning(
              spec.name,
              collection.name,
            ),
          )
          continue
        }
        // T7: a single per-variable create FAILING degrades to a warning and the
        // batch continues (never a throw, never {error} — that is reserved for
        // the collection-level factory above).
        let variable: Variable
        try {
          variable = vars.createVariable(
            spec.name,
            collection,
            spec.type,
          )
        } catch (e) {
          warnings.push(
            'createVariable failed for variable "' +
              spec.name +
              '": ' +
              String(e),
          )
          continue
        }
        // B66 — the name now exists twice in this file, and nothing else says
        // so. `var(<name>)` resolves by a first-wins enumeration the caller
        // does not control, so the collision is reported the moment it is made
        // rather than the moment a binding picks the wrong half.
        const shadows = otherCollectionsHolding(
          spec.name,
          existingVariables.variables,
          existingVariables.collectionNames,
          // I63 — the TARGET collection is never its own shadow. On the extend
          // path the target's variables are in the snapshot, so without this a
          // name held elsewhere in the same collection would report itself.
          collection.id,
        )
        if (shadows.length > 0) {
          warnings.push(
            createShadowWarning(
              spec.name,
              collection.name,
              shadows,
            ),
          )
        }
        for (const [modeName, value] of Object.entries(
          spec.valuesByMode,
        )) {
          // I70 — a NAME or an ID; read live, so a mode added above counts.
          const modeId = modeIdFor(
            modeName,
            collection.modes,
          )
          if (modeId === undefined) {
            warnings.push(
              'unknown mode "' +
                modeName +
                '" for variable "' +
                spec.name +
                '"; value skipped',
            )
            continue
          }
          if (
            typeof variable.setValueForMode === 'function'
          ) {
            // T7: a setValueForMode REJECTION (e.g. a type-incompatible value
            // reaching a COLOR variable) degrades to a warning, never throws.
            try {
              variable.setValueForMode(
                modeId,
                value as VariableValue,
              )
            } catch (e) {
              warnings.push(
                'setValueForMode failed for variable "' +
                  spec.name +
                  '" mode "' +
                  modeName +
                  '": ' +
                  String(e),
              )
            }
          } else {
            warnings.push(
              'setValueForMode unavailable; value for "' +
                spec.name +
                '" not set',
            )
          }
        }
        // E1: apply aliases / scopes / codeSyntax / hiddenFromPublishing through
        // the SHARED per-variable path (parity with update_variables, T7).
        await applyVariableMeta(
          variable,
          {
            name: spec.name,
            aliases: spec.aliases,
            scopes: spec.scopes,
            codeSyntax: spec.codeSyntax,
            hiddenFromPublishing: spec.hiddenFromPublishing,
          },
          collection.modes,
          warnings,
        )
        created.push({
          id: variable.id,
          name: variable.name,
        })
      }

      return {
        collectionId: collection.id,
        modes: collection.modes,
        variables: created,
        warnings,
      }
    }

    // update_variables: mode lifecycle (addModes/removeModes/renameModes) +
    // per-variable edits (values, scopes, codeSyntax, hiddenFromPublishing) on
    // an existing collection. COLOR value edits arrive pre-converted from the
    // server. Each gated member is feature-detected and degrades with a warning
    // (T7); only a missing collection yields {error}.
    case COMMANDS.UPDATE_VARIABLES: {
      const collectionId = params.collectionId as string
      const collection =
        await figma.variables.getVariableCollectionByIdAsync(
          collectionId,
        )
      if (!collection) {
        return {
          error: 'Collection not found: ' + collectionId,
        }
      }
      const warnings: string[] = []

      // renameModes / removeModes match a mode by NAME first, then by id —
      // now through the SHARED resolver every mode reference uses (I70), so
      // the lifecycle edits and the value edits cannot drift apart.
      const findModeId = (
        ref: string,
      ): string | undefined =>
        modeIdFor(ref, collection.modes)

      for (const modeName of (params.addModes as
        | string[]
        | undefined) ?? []) {
        if (typeof collection.addMode === 'function') {
          try {
            collection.addMode(modeName)
          } catch (e) {
            warnings.push(
              'addMode failed for "' +
                modeName +
                '": ' +
                String(e),
            )
          }
        } else {
          warnings.push(
            'addMode unavailable in this Figma version; mode "' +
              modeName +
              '" not added',
          )
        }
      }
      for (const rename of (params.renameModes as
        | { from: string; to: string }[]
        | undefined) ?? []) {
        const modeId = findModeId(rename.from)
        if (modeId === undefined) {
          warnings.push(
            'mode "' +
              rename.from +
              '" not found; not renamed',
          )
        } else if (
          typeof collection.renameMode === 'function'
        ) {
          // T7: a duplicate/invalid rename throws — degrade to a warning rather
          // than letting the throw turn the whole call into {error} (discarding
          // addModes/values already applied).
          try {
            collection.renameMode(modeId, rename.to)
          } catch (e) {
            warnings.push(
              'renameMode failed for "' +
                rename.from +
                '" → "' +
                rename.to +
                '": ' +
                String(e),
            )
          }
        } else {
          warnings.push(
            'renameMode unavailable; mode "' +
              rename.from +
              '" not renamed',
          )
        }
      }
      for (const modeRef of (params.removeModes as
        | string[]
        | undefined) ?? []) {
        const modeId = findModeId(modeRef)
        if (modeId === undefined) {
          warnings.push(
            'mode "' + modeRef + '" not found; not removed',
          )
        } else if (
          typeof collection.removeMode === 'function'
        ) {
          try {
            collection.removeMode(modeId)
          } catch (e) {
            warnings.push(
              'removeMode failed for "' +
                modeRef +
                '": ' +
                String(e),
            )
          }
        } else {
          warnings.push(
            'removeMode unavailable; mode "' +
              modeRef +
              '" not removed',
          )
        }
      }

      for (const edit of (params.variables as
        | {
            id: string
            valuesByMode?: Record<string, unknown>
            aliases?: Record<string, string>
            scopes?: string[]
            codeSyntax?: Record<string, string>
            hiddenFromPublishing?: boolean
          }[]
        | undefined) ?? []) {
        const variable =
          await figma.variables.getVariableByIdAsync(
            edit.id,
          )
        if (!variable) {
          warnings.push('variable not found: ' + edit.id)
          continue
        }
        if (edit.valuesByMode !== undefined) {
          for (const [modeName, value] of Object.entries(
            edit.valuesByMode,
          )) {
            // I70 — read live, so a mode the lifecycle edits above added is
            // resolvable in the same call.
            const modeId = modeIdFor(
              modeName,
              collection.modes,
            )
            if (modeId === undefined) {
              warnings.push(
                'unknown mode "' +
                  modeName +
                  '" for variable ' +
                  edit.id +
                  '; value skipped',
              )
              continue
            }
            if (
              typeof variable.setValueForMode === 'function'
            ) {
              // T7: a setValueForMode REJECTION (e.g. a type-incompatible value
              // reaching a COLOR variable) degrades to a warning, never throws.
              try {
                variable.setValueForMode(
                  modeId,
                  value as VariableValue,
                )
              } catch (e) {
                warnings.push(
                  'setValueForMode failed for variable ' +
                    edit.id +
                    ' mode "' +
                    modeName +
                    '": ' +
                    String(e),
                )
              }
            } else {
              warnings.push(
                'setValueForMode unavailable; value not set on ' +
                  edit.id,
              )
            }
          }
        }
        if (edit.scopes !== undefined) {
          try {
            variable.scopes = edit.scopes as VariableScope[]
          } catch (e) {
            warnings.push(
              'scopes not settable on ' +
                edit.id +
                ': ' +
                String(e),
            )
          }
        }
        if (edit.codeSyntax !== undefined) {
          if (
            typeof variable.setVariableCodeSyntax ===
            'function'
          ) {
            for (const [platform, value] of Object.entries(
              edit.codeSyntax,
            )) {
              try {
                variable.setVariableCodeSyntax(
                  platform as CodeSyntaxPlatform,
                  value,
                )
              } catch (e) {
                warnings.push(
                  'codeSyntax not set (' +
                    platform +
                    ') on ' +
                    edit.id +
                    ': ' +
                    String(e),
                )
              }
            }
          } else {
            warnings.push(
              'setVariableCodeSyntax unavailable; codeSyntax not set on ' +
                edit.id,
            )
          }
        }
        if (edit.hiddenFromPublishing !== undefined) {
          try {
            variable.hiddenFromPublishing =
              edit.hiddenFromPublishing
          } catch (e) {
            warnings.push(
              'hiddenFromPublishing not settable on ' +
                edit.id +
                ': ' +
                String(e),
            )
          }
        }
        // B2: aliases — reuse the shared applyVariableMeta helper (extract-
        // don't-duplicate) so the alias-apply logic lives in exactly one place,
        // called by both create_variables and update_variables (T2 parity).
        if (edit.aliases !== undefined) {
          await applyVariableMeta(
            variable,
            { name: edit.id, aliases: edit.aliases },
            collection.modes,
            warnings,
          )
        }
      }

      return {
        collectionId: collection.id,
        modes: collection.modes,
        warnings,
      }
    }

    // delete_variables: remove variables AND collections by id. Collections are
    // processed first (removing a collection cascades its variables in the Figma
    // runtime). PARTIAL SUCCESS (T5): one bad id never sinks the rest. T7:
    // feature-detect remove() before calling — absent → per-id error, not a
    // throw. A variable already removed by its collection's cascade resolves null
    // → a clean per-id "not found" error (not a crash). Returns
    // { results:[{id, kind:'variable'|'collection'}], errors:[{id, error}] }.
    case COMMANDS.DELETE_VARIABLES: {
      const dvResults: { id: string; kind: string }[] = []
      const dvErrors: { id: string; error: string }[] = []

      // Collections first — cascade removes their variables.
      for (const colId of (params.collections as
        | string[]
        | undefined) ?? []) {
        const collection =
          await figma.variables.getVariableCollectionByIdAsync(
            colId,
          )
        if (!collection) {
          dvErrors.push({
            id: colId,
            error: 'Collection not found: ' + colId,
          })
          continue
        }
        if (typeof collection.remove !== 'function') {
          dvErrors.push({
            id: colId,
            error:
              'remove() unavailable on collection ' + colId,
          })
          continue
        }
        try {
          collection.remove()
          dvResults.push({ id: colId, kind: 'collection' })
        } catch (e) {
          dvErrors.push({
            id: colId,
            error:
              'remove() failed on collection ' +
              colId +
              ': ' +
              String(e),
          })
        }
      }

      // Variables: a variable already removed by cascade resolves null → "not found".
      for (const varId of (params.variables as
        | string[]
        | undefined) ?? []) {
        const variable =
          await figma.variables.getVariableByIdAsync(varId)
        if (!variable) {
          dvErrors.push({
            id: varId,
            error: 'Variable not found: ' + varId,
          })
          continue
        }
        if (typeof variable.remove !== 'function') {
          dvErrors.push({
            id: varId,
            error:
              'remove() unavailable on variable ' + varId,
          })
          continue
        }
        try {
          variable.remove()
          dvResults.push({ id: varId, kind: 'variable' })
        } catch (e) {
          dvErrors.push({
            id: varId,
            error:
              'remove() failed on variable ' +
              varId +
              ': ' +
              String(e),
          })
        }
      }

      return { results: dvResults, errors: dvErrors }
    }

    // create_styles: create one paint/text/effect/grid style from the
    // server-CONVERTED value (paint→Paint, text→FontName, effect→Effect,
    // grid→LayoutGrid). loadFontAsync first for text styles. T7: feature-detect
    // the createXStyle factory.
    // create_styles: array-create with PARTIAL SUCCESS. The server has already
    // CONVERTED each entry's value atom (paint→Paint, text→FontName, effect→
    // Effect, grid→LayoutGrid). Loop, creating one style per entry (loadFontAsync
    // first for text); a single failure degrades to that entry's {index,error}
    // and does NOT abort the rest. Returns { results:[{id,key,name,type,index}],
    // errors:[{index,error}] }.
    case COMMANDS.CREATE_STYLES: {
      const csEntries =
        (params.styles as
          | {
              index: number
              type: 'paint' | 'text' | 'effect' | 'grid'
              name: string
              value: unknown
              description?: string
            }[]
          | undefined) ?? []
      const csResults: {
        id: string
        key: string
        name: string
        type: 'paint' | 'text' | 'effect' | 'grid'
        index: number
      }[] = []
      const csErrors: { index: number; error: string }[] =
        []

      for (const entry of csEntries) {
        try {
          let style:
            | PaintStyle
            | TextStyle
            | EffectStyle
            | GridStyle
          if (entry.type === 'paint') {
            if (
              typeof figma.createPaintStyle !== 'function'
            ) {
              throw new Error(
                'createPaintStyle unavailable',
              )
            }
            const ps = figma.createPaintStyle()
            ps.paints = [entry.value as Paint]
            style = ps
          } else if (entry.type === 'text') {
            if (
              typeof figma.createTextStyle !== 'function'
            ) {
              throw new Error('createTextStyle unavailable')
            }
            const font = entry.value as {
              family: string
              style: string
              size: number
              lineHeight?: LineHeight
              letterSpacing?: LetterSpacing
            }
            await fontLoader.ensure({
              family: font.family,
              style: font.style,
            })
            const ts = figma.createTextStyle()
            ts.fontName = {
              family: font.family,
              style: font.style,
            }
            ts.fontSize = font.size
            if (font.lineHeight !== undefined) {
              ts.lineHeight = font.lineHeight
            }
            if (font.letterSpacing !== undefined) {
              ts.letterSpacing = font.letterSpacing
            }
            style = ts
          } else if (entry.type === 'effect') {
            if (
              typeof figma.createEffectStyle !== 'function'
            ) {
              throw new Error(
                'createEffectStyle unavailable',
              )
            }
            const es = figma.createEffectStyle()
            es.effects = [entry.value as Effect]
            style = es
          } else {
            if (
              typeof figma.createGridStyle !== 'function'
            ) {
              throw new Error('createGridStyle unavailable')
            }
            const gs = figma.createGridStyle()
            gs.layoutGrids = [reviveLayoutGrid(entry.value)]
            style = gs
          }
          style.name = entry.name
          if (entry.description !== undefined) {
            style.description = entry.description
          }
          csResults.push({
            id: style.id,
            key: style.key,
            name: style.name,
            type: entry.type,
            index: entry.index,
          })
        } catch (e) {
          csErrors.push({
            index: entry.index,
            error: String(e),
          })
        }
      }
      return { results: csResults, errors: csErrors }
    }

    // update_styles: array-edit existing styles' value/newName/description with
    // PARTIAL SUCCESS. Each entry is looked up by `id` OR by `name`+`type` (the
    // async local-style listers). The server sends the CONVERTED value + the
    // inferred valueType; the plugin validates valueType against the style's
    // actual type and assigns. One entry's failure becomes THAT entry's
    // {index,error} and does NOT abort the rest. Partial-write contract per
    // entry: a TEXT entry whose newName/description committed but whose font
    // load failed becomes that entry's error, naming that name/description WERE
    // applied (an honest partial write, never a silent no-op).
    case COMMANDS.UPDATE_STYLES: {
      const usEntries =
        (params.styles as
          | {
              index: number
              id?: string
              name?: string
              type?: 'paint' | 'text' | 'effect' | 'grid'
              value?: unknown
              valueType?:
                | 'paint'
                | 'text'
                | 'effect'
                | 'grid'
              newName?: string
              description?: string
            }[]
          | undefined) ?? []
      const usResults: { id: string; index: number }[] = []
      const usErrors: { index: number; error: string }[] =
        []

      // resolveStyle is the module-level shared helper (used by DELETE_STYLES too).
      for (const entry of usEntries) {
        try {
          const style = await resolveStyle(entry)
          if (!style) {
            usErrors.push({
              index: entry.index,
              error:
                'Style not found: ' +
                (entry.id ??
                  `${entry.name} (${entry.type})`),
            })
            continue
          }
          // name/description commit first (partial-write contract).
          if (entry.newName !== undefined) {
            style.name = entry.newName
          }
          if (entry.description !== undefined) {
            style.description = entry.description
          }
          if (entry.value !== undefined) {
            const actual = {
              PAINT: 'paint',
              TEXT: 'text',
              EFFECT: 'effect',
              GRID: 'grid',
            }[style.type]
            if (
              entry.valueType !== undefined &&
              entry.valueType !== actual
            ) {
              usErrors.push({
                index: entry.index,
                error:
                  'value looks like a ' +
                  entry.valueType +
                  ' atom but the style is ' +
                  actual +
                  '; value not applied (newName/description were updated)',
              })
              continue
            }
            if (style.type === 'PAINT') {
              ;(style as PaintStyle).paints = [
                entry.value as Paint,
              ]
            } else if (style.type === 'TEXT') {
              const font = entry.value as {
                family: string
                style: string
                size: number
                lineHeight?: LineHeight
                letterSpacing?: LetterSpacing
              }
              // loadFontAsync throws for an unavailable font. newName/description
              // were ALREADY committed above, so this entry becomes a per-entry
              // error that NAMES the applied name/description — an honest partial
              // write, not a silent no-op, and it does not abort other entries.
              try {
                await fontLoader.ensure({
                  family: font.family,
                  style: font.style,
                })
                const ts = style as TextStyle
                ts.fontName = {
                  family: font.family,
                  style: font.style,
                }
                ts.fontSize = font.size
                if (font.lineHeight !== undefined) {
                  ts.lineHeight = font.lineHeight
                }
                if (font.letterSpacing !== undefined) {
                  ts.letterSpacing = font.letterSpacing
                }
              } catch (e) {
                usErrors.push({
                  index: entry.index,
                  error:
                    'font "' +
                    font.family +
                    ' ' +
                    font.style +
                    '" unavailable; value not applied (newName/description were updated): ' +
                    String(e),
                })
                continue
              }
            } else if (style.type === 'EFFECT') {
              ;(style as EffectStyle).effects = [
                entry.value as Effect,
              ]
            } else if (style.type === 'GRID') {
              ;(style as GridStyle).layoutGrids = [
                reviveLayoutGrid(entry.value),
              ]
            }
          }
          usResults.push({
            id: style.id,
            index: entry.index,
          })
        } catch (e) {
          usErrors.push({
            index: entry.index,
            error: String(e),
          })
        }
      }
      return { results: usResults, errors: usErrors }
    }

    // delete_styles: array-delete styles by id OR by name+type. Uses the shared
    // resolveStyle() helper (extracted from UPDATE_STYLES, also used here). Per
    // entry: resolve → not found = {index,error}; else T7 feature-detect remove()
    // → absent = {index,error}; call remove() in try/catch for per-entry error on
    // throw. PARTIAL SUCCESS (T5): one entry's failure never aborts the rest.
    // No value-convert (T8 — deletes carry no grammar). Returns
    // { results:[{id,index}], errors:[{index,error}] }.
    case COMMANDS.DELETE_STYLES: {
      const dsEntries =
        (params.styles as
          | {
              index: number
              id?: string
              name?: string
              type?: 'paint' | 'text' | 'effect' | 'grid'
            }[]
          | undefined) ?? []
      const dsResults: { id: string; index: number }[] = []
      const dsErrors: { index: number; error: string }[] =
        []

      for (const entry of dsEntries) {
        try {
          const style = await resolveStyle(entry)
          if (!style) {
            dsErrors.push({
              index: entry.index,
              error:
                'Style not found: ' +
                (entry.id ??
                  `${entry.name} (${entry.type})`),
            })
            continue
          }
          if (typeof style.remove !== 'function') {
            dsErrors.push({
              index: entry.index,
              error:
                'remove() unavailable on style ' + style.id,
            })
            continue
          }
          style.remove()
          dsResults.push({
            id: style.id,
            index: entry.index,
          })
        } catch (e) {
          dsErrors.push({
            index: entry.index,
            error: String(e),
          })
        }
      }
      return { results: dsResults, errors: dsErrors }
    }

    // apply_style: bind a style to a node field via the matching async setter.
    // T7 boundary:
    //  - a missing node or a non-existent / wrong-CATEGORY styleId is a GENUINE
    //    invalid → {error} (validated up front, never swallowed).
    //  - a setter that is feature-unavailable on the node type degrades to a
    //    warning on success (NEVER {error}); the remaining catch covers a true
    //    feature-unavailability rejection.
    case COMMANDS.APPLY_STYLE: {
      const nodeId = params.nodeId as string
      const node = await resolveNodeId(nodeId)
      if (!node) {
        return { error: 'Node not found: ' + nodeId }
      }
      const styleId = params.styleId as string
      const field = params.field as StyleField
      // A genuinely invalid styleId is NOT a degrade — surface {error} up front
      // (mirrors the node-not-found guard above).
      const style = await figma.getStyleByIdAsync(styleId)
      if (!style) {
        return { error: 'Style not found: ' + styleId }
      }
      // Wrong-category binding (e.g. a PAINT style via field:'text') is a
      // genuine invalid → {error}, not a warning.
      const expectedType = STYLE_TYPES[field]
      if (style.type !== expectedType) {
        return {
          error:
            'Style category mismatch: field "' +
            field +
            '" expects a ' +
            expectedType +
            ' style but ' +
            styleId +
            ' is a ' +
            style.type +
            ' style',
        }
      }
      // The setter + its degrade wording live in bind-wrappers.ts, shared with
      // the inline `style(Name)value` write path (T8: one implementation).
      const warnings: string[] = []
      await applyStyleField(
        node as unknown as BindTargetNode,
        field,
        styleId,
        warnings,
      )
      return { id: node.id, warnings }
    }

    // batch (M3-D): N WRITE ops over existing targets, executed in ARRAY ORDER
    // with PARTIAL SUCCESS. The server has already CONVERTED each op's params
    // (atom leaves → Figma objects) and tagged each with its command, so the
    // plugin simply re-dispatches each through handleCommand (the same switch)
    // and collects a per-op {ok,result|error}. One failing op does NOT abort the
    // rest: a handler returning {error} OR a thrown exception is isolated to that
    // entry. Returns { results: [{ok,result|error}] } index-aligned with ops.
    case COMMANDS.BATCH: {
      const batchOps =
        (params.ops as
          | {
              op: string
              params: Record<string, unknown>
            }[]
          | undefined) ?? []
      const results: {
        ok: boolean
        result?: unknown
        error?: string
      }[] = []
      for (const entry of batchOps) {
        // A nested enter/exit pair, NOT a new generation: the outer dispatch
        // already holds one, so the refcount keeps it open across the whole
        // batch and each op's ids fold into it — a batch of fifty ops spends
        // exactly one of the RETAINED_COMMANDS slots. `finally` closes the
        // frame even for the ops this loop deliberately swallows.
        //
        // This is also the ONLY harvest for a batch: the outer `enter`
        // opens the generation but folds nothing, so each op's params and
        // return are classified as that OP, never blanket-claimed under
        // `batch` (see write-scope.ts).
        const done = await writeScope.enter(
          writer,
          entry.op,
          entry.params ?? {},
        )
        let opResult: unknown = null
        try {
          opResult = await handleCommand(
            entry.op,
            entry.params ?? {},
            writer,
          )
          // A handler that returns {error} (e.g. node not found) is a per-op
          // failure, not a success — surface it as this entry's error.
          if (
            opResult !== null &&
            typeof opResult === 'object' &&
            (opResult as { error?: string }).error !==
              undefined
          ) {
            results.push({
              ok: false,
              error: (opResult as { error: string }).error,
            })
          } else {
            results.push({ ok: true, result: opResult })
          }
        } catch (e) {
          results.push({ ok: false, error: String(e) })
        } finally {
          done(opResult)
        }
      }
      return { results }
    }

    default:
      return { error: 'Unknown command: ' + command }
  }
}

figma.ui.onmessage = async (msg: PluginMessage) => {
  if (msg.type === 'execute-command') {
    // B3 identity guard: refuse a command addressed to a different file. The
    // target originates from the wire command's meta.fileKey (request-envelope
    // .md); useRelay forwards it into this internal execute-command message,
    // whose field keeps the name targetFileKey. If our fileKey is unknown
    // (never-saved / no private API) the guard can't verify and does NOT
    // refuse — degrade honestly.
    const localFileKey = figma.fileKey ?? null
    const targetFileKey = msg.targetFileKey ?? null
    if (isTargetMismatch(localFileKey, targetFileKey)) {
      // A refusal is still a reply, and a reply that does not arrive is a
      // hang. Everything here is a string so this cannot realistically
      // throw — the guard is here so the property is structural rather than
      // a fact about today's payload.
      try {
        figma.ui.postMessage({
          type: 'command-result',
          id: msg.id,
          result: {
            error: targetGuardError(
              String(targetFileKey),
              String(localFileKey),
            ),
          },
        })
      } catch (err) {
        console.error(
          '[plugin] file-guard refusal could not be sent:',
          String(err),
        )
      }
      return
    }

    // The generation opens BEFORE the handler and SEALS when the dispatch
    // settles, INCLUDING when the handler throws: an unsealed generation
    // keeps absorbing every later command until MAX_DISPATCH_MS force-seals
    // it, so the disposer is called from `finally`, never inline. It seals at
    // EXIT rather than at entry because a command that awaits a font load or
    // an image fetch mutates seconds after it was dispatched. Sealing is not
    // expiry — a sealed generation stays in the union until one of the two
    // bounds evicts it (change-feed.md).
    //
    // This is the ONE dispatch point, and the command name is what tells the
    // scope whether to harvest at all: a READ emits no event, so it opens no
    // generation and folds neither its params nor its return. Harvesting one
    // would be pure over-claim — `search` returns hundreds of ids and
    // `inspect(pageRoot)` folds that page's whole reflow closure — and under
    // retention that reach would silence the user's real edits for minutes.
    let result: unknown
    // The writer of this dispatch: meta.sessionId, or the reserved literal
    // when the identity hook is absent. `_unattributed` is a WRITER like any
    // other, and a server that has never received a sessionId subtracts it —
    // so the degraded route keeps exactly the single-agent behaviour.
    const writer = msg.sessionId ?? UNATTRIBUTED
    const done = await writeScope.enter(
      writer,
      msg.command,
      msg.params,
    )
    try {
      result = await handleCommand(
        msg.command,
        msg.params,
        writer,
      )
    } catch (err) {
      result = { error: String(err) }
    } finally {
      done(result)
    }

    // The reply is the last thing that can fail, and until now it failed
    // silently: postMessage structured-clones, so any value it cannot clone —
    // a figma.mixed symbol, a live node handle — throws HERE, after the work
    // is done and the write scope has sealed. The command then has no result
    // and no error, and the caller sits until its timeout. One such value
    // (an unguarded node.strokeJoin) cost a 30-second hang that read as a
    // Figma defect. Answer with the failure instead — a named error is
    // diagnosable, a silence is not (B1).
    try {
      figma.ui.postMessage({
        type: 'command-result',
        id: msg.id,
        result,
      })
    } catch (err) {
      figma.ui.postMessage({
        type: 'command-result',
        id: msg.id,
        result: {
          error:
            'command ' +
            String(msg.command) +
            ' finished, but its result cannot cross the plugin boundary: ' +
            String(err) +
            ' — the document may have been changed',
          code: 'UNSERIALIZABLE_RESULT',
        },
      })
    }
  }

  if (msg.type === 'get-identity') {
    figma.ui.postMessage(fileIdentity())
  }

  if (msg.type === 'storage-get') {
    // The UI awaits this one. An unhandled throw from clientStorage — or
    // from postMessage on a stored value that will not clone — used to
    // reject this whole handler and leave that promise pending forever.
    // Answering null is the honest degrade: the key is unreadable, which is
    // what an absent key already means to every caller.
    let value: unknown = null
    try {
      const stored = await figma.clientStorage.getAsync(
        msg.key,
      )
      value = stored !== undefined ? stored : null
    } catch (err) {
      console.error(
        `[plugin] clientStorage.getAsync(${msg.key}) failed:`,
        String(err),
      )
    }
    try {
      figma.ui.postMessage({
        type: 'storage-result',
        key: msg.key,
        value,
      })
    } catch (err) {
      console.error(
        `[plugin] storage-result for ${msg.key} could not be sent:`,
        String(err),
      )
      figma.ui.postMessage({
        type: 'storage-result',
        key: msg.key,
        value: null,
      })
    }
  }

  if (msg.type === 'storage-set') {
    // Nothing awaits this, but an unhandled rejection here would still tear
    // down the message handler mid-flight and take unrelated work with it.
    try {
      await figma.clientStorage.setAsync(msg.key, msg.value)
    } catch (err) {
      console.error(
        `[plugin] clientStorage.setAsync(${msg.key}) failed:`,
        String(err),
      )
    }
  }

  if (msg.type === 'storage-delete') {
    await figma.clientStorage.deleteAsync(msg.key)
  }

  if (msg.type === 'resize') {
    const height = Math.max(
      MIN_WINDOW_HEIGHT,
      Math.min(MAX_WINDOW_HEIGHT, Math.round(msg.height)),
    )
    figma.ui.resize(WINDOW_WIDTH, height)
    return
  }
}
