// Field appliers for the flat NodeSpec keys the server writer emits beside the
// main apply path: stroke geometry (strokeCap/strokeJoin/strokeMiterLimit),
// per-side stroke weights, exportSettings, and node-level layout grids. Same
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
