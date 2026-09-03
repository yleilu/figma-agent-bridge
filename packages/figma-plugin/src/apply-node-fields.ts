// Field appliers for the flat NodeSpec keys the server writer emits beside the
// main apply path: stroke geometry (strokeCap/strokeJoin/strokeMiterLimit),
// per-side stroke weights, exportSettings, node-level layout grids, and the two
// geometry fields Figma can accept and then quietly overrule — `size` and
// `position`. Same shape as `apply-layout.ts`: each function
// declares a minimal structural target so it stays free of the figma runtime
// and is independently unit-testable with a plain fake node.
//
// Contract mirrors the writer: assign a field ONLY when the corresponding
// spec key is present (omission ≠ clear — an `undefined` spec value must
// leave an existing node value untouched). T7 feature-detect (`'x' in node`)
// before every assign: a node type that cannot carry a field is a silent
// no-op, never a throw.

/** Structural subset this applier writes to (GeometryMixin's stroke-geometry fields). */
export type StrokeGeometryTarget = Partial<{
  strokeCap: unknown
  strokeJoin: unknown
  strokeMiterLimit: unknown
}>

/** The flat spec keys the writer emits from the `stroke(...)` atom (see `atomToStroke`). */
export type StrokeGeometrySpec = {
  strokeCap?: unknown
  strokeJoin?: unknown
  strokeMiterLimit?: unknown
}

/**
 * Apply stroke geometry (cap/join/miter) to a node.
 *
 * Each field is independent and set ONLY when present on `spec`, mirroring
 * the writer's pure-emit contract. T7 feature-detect: a node type without
 * e.g. `strokeMiterLimit` (no strokes mixin) silently skips that field.
 */
export const applyStrokeGeometry = (
  node: StrokeGeometryTarget,
  spec: StrokeGeometrySpec,
): void => {
  if (spec.strokeCap !== undefined && 'strokeCap' in node) {
    node.strokeCap = spec.strokeCap
  }
  if (
    spec.strokeJoin !== undefined &&
    'strokeJoin' in node
  ) {
    node.strokeJoin = spec.strokeJoin
  }
  if (
    spec.strokeMiterLimit !== undefined &&
    'strokeMiterLimit' in node
  ) {
    node.strokeMiterLimit = spec.strokeMiterLimit
  }
}

/**
 * Structural subset this applier writes to (IndividualStrokesMixin, plus the
 * uniform `strokeWeight` it falls back to).
 */
export type StrokeWeightsTarget = Partial<{
  type: unknown
  strokeWeight: unknown
  strokeTopWeight: unknown
  strokeRightWeight: unknown
  strokeBottomWeight: unknown
  strokeLeftWeight: unknown
}>

/**
 * Apply per-side stroke weights `[top, right, bottom, left]` (B27).
 *
 * Figma carries the four sides on frame-like and RECTANGLE nodes
 * (`IndividualStrokesMixin`) and nowhere else, so this is the one applier that
 * has to SAY something when it cannot do the job: a VECTOR asked for
 * `stroke([0,0,1,0])` can only take one weight, and silently taking the top
 * one — 0 — is how a divider became invisible. Feature-detect (T7), and when
 * the sides cannot survive, collapse to the top side and warn.
 *
 * The warning lives here rather than in the server's writer because only here
 * is the node type known.
 */
export const applyStrokeWeights = (
  node: StrokeWeightsTarget,
  weights: unknown,
  warnings?: string[],
): void => {
  if (weights === undefined) return
  const typeName =
    typeof node.type === 'string' ? node.type : 'unknown'
  if (
    !Array.isArray(weights) ||
    weights.length !== 4 ||
    weights.some(w => typeof w !== 'number')
  ) {
    warnings?.push(
      'per-side stroke weights ignored — expected ' +
        '[top,right,bottom,left] numbers on a ' +
        typeName +
        ' node',
    )
    return
  }
  const [top, right, bottom, left] = weights as number[]
  if ('strokeTopWeight' in node) {
    node.strokeTopWeight = top
    node.strokeRightWeight = right
    node.strokeBottomWeight = bottom
    node.strokeLeftWeight = left
    return
  }
  if ('strokeWeight' in node) {
    node.strokeWeight = top
    warnings?.push(
      'per-side stroke weights [' +
        [top, right, bottom, left].join(', ') +
        '] collapsed to a single strokeWeight (' +
        top +
        ') — a ' +
        typeName +
        ' node has no per-side stroke weights',
    )
    return
  }
  warnings?.push(
    'per-side stroke weights ignored — not supported on a ' +
      typeName +
      ' node',
  )
}

/** Structural subset this applier writes to (ExportMixin). */
export type ExportSettingsTarget = Partial<{
  exportSettings: unknown
}>

// The wire/NodeSpec shape keeps `constraint` as a JSON-friendly tuple —
// `['SCALE'|'WIDTH'|'HEIGHT', number]` (see ExportSetting in node-spec.ts) —
// but Figma's real ExportSettingsConstraints is an OBJECT, `{type, value}`.
// Assigning the tuple as-is throws at the plugin boundary ("Expected object,
// received array at [0].constraint"). Revive it right before any assign to
// .exportSettings, mirroring reviveLayoutGrid's wire→runtime translation.
const reviveExportSetting = (setting: unknown): unknown => {
  if (
    setting === null ||
    typeof setting !== 'object' ||
    !Array.isArray(
      (setting as { constraint?: unknown }).constraint,
    )
  ) {
    return setting
  }
  const [type, value] = (
    setting as { constraint: [string, number] }
  ).constraint
  return {
    ...(setting as Record<string, unknown>),
    constraint: { type, value },
  }
}

/**
 * Apply export presets to a node. Each entry's `constraint` tuple is revived
 * to Figma's `{type,value}` object shape (see `reviveExportSetting`) before
 * assignment. T7 feature-detect: a node type without `exportSettings` (no
 * export mixin) silently no-ops.
 */
export const applyExportSettings = (
  node: ExportSettingsTarget,
  settings: unknown,
): void => {
  if (settings !== undefined && 'exportSettings' in node) {
    node.exportSettings = Array.isArray(settings)
      ? settings.map(reviveExportSetting)
      : settings
  }
}

/** Structural subset this applier writes to (FrameNode's `layoutGrids`). */
export type GridsTarget = Partial<{ layoutGrids: unknown }>

/**
 * Apply node-level layout grids. The server writer converts grid atoms →
 * COMPLETE Figma `LayoutGrid` objects (via `atomToGrid`) and emits them as
 * `spec.grids`; Figma's own property is **`layoutGrids`**, not `grids` — the
 * caller is responsible for any wire-format revival (e.g. `'auto'` →
 * `Infinity`) before calling this. T7 feature-detect: a node type without
 * `layoutGrids` (e.g. not a frame) silently no-ops.
 */
export const applyGrids = (
  node: GridsTarget,
  grids: unknown,
): void => {
  if (grids !== undefined && 'layoutGrids' in node) {
    node.layoutGrids = grids
  }
}

// ─── warn-on-no-op (T7) ───────────────────────────────────────────────────────

/**
 * capability key → spec key. A field the target node type does not carry is
 * dropped by the appliers' `'x' in node` guards, which is the right silence on
 * a create (the same spec chose the type) and the wrong silence wherever the
 * target is arbitrary: `update_node` patching a SLICE, or a slot spec landing
 * on whatever `createSlot()` returned.
 */
const CAPABILITY_CHECKS: [string, string][] = [
  ['layoutMode', 'layout'],
  ['fills', 'fills'],
  ['strokes', 'strokes'],
  ['effects', 'effects'],
  ['opacity', 'opacity'],
  ['cornerRadius', 'radius'],
  ['clipsContent', 'clipsContent'],
  ['pointCount', 'pointCount'],
  ['innerRadius', 'innerRadius'],
  ['sectionContentsHidden', 'sectionContentsHidden'],
  // `text` is applied by applyTextProperties, which runs only for a TEXT node —
  // so anywhere else the whole struct is a silent no-op unless named here.
  ['characters', 'text'],
  // Only a vector-like node carries path data. Everywhere else the geometry a
  // patch states has nowhere to go (B45).
  ['vectorPaths', 'vectorPaths'],
]

/**
 * Name every spec field the target node cannot carry.
 *
 * One message per dropped field, interpolating the node's ACTUAL type so the
 * agent knows what it hit. Empty when everything asked for is supported — the
 * ordinary case, and the reason this RETURNS rather than pushes: the caller
 * decides which sink (and which attribution prefix) the notes belong to.
 */
export const capabilityWarnings = (
  node: { type: string },
  spec: Record<string, unknown>,
): string[] => {
  const out: string[] = []
  for (const [capability, key] of CAPABILITY_CHECKS) {
    if (spec[key] !== undefined && !(capability in node)) {
      out.push(
        key +
          ' ignored — not supported on a ' +
          node.type +
          ' node',
      )
    }
  }
  return out
}

// ─── geometry: prove the write (T7) ───────────────────────────────────────────
//
// `size` and `position` are the two fields Figma ACCEPTS and then overrules.
// Nothing throws, nothing is dropped by a capability guard, and the node simply
// keeps the geometry it had. Every other applier here can trust its
// assignment. These two read the value back.

/** Figma's own resolution floor is 0.01px — a smaller gap is not a discard. */
const GEOMETRY_EPSILON = 0.01

const near = (a: number, b: number): boolean =>
  Math.abs(a - b) < GEOMETRY_EPSILON

const typeName = (node: { type?: unknown }): string =>
  typeof node.type === 'string' ? node.type : 'unknown'

const nodeLabel = (node: { name?: unknown }): string =>
  typeof node.name === 'string' && node.name !== ''
    ? '"' + node.name + '"'
    : 'the node'

/**
 * Structural subset the size applier reads, writes, and diagnoses against.
 *
 * `resize` is a METHOD rather than a `width`/`height` pair because a method is
 * the only way Figma lets a size be set — and reading `width`/`height` back is
 * the only way to learn whether the call did anything.
 */
export type SizeTarget = Partial<{
  type: unknown
  name: unknown
  width: unknown
  height: unknown
  resize: (width: number, height: number) => void
  resizeWithoutConstraints: (
    width: number,
    height: number,
  ) => void
  layoutSizingHorizontal: unknown
  layoutSizingVertical: unknown
  textAutoResize: unknown
  parent: unknown
}>

type Ancestor = Partial<{
  type: unknown
  name: unknown
  parent: unknown
}>

// BOUNDED walk. A Figma tree is finite, but this reads a structural `parent`
// a caller could hand a cycle back on, and a hung plugin is a far worse answer
// than an unattributed warning.
const enclosingInstance = (
  node: SizeTarget,
): Ancestor | undefined => {
  let current = node.parent as Ancestor | null | undefined
  for (let hops = 0; hops < 64; hops += 1) {
    if (current === null || current === undefined) {
      return undefined
    }
    if (current.type === 'INSTANCE') return current
    current = current.parent as Ancestor | null | undefined
  }
  return undefined
}

const measured = (
  node: SizeTarget,
): [number, number] | undefined =>
  typeof node.width === 'number' &&
  typeof node.height === 'number'
    ? [node.width, node.height]
    : undefined

const ownedByLayout = (sizing: unknown): boolean =>
  sizing === 'FILL' || sizing === 'HUG'

/**
 * Name the likeliest reason a resize did not take, or `''` when nothing on the
 * node explains it.
 *
 * Every branch states what was OBSERVED and what the caller can do next: a
 * refusal an agent cannot act on is barely better than the silence it replaces.
 * The three causes are ordered most-specific first, because a text node inside
 * an auto-layout frame inside an instance matches all three and only the
 * innermost one is worth acting on.
 */
const sizeRefusalReason = (
  node: SizeTarget,
  asked: [number, number],
  actual: [number, number],
  statedSizing?: unknown,
): string => {
  if (
    node.type === 'TEXT' &&
    typeof node.textAutoResize === 'string' &&
    node.textAutoResize !== 'NONE'
  ) {
    return (
      ' This text node sizes itself to its content (textAutoResize: ' +
      node.textAutoResize +
      '). Inside an auto-layout parent, sizing:["FIXED","FIXED"] pins it.'
    )
  }
  const stated = Array.isArray(statedSizing)
    ? (statedSizing as unknown[])
    : []
  const held: string[] = []
  // `selfContradicted` tracks whether the SAME patch is what handed the axis
  // away. It changes the remedy from "pin it" — advice a caller who wrote
  // sizing:['FILL',…] has already refused — to naming the contradiction.
  let selfContradicted = false
  if (
    !near(actual[0], asked[0]) &&
    ownedByLayout(node.layoutSizingHorizontal)
  ) {
    held.push(
      'width (layoutSizingHorizontal: ' +
        String(node.layoutSizingHorizontal) +
        ')',
    )
    if (ownedByLayout(stated[0])) selfContradicted = true
  }
  if (
    !near(actual[1], asked[1]) &&
    ownedByLayout(node.layoutSizingVertical)
  ) {
    held.push(
      'height (layoutSizingVertical: ' +
        String(node.layoutSizingVertical) +
        ')',
    )
    if (ownedByLayout(stated[1])) selfContradicted = true
  }
  if (held.length > 0) {
    return selfContradicted
      ? ' This patch set the ' +
          held.join(' and the ') +
          ' itself. A stated size and a FILL or HUG axis contradict each other, and the sizing wins.'
      : ' Auto-layout owns the ' +
          held.join(' and the ') +
          '. Pin it with sizing:["FIXED","FIXED"].'
  }
  const instance = enclosingInstance(node)
  if (instance !== undefined) {
    return (
      ' This node is a sublayer of the instance ' +
      nodeLabel(instance) +
      '. Figma can refuse a size change on an instance sublayer. Resize the main component, or detach the instance.'
    )
  }
  return ''
}

/**
 * The one line a node says when its stated size is not the size it reads, or
 * undefined when the size landed (or the node has no width/height to judge).
 *
 * ONE author for the sentence, because two write paths emit it. `update_node`
 * has said this since B46; the create paths said nothing at all, so the SAME
 * frame given the SAME `size` was silently hugged away on create and pinned on
 * update, and only one of the two admitted anything (B61). A caller who paid
 * fifteen repair calls for that found out from a read-back.
 */
export const sizeMismatchWarning = (
  node: SizeTarget,
  width: number,
  height: number,
  statedSizing?: unknown,
): string | undefined => {
  const actual = measured(node)
  // Silence on an unmeasurable node is deliberate: a warning nobody can verify
  // is noise.
  if (actual === undefined) return undefined
  if (near(actual[0], width) && near(actual[1], height)) {
    return undefined
  }
  return (
    'size not applied — asked [' +
    width +
    ', ' +
    height +
    '], ' +
    nodeLabel(node) +
    ' reads [' +
    actual[0] +
    ', ' +
    actual[1] +
    '].' +
    sizeRefusalReason(
      node,
      [width, height],
      actual,
      statedSizing,
    )
  )
}

/**
 * The doubt a size write leaves when it changed nothing it could be judged by
 * (B67), or undefined when there is no doubt to report.
 *
 * The mismatch check above compares the OUTCOME against the REQUEST. That is
 * the right test almost everywhere and it has one blind spot: a node that
 * ALREADY reads the numbers asked for passes it whether the write landed or was
 * refused outright. Live, an agent resized an instance sublayer to the size it
 * already had, got `warnings: []`, and took that as proof the target class
 * accepts a resize. The next write, to a different number, was the one that
 * cost a design.
 *
 * So the doubt is reported by TARGET CLASS rather than by value — and only for
 * the class where a refusal is both real and silent. Three cases stay quiet:
 *
 *   the size CHANGED       — the write proved itself, whatever the target is.
 *   no instance ancestor   — nothing here refuses a resize behind your back.
 *   the size did not land  — `sizeMismatchWarning` already says so, in words
 *                            that are more specific than this doubt.
 */
const unprovenResizeWarning = (
  node: SizeTarget,
  before: [number, number] | undefined,
  asked: [number, number],
): string | undefined => {
  if (
    before === undefined ||
    !near(before[0], asked[0]) ||
    !near(before[1], asked[1])
  ) {
    return undefined
  }
  const instance = enclosingInstance(node)
  if (instance === undefined) return undefined
  return (
    'size not verified — ' +
    nodeLabel(node) +
    ' already read [' +
    asked[0] +
    ', ' +
    asked[1] +
    '] before this write, so the reply cannot tell an applied resize from a ' +
    'refused one. This node is a sublayer of the instance ' +
    nodeLabel(instance) +
    '. Figma can refuse a size change on an instance sublayer. Resize the ' +
    'main component, or detach the instance.'
  )
}

/**
 * Name a stated size the CREATE path could not honour (B61).
 *
 * The create path applies the size and does not re-apply it, which is right:
 * the node is fresh, its type and its sizing came from the same spec, and a
 * second resize would fight the deferred FILL/HUG collapse B60 exists for. What
 * it owes the caller is the TRUTH about what happened — a `size` on a
 * layout-bearing frame is discarded by the sizing that wins, and until now the
 * reply carried no `warnings` key at all.
 *
 * Runs where the node is FINISHED: after its sizing is written and, on the tree
 * path, after its children are in it. Judging a parent mid-build would report
 * every hugging frame as a failure between its own append and its subtree.
 */
export const verifyCreatedSize = (
  node: SizeTarget,
  size: unknown,
  warnings?: string[],
  statedSizing?: unknown,
): void => {
  if (size === undefined) return
  const [width, height] = size as [number, number]
  if (
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return
  }
  const message = sizeMismatchWarning(
    node,
    width,
    height,
    statedSizing,
  )
  if (message !== undefined) {
    warnings?.push(message)
  }
}

/**
 * Put back the stated size on the axes an explicit FIXED pinned (B69).
 *
 * `sizing` and `size` are two halves of one instruction, and on the create_tree
 * path they used to land in an order that lost the second half. A node with
 * children DEFERS its sizing (B60): the frame keeps the box the spec stated
 * while its subtree is built, the auto-layout default hugs it as children
 * arrive, and `applySizing` then writes FIXED — which FREEZES THE CURRENT BOX
 * rather than restoring the stated one. Nothing re-applied the size, so it
 * survived only when the hug happened to land on it.
 *
 * That is why the defect looked child-count-dependent. One child hugged a
 * 300-wide frame to 40; two children hugged the same shape to the 400 the spec
 * asked for, and the second read as a clean pass. The child count changes the
 * hug width, and the hug width is what was being kept.
 *
 * PER AXIS, and only where the caller SAID FIXED. A HUG or FILL axis is a
 * caller's decision to let the layout choose, and a stated size beside it is
 * the contradiction `verifyCreatedSize` reports — not something to overrule.
 *
 * Warns rather than throws: this is a repair on a node that already exists,
 * and `verifyCreatedSize` runs straight after to judge the outcome either way.
 */
export const repinFixedSize = (
  node: SizeTarget,
  size: unknown,
  sizing: unknown,
  warnings?: string[],
): void => {
  if (size === undefined || !Array.isArray(sizing)) return
  const [statedW, statedH] = size as [unknown, unknown]
  const [horizontal, vertical] = sizing as [
    unknown,
    unknown,
  ]
  const pinW =
    horizontal === 'FIXED' && typeof statedW === 'number'
  const pinH =
    vertical === 'FIXED' && typeof statedH === 'number'
  if (!pinW && !pinH) return
  const actual = measured(node)
  if (actual === undefined) return
  const wantW = pinW ? (statedW as number) : actual[0]
  const wantH = pinH ? (statedH as number) : actual[1]
  if (near(actual[0], wantW) && near(actual[1], wantH)) {
    return
  }
  if (typeof node.resize !== 'function') return
  try {
    node.resize(wantW, wantH)
  } catch (e) {
    warnings?.push(
      'size not re-applied after the deferred sizing on ' +
        nodeLabel(node) +
        ': ' +
        String(e),
    )
  }
}

const noResizeWarning = (
  node: SizeTarget,
  warnings?: string[],
): void => {
  warnings?.push(
    'size ignored — a ' +
      typeName(node) +
      ' node cannot be resized',
  )
}

/**
 * Apply `size` on the CREATE path.
 *
 * No read-back and no catch, both deliberate. The spec that named the size also
 * named the node and its type, so there is no arbitrary target to be surprised
 * by — and a throw here reaches `createSingleNode`'s rollback, which is the
 * right answer for a create that cannot be built as asked.
 */
export const applySize = (
  node: SizeTarget,
  size: unknown,
  warnings?: string[],
): void => {
  if (size === undefined) return
  const [width, height] = size as [number, number]
  if (typeof node.resize !== 'function') {
    noResizeWarning(node, warnings)
    return
  }
  node.resize(width, height)
}

/**
 * Apply `size` on an ARBITRARY target, and prove that it landed (B46).
 *
 * `size` is the one field on the common apply path Figma can take without
 * complaint and then ignore: an auto-layout parent owns its child's flexible
 * axes, a text node sizes itself to its content, and a sublayer of an instance
 * can have its geometry refused outright. Each of those returned `warnings: []`
 * on a patch that moved nothing — which is how a chart shipped four identical
 * bars labelled four different numbers, with every read-back reporting success.
 *
 * This is the arm `update_node` and the `update_component` slot loop run — the
 * same "the target was chosen by an id, not by the spec" distinction
 * `capabilityWarnings` draws above. It is also the arm that catches a throw:
 * a raw throw would discard every other field of the patch and report a partial
 * write as a total failure.
 *
 * It runs LAST, after `sizing` and after any text write, because those change
 * the size too and a read-back taken before them is not the patch's outcome.
 * That order also makes `{size, sizing:['FIXED','FIXED']}` land in ONE call: the
 * pin goes on first, and the resize it enables happens here. `statedSizing` is
 * the same patch's `sizing`, carried only so a self-contradicting patch
 * (`FILL` and a size on one axis) is told what it did rather than advised to do
 * what it already refused.
 */
export const applySizeVerified = (
  node: SizeTarget,
  size: unknown,
  warnings?: string[],
  opts?: { statedSizing?: unknown },
): void => {
  if (size === undefined) return
  const [width, height] = size as [number, number]
  if (typeof node.resize !== 'function') {
    noResizeWarning(node, warnings)
    return
  }
  // Read BEFORE the write (B67). A size that changes proves the write landed;
  // a size that was already what was asked for proves nothing either way, and
  // only the reading taken first can tell those apart.
  const before = measured(node)
  try {
    node.resize(width, height)
  } catch (e) {
    warnings?.push('size rejected by Figma: ' + String(e))
    return
  }
  // undefined = nothing to report, either because the size landed or because
  // this target does not expose a width/height to judge it by.
  const mismatch = (): string | undefined =>
    sizeMismatchWarning(
      node,
      width,
      height,
      opts?.statedSizing,
    )
  /** The size landed. Did it LAND, or was it never in doubt? (B67) */
  const settle = (): void => {
    const doubt = unprovenResizeWarning(node, before, [
      width,
      height,
    ])
    if (doubt !== undefined) warnings?.push(doubt)
  }
  let message = mismatch()
  if (message === undefined) {
    settle()
    return
  }
  // Second chance. `resize` applies every child constraint on the way down and
  // can be refused where the constraint-free form is not, so the size worth
  // trying twice is tried twice before anything is called a refusal. Reached
  // only when the first call left at least one axis where it was.
  if (typeof node.resizeWithoutConstraints === 'function') {
    try {
      node.resizeWithoutConstraints(width, height)
    } catch {
      // The mismatch below is the report — a second throw adds nothing to it.
    }
    message = mismatch()
    if (message === undefined) {
      settle()
      return
    }
  }
  warnings?.push(message)
}

/** Structural subset the placement check reads. */
export type PlacedTarget = Partial<{
  name: unknown
  x: unknown
  y: unknown
  layoutPositioning: unknown
}>

/**
 * The position a child STATED, when an auto-layout parent threw it away.
 *
 * undefined for every other case, which is most of them: no position stated,
 * a parent that arranges nothing, an `ABSOLUTE` child that escaped the flow, a
 * node with no readable x/y, and — the one worth spelling out — a child whose
 * flow slot lands where the spec asked for it anyway. That last case is why the
 * check is VALUE-based rather than rule-based: nothing was lost, so nothing is
 * reported, and the message keeps meaning something when it does appear.
 */
const discardedPosition = (
  position: unknown,
  node: PlacedTarget,
  parent: unknown,
): [number, number] | undefined => {
  if (!Array.isArray(position) || position.length !== 2) {
    return undefined
  }
  const [x, y] = position as unknown[]
  if (typeof x !== 'number' || typeof y !== 'number') {
    return undefined
  }
  const layoutMode =
    parent !== null && typeof parent === 'object'
      ? (parent as { layoutMode?: unknown }).layoutMode
      : undefined
  if (
    typeof layoutMode !== 'string' ||
    layoutMode === 'NONE'
  ) {
    return undefined
  }
  if (node.layoutPositioning === 'ABSOLUTE')
    return undefined
  if (
    typeof node.x !== 'number' ||
    typeof node.y !== 'number'
  ) {
    return undefined
  }
  if (near(node.x, x) && near(node.y, y)) return undefined
  return [x, y]
}

/**
 * Report a stated `position` that an auto-layout parent threw away (B35).
 *
 * `update_node` has warned about this ever since it grew its x/y guard. The
 * create path never did — and the create path is where it bites, because the
 * creation default (B29) puts a `layout` on a frame that stated none. A caller
 * who says nothing about layout and everything about where its children go gets
 * a vertical stack and, until now, `warnings: []`. The default itself is
 * specced and stays. What was missing is it saying what it cost.
 *
 * VALUE-checked rather than rule-checked: a child whose flow slot lands exactly
 * where the spec asked for it lost nothing, and warning there would teach the
 * agent to skip the message. `layoutPositioning:'ABSOLUTE'` is the documented
 * escape hatch and stays silent for the same reason — the position survived.
 *
 * Returns undefined when there is nothing to say.
 */
export const statedPositionWarning = (
  position: unknown,
  node: PlacedTarget,
  // `unknown`, not a shape: the create path hands over whatever parent it was
  // given, and a PAGE has no layoutMode to declare.
  parent: unknown,
): string | undefined => {
  const stated = discardedPosition(position, node, parent)
  if (stated === undefined) return undefined
  return (
    'position [' +
    stated[0] +
    ', ' +
    stated[1] +
    '] ignored on ' +
    nodeLabel(node) +
    ' — an auto-layout parent places its children (set layoutPositioning:ABSOLUTE first). It landed at [' +
    String(node.x) +
    ', ' +
    String(node.y) +
    '].'
  )
}

/**
 * Will an auto-layout parent throw away the `position` this PATCH states?
 *
 * The update face's twin of `discardedPosition`, and it asks the question one
 * beat later: not *what is this node now* but *what will it be when this patch
 * has landed*. `layoutPositioning` is written by the same patch, further down
 * the same handler, so reading the node's CURRENT value answered about a node
 * that is on its way out of existence (B76).
 *
 * The cost was a surface arguing with itself. `update_node 549:17000
 * {layoutPositioning:'ABSOLUTE', position:[0,10], …}` answered *"x/y ignored on
 * an auto-layout child (set layoutPositioning:ABSOLUTE first)"* — the remedy
 * the patch was already applying — and dropped the position, defeating the
 * ABSOLUTE re-apply that exists to land it. Re-sending the identical patch
 * WITHOUT `layoutPositioning` then worked.
 *
 * Rule-checked, not value-checked, and it has to be: this runs BEFORE anything
 * is applied, so there is no landed x/y to compare against yet. The create
 * path's check runs after and stays value-based.
 */
export const patchPositionIgnored = (
  spec: Partial<{
    position: unknown
    layoutPositioning: unknown
  }>,
  node: PlacedTarget,
  parent: unknown,
): boolean => {
  if (spec.position === undefined) return false
  const layoutMode =
    parent !== null && typeof parent === 'object'
      ? (parent as { layoutMode?: unknown }).layoutMode
      : undefined
  if (
    typeof layoutMode !== 'string' ||
    layoutMode === 'NONE'
  ) {
    return false
  }
  // A patch that STATES the field owns the answer; one that does not falls
  // back to what the node already holds.
  const effective =
    spec.layoutPositioning ?? node.layoutPositioning
  return effective !== 'ABSOLUTE'
}

/** One child as the placement check sees it: what it asked for, and what it is. */
export type Placement = {
  position: unknown
  node: PlacedTarget
}

/** How many children an aggregated warning names before it starts counting. */
const NAMED_PLACEMENTS = 3

/**
 * Report every stated position ONE auto-layout parent threw away, in one line.
 *
 * The per-child form was the obvious shape and the wrong one. `create_tree`
 * pools every warning in the tree into a single array answered on the root
 * reply, and the B29 default puts `mode:'V'` on every frame-like node that
 * states no layout — so one careless tree hits every child at once, and fifty
 * children cost fifty near-identical lines. This module already answers that
 * with one line and a count (`setRangeProperty`'s `declined` set, T4).
 *
 * One child still reads as the singular sentence. Nothing is aggregated away
 * that a caller would have to reconstruct: the first few children are named
 * with what they asked for and where they landed, and the rest are counted.
 */
export const discardedPositionsWarning = (
  parent: unknown,
  children: readonly Placement[],
): string | undefined => {
  const lost: [Placement, [number, number]][] = []
  for (const child of children) {
    const stated = discardedPosition(
      child.position,
      child.node,
      parent,
    )
    if (stated !== undefined) lost.push([child, stated])
  }
  if (lost.length === 0) return undefined
  if (lost.length === 1) {
    return statedPositionWarning(
      lost[0][0].position,
      lost[0][0].node,
      parent,
    )
  }
  const named = lost
    .slice(0, NAMED_PLACEMENTS)
    .map(
      ([child, stated]) =>
        nodeLabel(child.node) +
        ' [' +
        stated[0] +
        ', ' +
        stated[1] +
        '] → [' +
        String(child.node.x) +
        ', ' +
        String(child.node.y) +
        ']',
    )
  const rest = lost.length - named.length
  return (
    String(lost.length) +
    ' stated positions ignored — an auto-layout parent places its children (set layoutPositioning:ABSOLUTE first): ' +
    named.join(', ') +
    (rest > 0 ? ', and ' + String(rest) + ' more' : '') +
    '.'
  )
}

// ─── post-append: the two writes that need a PARENT (B59, B60) ───────────────
//
// Everything above can be written to a node the instant Figma hands it over.
// These two cannot: Figma judges both against the node's PARENT, and on the
// create path a fresh node is parented to the current page until `appendChild`
// runs. Applying them any earlier asks Figma about a parent the spec never
// named.

/** Structural subset the sizing applier writes to (the two auto-layout axes). */
export type SizingTarget = Partial<{
  type: unknown
  name: unknown
  width: unknown
  height: unknown
  children: unknown
  parent: unknown
  layoutSizingHorizontal: unknown
  layoutSizingVertical: unknown
}>

/** The two axes, in the order `sizing: [h, v]` states them. */
const AXES = ['horizontal', 'vertical'] as const
type Axis = 0 | 1

/** The axis a frame LAYS OUT along, or undefined when it lays out nothing. */
const primaryAxisOf = (
  parent: unknown,
): Axis | undefined => {
  try {
    const mode = (parent as { layoutMode?: unknown })
      ?.layoutMode
    if (mode === 'HORIZONTAL') return 0
    if (mode === 'VERTICAL') return 1
    // GRID lays out on both and resolves a FILL child per track, which is a
    // different rule; nothing here claims to know it.
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a frame HUGS a given axis — asks its children how big to be.
 *
 * `layoutSizing*` is preferred over `primaryAxisSizingMode`/
 * `counterAxisSizingMode` for the reason `feed/write-scope.ts` already gives:
 * the older pair does not describe a GRID frame, and a runtime that answers
 * both must be read through the newer one.
 */
const hugsAxis = (
  parent: unknown,
  axis: Axis,
): boolean | undefined => {
  try {
    const f = parent as Record<string, unknown>
    const field =
      axis === 0
        ? 'layoutSizingHorizontal'
        : 'layoutSizingVertical'
    const stated = f[field]
    if (typeof stated === 'string') {
      return stated === 'HUG'
    }
    const primary = primaryAxisOf(parent)
    if (primary === undefined) return undefined
    const legacy =
      axis === primary
        ? f.primaryAxisSizingMode
        : f.counterAxisSizingMode
    return typeof legacy === 'string'
      ? legacy === 'AUTO'
      : undefined
  } catch {
    return undefined
  }
}

/** One node's span on an axis, when it will say. */
const spanOn = (
  node: unknown,
  axis: Axis,
): number | undefined => {
  try {
    const value = (node as Record<string, unknown>)?.[
      axis === 0 ? 'width' : 'height'
    ]
    return typeof value === 'number' ? value : undefined
  } catch {
    return undefined
  }
}

/** What this node's own children need on `axis`, when they will all say. */
const childrenSpan = (
  node: SizingTarget,
  axis: Axis,
): number | undefined => {
  try {
    const kids = node.children
    if (!Array.isArray(kids) || kids.length === 0) {
      return undefined
    }
    let total = 0
    for (const kid of kids as unknown[]) {
      const span = spanOn(kid, axis)
      if (span === undefined) return undefined
      total += span
    }
    return total
  } catch {
    return undefined
  }
}

/**
 * How many ancestors the master walk climbs before it gives up.
 *
 * A Figma tree is a few dozen levels at worst; the bound is here so a cyclic
 * fake cannot hang a dispatch, never as a real limit.
 */
const MAX_MASTER_HOPS = 32

/** How this parent sizes itself on `axis`, in Figma's own words. */
const axisSizingOf = (
  parent: unknown,
  axis: Axis,
): string | undefined => {
  try {
    const value = (parent as Record<string, unknown>)[
      axis === 0
        ? 'layoutSizingHorizontal'
        : 'layoutSizingVertical'
    ]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether this node lives inside a COMPONENT master (B80 refinement).
 *
 * A master's own geometry is a TEMPLATE, and the circular pair inside one does
 * not mean what it means on a screen: every INSTANCE of the row overrides its
 * width to FILL, which un-hugs the parent and re-enables the FILL child.
 * Proved live 2026-09-01 on four designated flex columns across three tables —
 * none collapsed, and their sizes were stable across re-writes.
 *
 * `undefined` for a walk that could not finish: an unknown must not be reported
 * as a finding, and must not suppress one either.
 */
const insideMaster = (
  node: unknown,
): boolean | undefined => {
  let current = node
  for (let hop = 0; hop < MAX_MASTER_HOPS; hop++) {
    let parent: unknown
    try {
      parent = (current as { parent?: unknown })?.parent
    } catch {
      return undefined
    }
    if (typeof parent !== 'object' || parent === null) {
      return false
    }
    let type: unknown
    try {
      type = (parent as { type?: unknown }).type
    } catch {
      return undefined
    }
    if (type === 'COMPONENT' || type === 'COMPONENT_SET') {
      return true
    }
    current = parent
  }
  return undefined
}

/**
 * A FILL child that came out SMALLER than its own contents need (B80).
 *
 * Two parents starve a FILL child, and the first cut of this warning named
 * only one of them:
 *
 *   the CIRCULAR pair  — the parent HUGS the same axis, so each asks the other
 *                        how big to be and Figma resolves it at the minimum.
 *   a STARVED parent   — the parent is FIXED at less than the child needs, so
 *                        the FILL child gets a share that cannot hold its own
 *                        contents.
 *
 * THE REFINEMENT, and both halves come from one live round. The first cut
 * warned on the circular PAIR alone, by shape, and stream 3 (2026-09-01) showed
 * that reads wrong in BOTH directions: it fired on four designated flex columns
 * across three tables that do not collapse — a master is a template, and every
 * row INSTANCE overrides its width to FILL, which un-hugs the parent and
 * re-enables the child — while the collapse it was filed for, the `Token cell`
 * at 12px with 56px of children in it, was under a STARVED FIXED parent that
 * the shape rule never looked at.
 *
 * So the finding is the COLLAPSE, not the pair: warn when the numbers say this
 * node ended up smaller than its contents, whichever parent did it. The pair is
 * still named on its own where no numbers exist yet — an empty frame at create
 * time can only be judged by shape, and author time is when the caller can
 * still act on it — except inside a master, where the shape is not evidence.
 *
 * WARN, NEVER REFUSE. B58 refused its self-contradictory pair because Figma
 * destroys that one on the next click; Figma TOLERATES this one and resolves
 * it, so refusing would block a write the file accepts.
 *
 * ON THE PRIMARY AXIS ONLY, and deliberately. That axis is where a hug means
 * *the sum of my children*. The COUNTER axis hug means *the largest of my
 * children*, where a FILL child stretching to the tallest sibling is ordinary
 * and correct, and warning on it would be noise on a very common shape.
 */
export const fillCollapseWarning = (
  node: SizingTarget,
  sizing: unknown,
): string | undefined => {
  if (!Array.isArray(sizing) || sizing.length < 2) {
    return undefined
  }
  let parent: unknown
  try {
    parent = node.parent
  } catch {
    return undefined
  }
  const axis = primaryAxisOf(parent)
  if (axis === undefined) return undefined
  if (sizing[axis] !== 'FILL') return undefined

  const own = spanOn(node, axis)
  const needed = childrenSpan(node, axis)
  const measured = own !== undefined && needed !== undefined
  const collapsed = measured && own < needed
  const hugs = hugsAxis(parent, axis) === true

  let parentName = ''
  try {
    const name = (parent as { name?: unknown }).name
    if (typeof name === 'string' && name !== '') {
      parentName = ' "' + name + '"'
    }
  } catch {
    // An unnamed parent still makes the sentence; a thrown name does not.
  }
  const overflow =
    ' It resolved to ' +
    String(own) +
    'px while its children need ' +
    String(needed) +
    'px, so they overflow it.'

  if (collapsed && !hugs) {
    // The STARVED parent — the shape the Token cell actually had, and the one
    // the pair rule could not see.
    const parentSpan = spanOn(parent, axis)
    const parentSizing = axisSizingOf(parent, axis)
    return (
      nodeLabel(node) +
      ' FILLs the ' +
      AXES[axis] +
      ' axis, and its parent' +
      parentName +
      ' has less room than this node needs.' +
      overflow +
      (parentSpan === undefined
        ? ''
        : ' The parent is ' +
          (parentSizing === undefined
            ? ''
            : parentSizing + ' at ') +
          String(parentSpan) +
          'px on that axis.') +
      ' Widen the parent, or give this node a FIXED or HUG ' +
      AXES[axis] +
      ' size.'
    )
  }

  if (!hugs) return undefined
  if (!collapsed) {
    // The circular pair with no collapse to show for it. MEASURED and fine, or
    // inside a master where the shape is not evidence — an instance re-enables
    // the child. Either way it is not a finding.
    if (measured) return undefined
    if (insideMaster(node) !== false) return undefined
  }
  return (
    nodeLabel(node) +
    ' FILLs the ' +
    AXES[axis] +
    ' axis while its parent' +
    parentName +
    ' HUGS the same axis. The two ask each other how big to be, so Figma ' +
    'collapses this node to its minimum.' +
    (collapsed ? overflow : '') +
    ' Give this node a FIXED or HUG ' +
    AXES[axis] +
    ' size, or give the parent a FIXED or FILL one.'
  )
}

/**
 * A `wrap` that can never fire, because nothing bounds the line (I86).
 *
 * The exact mirror of `fillCollapseWarning` above, and the trap that defeated
 * S58. A HUG container sizes to its content, so a horizontal row of children
 * that overflows simply makes the container wider — there is no width for a
 * line to run out of, and wrap is dead. Operator-filed 2026-09-02: `wrap:true`
 * on the top-bar action cluster and on a segmented-control track, expecting
 * reflow at narrow widths. The only symptom was silent overhang and clipping,
 * found by the operator's own squeeze probe at 469px of content against 432px
 * of inner width.
 *
 * A MAXWIDTH IS A BOUND. `maxWidth` on a HUG frame caps the line, so wrap does
 * fire and there is nothing to report — which is also half the remedy the
 * message names.
 *
 * HORIZONTAL only, because that is the only mode Figma offers wrap on. A
 * vertical frame carrying the flag is a different question and this does not
 * claim to answer it.
 *
 * READ AFTER THE WRITE, off the node itself rather than off the spec: `layout`
 * and `sizing` are two halves of one instruction that land at different times
 * on the create path (B60), and only the node knows what it ended up with.
 */
export const deadWrapWarning = (
  node: unknown,
): string | undefined => {
  let wrap: unknown
  let mode: unknown
  let max: unknown
  try {
    const f = node as Record<string, unknown>
    wrap = f.layoutWrap
    mode = f.layoutMode
    max = f.maxWidth
  } catch {
    // A node that will not answer cannot be judged, and an unknown must not
    // read as a finding.
    return undefined
  }
  if (wrap !== 'WRAP' || mode !== 'HORIZONTAL') {
    return undefined
  }
  if (typeof max === 'number') return undefined
  if (hugsAxis(node, 0) !== true) return undefined
  return (
    nodeLabel(node as { name?: unknown }) +
    ' sets wrap while it HUGS its horizontal axis, so nothing bounds the ' +
    'line and its children never wrap — the row just gets wider, and ' +
    'overflows whatever holds it. Give this node a FILL or FIXED horizontal ' +
    'size, or a maxWidth.'
  )
}

/**
 * Apply `sizing: [horizontal, vertical]` — the auto-layout FIXED/HUG/FILL pair.
 *
 * Both axes go in ONE try, exactly as this write has always been made: Figma
 * refuses `FILL` unless the node is a child of an auto-layout frame, and `HUG`
 * unless the node is an auto-layout frame itself, and a refusal is a degrade
 * (T7) rather than a lost node — the caller is told and the build continues.
 *
 * A FILL or HUG axis makes Figma RESIZE the node, which is why this applier
 * exists as its own unit (B60). On the `create_tree` path the resize has to
 * wait until the node's children are in it and their constraints are set,
 * otherwise the collapse happens behind their back and no constraint ever
 * re-anchors them. See `createTreeNode` in code.ts.
 */
export const applySizing = (
  node: SizingTarget,
  sizing: unknown,
  warnings?: string[],
): void => {
  if (sizing === undefined) return
  const [h, v] = sizing as [string, string]
  try {
    node.layoutSizingHorizontal = h
    node.layoutSizingVertical = v
  } catch (e) {
    warnings?.push(
      'sizing not applicable on this node (' +
        typeName(node) +
        '): ' +
        String(e),
    )
    return
  }
  // B80 — the write LANDED, and that is the whole problem: Figma takes the
  // circular pair and collapses the node, so nothing throws and nothing warns.
  // Read AFTER the assignment, so the node's own span is the one this call
  // produced.
  const collapse = fillCollapseWarning(node, sizing)
  if (collapse !== undefined) {
    warnings?.push(collapse)
  }
  // I86 — the mirror finding, on the same read-after-write. `sizing` is the
  // half that decides it, so this is the moment the node's wrap can be judged.
  const deadWrap = deadWrapWarning(node)
  if (deadWrap !== undefined) {
    warnings?.push(deadWrap)
  }
}

/** The four auto-layout size clamps, in the order a spec is scanned. */
const CLAMP_FIELDS = [
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
] as const

/** Structural subset the clamp applier writes to. */
export type MinMaxTarget = Partial<{
  type: unknown
  name: unknown
  minWidth: unknown
  maxWidth: unknown
  minHeight: unknown
  maxHeight: unknown
}>

/** The four flat clamp keys the writer emits (node-spec-writer.ts). */
export type MinMaxSpec = {
  minWidth?: unknown
  maxWidth?: unknown
  minHeight?: unknown
  maxHeight?: unknown
}

/**
 * Apply the four auto-layout size clamps (B59).
 *
 * Figma accepts a clamp only on an auto-layout frame or on a DIRECT CHILD of
 * one — "Can only set maxWidth on auto layout nodes and their children" — so
 * the answer depends on a parent, and until `appendChild` runs the parent is
 * whatever page Figma auto-parented the fresh node to. Applied there, a
 * perfectly valid tree threw: a TEXT node carrying `maxWidth` is never an
 * auto-layout node itself, so the only thing that can make the write legal is
 * the auto-layout parent it was about to be appended to.
 *
 * A refusal THROWS rather than warning, and that is deliberate. Reaching this
 * applier post-append means the node is already where the spec put it, so a
 * refusal says the stated END STATE is invalid — a clamp on a frame whose
 * layout is NONE inside a parent whose layout is NONE is not a degrade, it is a
 * spec Figma cannot build. The create path turns the throw into a rollback and
 * one error envelope. The message names the field, the value and the node, so
 * the caller does not have to guess which of a tree's nodes Figma refused.
 */
export const applyMinMax = (
  node: MinMaxTarget,
  spec: MinMaxSpec,
  warnings?: string[],
): void => {
  for (const field of CLAMP_FIELDS) {
    const value = spec[field]
    if (value === undefined) continue
    // T7 feature-detect: a node type that carries no clamp at all (a SLICE, a
    // page-level target under update_node) is a no-op with a note, never a
    // throw — there is no parent that could make the write legal.
    if (!(field in node)) {
      warnings?.push(
        field +
          ' ignored — not supported on a ' +
          typeName(node) +
          ' node',
      )
      continue
    }
    try {
      node[field] = value
    } catch (e) {
      throw new Error(
        field +
          ' ' +
          String(value) +
          ' rejected on ' +
          nodeLabel(node) +
          ' — Figma accepts min/max sizing only on an auto-layout frame or a direct child of one: ' +
          String(e),
      )
    }
  }
}
