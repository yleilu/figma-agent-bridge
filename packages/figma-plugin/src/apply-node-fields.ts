// Field appliers for the flat NodeSpec keys the server writer emits beside the
// main apply path: stroke geometry (strokeCap/strokeJoin/strokeMiterLimit),
// per-side stroke weights, exportSettings, node-level layout grids, and `size`
// — the one geometry field Figma can accept and then quietly overrule. Same
// shape as `apply-layout.ts`: each function
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
  if (
    spec.strokeCap !== undefined &&
    'strokeCap' in node
  ) {
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
    !Array.isArray((setting as { constraint?: unknown }).constraint)
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
// `size` is a field Figma ACCEPTS and then overrules. Nothing throws, nothing
// is dropped by a capability guard, and the node simply keeps the size it had.
// Every other applier here can trust its assignment. This one reads the value
// back.

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
  let current = node.parent as
    | Ancestor
    | null
    | undefined
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
  try {
    node.resize(width, height)
  } catch (e) {
    warnings?.push('size rejected by Figma: ' + String(e))
    return
  }
  // undefined = nothing to report, either because the size landed or because
  // this target does not expose a width/height to judge it by. Silence on an
  // unmeasurable node is deliberate: a warning nobody can verify is noise.
  const mismatch = (): [number, number] | undefined => {
    const actual = measured(node)
    if (actual === undefined) return undefined
    return near(actual[0], width) && near(actual[1], height)
      ? undefined
      : actual
  }
  let actual = mismatch()
  if (actual === undefined) return
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
    actual = mismatch()
    if (actual === undefined) return
  }
  warnings?.push(
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
        opts?.statedSizing,
      ),
  )
}
