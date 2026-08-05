// Pure, side-effect-free field appliers for three flat NodeSpec keys the
// server writer has emitted for a while but the plugin never read: stroke
// geometry (strokeCap/strokeJoin/strokeMiterLimit), exportSettings, and
// node-level layout grids. Same shape as `apply-layout.ts`: each function
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
