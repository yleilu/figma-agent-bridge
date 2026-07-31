// serialize/node-spec-reader.ts — raw Figma export (JSON_REST_V1) → NodeSpec.
//
// The READ FACE of the grammar: every appearance leaf is rendered to an atom
// STRING via paintToAtom / effectToAtom / fontToAtom / strokeToAtom. Structs
// (layout / text / overrides) are assembled into the node-spec.ts shapes.
//
// FIDELITY-FIRST: this module must NOT import read/project's truncation cap or
// any size-driven trimming. It applies `depth` only (children past the boundary
// collapse to IdStub for drill-by-id); deep subtrees are returned complete.
// A source-level test enforces the absence of that import.
//
// var()/style() read-back: a bound leaf renders with its var(<name>)/
// style(<name>) wrapper on the leaf atom — the design-system NAME, never
// the opaque runtime id (expression-formats.md "var() / style() rules").
// There is no boundVariables field on NodeSpec — the binding rides on the
// appearance atom, rendered through the ONE grammar renderer
// (render-atom.ts's renderWrapper — T8, no hand-concatenation).
//
// Both wrappers are ROOT-ONLY (T10): `bindingNames` is a field the plugin
// populates only on the directly-requested export root (mirrors
// component.key). This module receives it as a plain parameter threaded
// from `toNodeSpec` and NEVER forwards it into a recursive `buildNode` call
// for children — so a descendant can never pick up a wrapper, even if it
// happens to reuse the same variable id the root resolved a name for.

import type {
  NodeSpec,
  NodeSpecOrStub,
  IdStub,
  LayoutSpec,
  TextSpec,
  TextRun,
  OverrideEntry,
  ExportSetting,
} from '@figma-agent-bridge/shared/node-spec'
import {
  paintToAtom,
  effectToAtom,
  fontToAtom,
  strokeToAtom,
  pathToAtom,
  gridToAtom,
  renderWrapper,
  handlesToTransform,
  type FigmaPaint,
  type FigmaEffect,
  type FigmaFontName,
  type FigmaStrokeGeom,
  type FigmaLayoutGrid,
  type RGBA,
  type Transform,
} from '../grammar'

// ─── raw (JSON_REST_V1) shapes we read from ───────────────────────────────────

type RawNode = Record<string, unknown>

type RawColor = {
  r: number
  g: number
  b: number
  a?: number
}

type RawBoundVariable = { id: string; type: string }

/**
 * Task 1's plugin enrichment, present on `raw.bindingNames` for the export
 * ROOT only: `styles` maps a grammar field name (fill/stroke/effect/text) to
 * the bound style's NAME; `variables` maps a variable id to its NAME. Both
 * are resolved lookups (may omit an id/field the plugin's runtime couldn't
 * resolve) — see the "never fall back to the id" rule below.
 */
type BindingNames = {
  styles?: Record<string, string>
  variables?: Record<string, string>
}

/**
 * The one place a bound leaf decides its wrapper: a style binding always
 * wins over a variable binding on the same leaf (apply_style is the coarser
 * route — Figma resolves the style's own paint through it). Renders through
 * the shared grammar renderer, never string concatenation. Returns `''`
 * (no wrapper) when neither name is known — this is what keeps an
 * unresolvable binding a BARE atom instead of falling back to the id.
 */
const wrapperFor = (
  styleName: string | undefined,
  varName: string | undefined,
): string =>
  styleName !== undefined
    ? renderWrapper({ kind: 'style', name: styleName })
    : varName !== undefined
      ? renderWrapper({ kind: 'var', name: varName })
      : ''

/** Look up a variable id's resolved name; undefined if unbound/unresolved. */
const variableNameFor = (
  id: string | undefined,
  bindingNames: BindingNames | undefined,
): string | undefined =>
  id === undefined
    ? undefined
    : bindingNames?.variables?.[id]

/**
 * Node-level `boundVariables` (scalar fields — radius, stroke weight, …).
 *
 * JSON_REST_V1's OWN vocabulary here does NOT mirror the Plugin API's flat
 * field names (`topLeftRadius`, `strokeWeight`, …) — live-verified
 * (2026-07-31, bind_variable → raw GET_NODE): a per-corner/per-side scalar
 * binding surfaces one level deeper, under a REST-specific container keyed
 * by an ALL-CAPS positional constant. A `topLeftRadius` Plugin-API binding
 * reads back as `boundVariables.rectangleCornerRadii.
 * RECTANGLE_TOP_LEFT_CORNER_RADIUS`; a `strokeWeight` binding reads back as
 * FOUR entries under `boundVariables.individualStrokeWeights` (one per
 * `BORDER_*_WEIGHT` side, all aliasing the same variable). This is why
 * `radiusAtom`/`strokeGeom` look up the NESTED shape, not a flat key.
 */
const nodeBoundVariables = (
  raw: RawNode,
): Record<string, unknown> | undefined => {
  const bound = raw.boundVariables
  return bound !== null && typeof bound === 'object'
    ? (bound as Record<string, unknown>)
    : undefined
}

/** A flat (un-nested) node-level bound-variable id, e.g. `opacity`. */
const flatAliasId = (
  bound: Record<string, unknown> | undefined,
  key: string,
): string | undefined =>
  (bound?.[key] as RawBoundVariable | undefined)?.id

/**
 * A REST-nested bound-variable id: `bound[container][positionalKey].id`,
 * trying each positional key in turn (per-corner/per-side bindings that all
 * alias the same variable resolve to the first match either way).
 */
const nestedAliasId = (
  bound: Record<string, unknown> | undefined,
  container: string,
  positionalKeys: readonly string[],
): string | undefined => {
  const nested = bound?.[container] as
    | Record<string, RawBoundVariable>
    | undefined
  if (nested === undefined) {
    return undefined
  }
  for (const key of positionalKeys) {
    const id = nested[key]?.id
    if (id !== undefined) {
      return id
    }
  }
  return undefined
}

type RawPaint = {
  type: string
  visible?: boolean
  opacity?: number
  blendMode?: string
  color?: RawColor
  gradientStops?: { position: number; color: RGBA }[]
  gradientTransform?: number[][]
  /** JSON_REST_V1 emits handles instead of gradientTransform. */
  gradientHandlePositions?: { x: number; y: number }[]
  imageRef?: string
  imageHash?: string
  scaleMode?: string
  /** Image `{tile=}` — Figma's ImagePaint.scalingFactor (TILE mode only). */
  scalingFactor?: number
  /** Image `{rot=}` — confirmed present on a live raw export (90/180/270). */
  rotation?: number
  boundVariables?: { color?: RawBoundVariable }
}

type RawEffect = {
  type: string
  visible?: boolean
  color?: RGBA
  offset?: { x: number; y: number }
  radius?: number
  spread?: number
  blendMode?: string
  showShadowBehindNode?: boolean
}

type RawTextStyle = {
  fontFamily?: string
  fontStyle?: string
  fontSize?: number
  textAlignHorizontal?: string
  textAlignVertical?: string
  lineHeightPx?: number
  lineHeightPercent?: number
  lineHeightUnit?: string
  letterSpacing?: number
  textDecoration?: string
  textCase?: string
  paragraphSpacing?: number
}

// ─── small helpers ────────────────────────────────────────────────────────────

const num = (v: unknown): number | undefined =>
  typeof v === 'number' ? v : undefined

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined

/**
 * Translate a single REST constraint value (JSON_REST_V1 vocab) to the Plugin-API
 * vocab used by the spec/writer. REST uses LEFT/RIGHT/TOP/BOTTOM/LEFT_RIGHT/
 * TOP_BOTTOM, the Plugin API uses MIN/MAX/STRETCH (CENTER and SCALE are shared).
 * Any unmapped value — including an already-Plugin value like MIN/MAX — passes
 * through UNCHANGED, since the schema tuple has no enum and we must not corrupt a
 * value that is already in Plugin vocab.
 */
const restConstraintToPlugin = (value: string): string => {
  switch (value) {
    case 'LEFT':
    case 'TOP':
      return 'MIN'
    case 'RIGHT':
    case 'BOTTOM':
      return 'MAX'
    case 'LEFT_RIGHT':
    case 'TOP_BOTTOM':
      return 'STRETCH'
    default:
      return value
  }
}

const sizeOf = (raw: RawNode): [number, number] => {
  // Prefer raw.width/height (enriched by plugin — unrotated geometry) over
  // absoluteBoundingBox (axis-aligned bbox, inflated when node is rotated).
  // B7: a rotated node's bbox ≠ its actual dimensions; the plugin enrichment
  // adds width/height via node.width/node.height which are always unrotated.
  const w = num(raw.width)
  const h = num(raw.height)
  if (w !== undefined && h !== undefined) {
    return [w, h]
  }
  const bbox = raw.absoluteBoundingBox as
    | { width: number; height: number }
    | undefined
  if (bbox !== undefined && bbox !== null) {
    return [bbox.width, bbox.height]
  }
  return [w ?? 0, h ?? 0]
}

type RawBBox = { x?: number; y?: number }

const bboxOf = (raw: RawNode): RawBBox | undefined => {
  const bbox = raw.absoluteBoundingBox as
    | RawBBox
    | undefined
  if (
    bbox !== undefined &&
    bbox !== null &&
    typeof bbox.x === 'number' &&
    typeof bbox.y === 'number'
  ) {
    return bbox
  }
  return undefined
}

/**
 * Node position [x,y]. The WRITER maps spec.position → node.x/node.y, which in
 * Figma is PARENT-RELATIVE. The authoritative source is the relativeTransform
 * translation `[[a,b,x],[c,d,y]] → [x,y]`, but JSON_REST_V1 does not emit a
 * relativeTransform (only absoluteBoundingBox), so we derive parent-relative
 * position from the bbox hierarchy: `child.bbox − parent.bbox`. When no parent
 * bbox is threaded in (the export ROOT), fall back to the absolute bbox origin —
 * the root has no parent-relative frame. Returns undefined only when neither a
 * transform nor a bbox is present, so the field stays out of the spec.
 *
 * NOTE: the bbox-difference is correct for UNROTATED nodes only. For a rotated
 * node the bbox corner is not the node origin, and JSON_REST_V1 lacks the
 * transform that would recover it — this is a known limitation.
 */
const positionOf = (
  raw: RawNode,
  parentBBox: RawBBox | undefined,
): [number, number] | undefined => {
  const tf = raw.relativeTransform as number[][] | undefined
  if (
    Array.isArray(tf) &&
    tf.length === 2 &&
    Array.isArray(tf[0]) &&
    Array.isArray(tf[1]) &&
    typeof tf[0][2] === 'number' &&
    typeof tf[1][2] === 'number'
  ) {
    return [tf[0][2], tf[1][2]]
  }
  const bbox = bboxOf(raw)
  if (bbox === undefined) {
    return undefined
  }
  if (
    parentBBox !== undefined &&
    typeof parentBBox.x === 'number' &&
    typeof parentBBox.y === 'number'
  ) {
    return [
      (bbox.x as number) - parentBBox.x,
      (bbox.y as number) - parentBBox.y,
    ]
  }
  return [bbox.x as number, bbox.y as number]
}

// ─── paint: raw → FigmaPaint → atom (with var() wrapper) ──────────────────────

/** Convert a JSON_REST_V1 paint to the grammar's FigmaPaint shape. */
const rawToFigmaPaint = (
  p: RawPaint,
): FigmaPaint | null => {
  if (p.type === 'SOLID' && p.color !== undefined) {
    // JSON_REST_V1 folds alpha into color.a; FigmaSolidPaint keeps a separate
    // opacity and an RGB color. Combine color alpha with paint opacity.
    const a = p.color.a ?? 1
    const effectiveOpacity = a * (p.opacity ?? 1)
    const out: FigmaPaint = {
      type: 'SOLID',
      color: { r: p.color.r, g: p.color.g, b: p.color.b },
    }
    if (effectiveOpacity < 1) {
      out.opacity = effectiveOpacity
    }
    if (p.visible === false) {
      out.visible = false
    }
    if (
      p.blendMode !== undefined &&
      p.blendMode !== 'NORMAL'
    ) {
      out.blendMode = p.blendMode
    }
    return out
  }
  if (
    (p.type === 'GRADIENT_LINEAR' ||
      p.type === 'GRADIENT_RADIAL' ||
      p.type === 'GRADIENT_ANGULAR' ||
      p.type === 'GRADIENT_DIAMOND') &&
    p.gradientStops !== undefined
  ) {
    // Prefer gradientHandlePositions (JSON_REST_V1 path) over gradientTransform
    // (Plugin-API path). When REST exports a gradient it omits gradientTransform
    // and emits gradientHandlePositions instead — falling back to the identity
    // matrix gives linear(0) regardless of the real direction (B1 / T2).
    //
    // A real JSON_REST_V1 export always sends all 3 handles (start/end/width
    // for LINEAR; center/major/minor for RADIAL, ANGULAR, DIAMOND), and the
    // full transform (skew, non-uniform scale included) is recoverable from
    // that triple for all four gradient types — see handlesToTransform
    // (grammar/figma-paint.ts) and its live-verify notes (issue-5).
    const handles = p.gradientHandlePositions
    const tf = p.gradientTransform
    const gradientTransform: Transform = (() => {
      // Full-geometry path: 3 handles recover the exact transform (incl.
      // skew / non-uniform scale) for any of the four gradient types.
      if (handles !== undefined && handles.length >= 3) {
        const derived = handlesToTransform(handles, p.type)
        if (derived !== undefined) {
          return derived
        }
      }
      // 2-handle fallback: angle-only derivation from the start→end vector.
      // LINEAR only — legacy/defensive path. Real JSON_REST_V1 exports
      // always send 3 handles; this only matters for a hand-built fixture
      // (or a degenerate 3-handle triple handlesToTransform declined).
      // p1 = handles[0] (gradient start), p2 = handles[1] (gradient end).
      if (
        p.type === 'GRADIENT_LINEAR' &&
        handles !== undefined &&
        handles.length >= 2
      ) {
        const p1 = handles[0]
        const p2 = handles[1]
        const dx = p2.x - p1.x
        const dy = p2.y - p1.y
        const len = Math.sqrt(dx * dx + dy * dy) || 1
        const cos = dx / len
        const sin = dy / len
        // Build a rotation matrix consistent with angleToTransform / transformToAngle.
        const e = 0.5 - (cos * 0.5 + sin * 0.5)
        const f = 0.5 - (-sin * 0.5 + cos * 0.5)
        return [
          [cos, sin, e],
          [-sin, cos, f],
        ] as Transform
      }
      // gradientTransform path: Plugin-API / older REST export.
      if (tf !== undefined && tf.length === 2) {
        return [
          [tf[0][0], tf[0][1], tf[0][2]],
          [tf[1][0], tf[1][1], tf[1][2]],
        ] as Transform
      }
      // Identity fallback (should not be reached for well-formed Figma data).
      return [
        [1, 0, 0],
        [0, 1, 0],
      ] as Transform
    })()
    const out: FigmaPaint = {
      type: p.type,
      gradientStops: p.gradientStops,
      gradientTransform,
    }
    if (p.opacity !== undefined && p.opacity < 1) {
      out.opacity = p.opacity
    }
    if (p.visible === false) {
      out.visible = false
    }
    if (
      p.blendMode !== undefined &&
      p.blendMode !== 'NORMAL'
    ) {
      out.blendMode = p.blendMode
    }
    return out
  }
  if (p.type === 'IMAGE') {
    const out: FigmaPaint = {
      type: 'IMAGE',
      imageHash: p.imageRef ?? p.imageHash ?? null,
    }
    if (p.scaleMode !== undefined) {
      out.scaleMode = p.scaleMode
    }
    if (p.scalingFactor !== undefined) {
      out.scalingFactor = p.scalingFactor
    }
    if (p.rotation !== undefined && p.rotation !== 0) {
      out.rotation = p.rotation
    }
    if (p.opacity !== undefined && p.opacity < 1) {
      out.opacity = p.opacity
    }
    if (p.visible === false) {
      out.visible = false
    }
    if (
      p.blendMode !== undefined &&
      p.blendMode !== 'NORMAL'
    ) {
      out.blendMode = p.blendMode
    }
    return out
  }
  return null
}

/**
 * Render a paint leaf to an atom string, wrapping it in style(<name>) or
 * var(<name>) (binding read-back) — a style binding wins over a variable
 * binding on the same leaf. `styleName` is the caller's resolved
 * `bindingNames.styles[<field>]` for the array this paint lives in
 * (fills → 'fill', strokes → 'stroke'); `bindingNames` supplies the
 * variable-id → name lookup for this paint's own `boundVariables.color`.
 */
const paintLeaf = (
  p: RawPaint,
  styleName: string | undefined,
  bindingNames: BindingNames | undefined,
): string | null => {
  const figma = rawToFigmaPaint(p)
  if (figma === null) {
    return null
  }
  const atom = paintToAtom(figma)
  const varName = variableNameFor(
    p.boundVariables?.color?.id,
    bindingNames,
  )
  return wrapperFor(styleName, varName) + atom
}

const paintArray = (
  raw: unknown,
  styleName: string | undefined,
  bindingNames: BindingNames | undefined,
): string[] | undefined => {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const atoms = (raw as RawPaint[])
    .filter(p => p.visible !== false)
    .map(p => paintLeaf(p, styleName, bindingNames))
    .filter((a): a is string => a !== null)
  return atoms.length > 0 ? atoms : undefined
}

// ─── effects ──────────────────────────────────────────────────────────────────

const effectArray = (
  raw: unknown,
  styleName: string | undefined,
): string[] | undefined => {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const wrapper = wrapperFor(styleName, undefined)
  const atoms = (raw as RawEffect[])
    .filter(e => e.visible !== false)
    .map(e => {
      const figma: FigmaEffect = {
        type: e.type as FigmaEffect['type'],
        radius: e.radius ?? 0,
      }
      if (e.color !== undefined) {
        figma.color = e.color
      }
      if (e.offset !== undefined) {
        figma.offset = e.offset
      }
      if (e.spread !== undefined && e.spread !== 0) {
        figma.spread = e.spread
      }
      if (
        e.blendMode !== undefined &&
        e.blendMode !== 'NORMAL'
      ) {
        figma.blendMode = e.blendMode
      }
      if (e.showShadowBehindNode === true) {
        figma.showShadowBehindNode = true
      }
      return wrapper + effectToAtom(figma)
    })
  return atoms.length > 0 ? atoms : undefined
}

// ─── stroke geometry ──────────────────────────────────────────────────────────

const strokeGeom = (
  raw: RawNode,
  bindingNames: BindingNames | undefined,
): string | undefined => {
  const weight = num(raw.strokeWeight)
  if (weight === undefined || weight <= 0) {
    return undefined
  }
  const geom: FigmaStrokeGeom = { weight }
  const align = str(raw.strokeAlign)
  if (align !== undefined && align !== 'CENTER') {
    geom.align = align
  }
  // strokeCap IS carried by JSON_REST_V1; strokeJoin / strokeMiterLimit are
  // NOT — they are plugin-enriched (see exportNodeDocument in code.ts), since
  // JSON_REST_V1 omits them.
  //
  // Every key here is elided at its Figma default: align/CENTER, cap/NONE,
  // join/MITER, miter/4. expression-formats.md:276 — "only emitted when
  // non-default (T4)" — and its worked example of a read (:286) is
  // `stroke(1, {align=INSIDE})`, carrying neither join nor miter. The
  // all-keys example at :174 is the SYNTAX reference, not a depiction of what
  // a read emits; reading it as the latter is what put default noise on every
  // stroked node.
  //
  // Eliding a default is lossless for the round-trip (T2): the writer then
  // sends nothing for that key and Figma keeps the same default, so the node
  // is unchanged. Only a NON-default value has to survive, and it still does.
  const cap = str(raw.strokeCap)
  if (cap !== undefined && cap !== 'NONE') {
    geom.cap = cap
  }
  const join = str(raw.strokeJoin)
  if (join !== undefined && join !== 'MITER') {
    geom.join = join
  }
  const miter = num(raw.strokeMiterLimit)
  if (miter !== undefined && miter !== 4) {
    geom.miter = miter
  }
  const dash = raw.dashPattern
  if (Array.isArray(dash) && dash.length > 0) {
    geom.dash = dash as number[]
  }
  // strokeWeight is a scalar VariableBindableNodeField (node-level
  // boundVariables, not paint-level) — distinct from the strokes[] paint
  // bindings paintArray already handles. REST nests a bound strokeWeight
  // under individualStrokeWeights.BORDER_*_WEIGHT (see nodeBoundVariables'
  // doc comment) — all four sides alias the same variable when bound via
  // the Plugin API's single `strokeWeight` field, so the first match names
  // the whole atom.
  const bound = nodeBoundVariables(raw)
  const varName = variableNameFor(
    flatAliasId(bound, 'strokeWeight') ??
      nestedAliasId(
        bound,
        'individualStrokeWeights',
        STROKE_WEIGHT_BOUND_KEYS,
      ),
    bindingNames,
  )
  return wrapperFor(undefined, varName) + strokeToAtom(geom)
}

/** REST's per-side positional keys under `individualStrokeWeights`. */
const STROKE_WEIGHT_BOUND_KEYS = [
  'BORDER_TOP_WEIGHT',
  'BORDER_RIGHT_WEIGHT',
  'BORDER_BOTTOM_WEIGHT',
  'BORDER_LEFT_WEIGHT',
] as const

// ─── radius ───────────────────────────────────────────────────────────────────

/** REST's per-corner positional keys under `rectangleCornerRadii`. */
const RADIUS_BOUND_KEYS = [
  'RECTANGLE_TOP_LEFT_CORNER_RADIUS',
  'RECTANGLE_TOP_RIGHT_CORNER_RADIUS',
  'RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS',
  'RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS',
] as const

const radiusAtom = (
  raw: RawNode,
  bindingNames: BindingNames | undefined,
): string | undefined => {
  const per = raw.rectangleCornerRadii as
    | [number, number, number, number]
    | undefined
  const base = (() => {
    if (
      per !== undefined &&
      Array.isArray(per) &&
      per.length === 4 &&
      !(
        per[0] === per[1] &&
        per[1] === per[2] &&
        per[2] === per[3]
      )
    ) {
      return `[${per.join(',')}]`
    }
    const uniform = num(raw.cornerRadius)
    if (uniform !== undefined && uniform > 0) {
      return String(uniform)
    }
    return undefined
  })()
  if (base === undefined) {
    return undefined
  }
  // There is no radius STYLE (no style resource governs corner radius) —
  // only a variable can bind here. Figma has no single "radius" bound-
  // variable field: it's four independent corner keys (REST-nested — see
  // nodeBoundVariables' doc comment); the grammar has one atom regardless
  // of uniform/per-corner, so the first resolvable corner names the whole
  // atom.
  const bound = nodeBoundVariables(raw)
  const varName = variableNameFor(
    nestedAliasId(
      bound,
      'rectangleCornerRadii',
      RADIUS_BOUND_KEYS,
    ),
    bindingNames,
  )
  return wrapperFor(undefined, varName) + base
}

// ─── layout grids ─────────────────────────────────────────────────────────────

/**
 * Convert raw.layoutGrids (Figma's own property name) → NodeSpec.grids atoms.
 * `gridToAtom` is the exact inverse of the writer's `atomToGrid`
 * (grammar/heads/grid.ts) — this is the read face of that same head.
 */
const gridArray = (raw: unknown): string[] | undefined => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined
  }
  return (raw as FigmaLayoutGrid[]).map(g => gridToAtom(g))
}

// ─── export presets ───────────────────────────────────────────────────────────

type RawExportSetting = {
  format: string
  suffix?: string
  constraint?: { type: string; value: number }
}

/**
 * Convert raw.exportSettings → NodeSpec.exportSettings. Figma's own
 * `constraint` is an OBJECT `{type, value}`; the NodeSpec/grammar shape is
 * the JSON-friendly tuple `['SCALE'|'WIDTH'|'HEIGHT', number]` — the mirror
 * of the revive `applyExportSettings` does on the way in
 * (figma-plugin/src/apply-node-fields.ts's `reviveExportSetting`).
 */
const exportSettingsArray = (
  raw: unknown,
): ExportSetting[] | undefined => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined
  }
  return (raw as RawExportSetting[]).map(s => {
    const out: ExportSetting = {
      format: s.format as ExportSetting['format'],
    }
    if (s.suffix !== undefined && s.suffix !== '') {
      out.suffix = s.suffix
    }
    if (s.constraint !== undefined) {
      out.constraint = [
        s.constraint.type as 'SCALE' | 'WIDTH' | 'HEIGHT',
        s.constraint.value,
      ]
    }
    return out
  })
}

// ─── layout ───────────────────────────────────────────────────────────────────

const layoutSpec = (
  raw: RawNode,
): LayoutSpec | undefined => {
  const mode = str(raw.layoutMode)
  if (
    mode !== 'HORIZONTAL' &&
    mode !== 'VERTICAL' &&
    mode !== 'GRID'
  ) {
    return undefined
  }

  // GRID branch (M12): two independent gaps, separate row/col counts.
  if (mode === 'GRID') {
    const out: LayoutSpec = { mode: 'GRID' }
    const rows = num(raw.gridRowCount)
    if (rows !== undefined) {
      out.rows = rows
    }
    const cols = num(raw.gridColumnCount)
    if (cols !== undefined) {
      out.cols = cols
    }
    const rowGap = num(raw.gridRowGap)
    if (rowGap !== undefined) {
      out.rowGap = rowGap
    }
    const colGap = num(raw.gridColumnGap)
    if (colGap !== undefined) {
      out.colGap = colGap
    }
    return out
  }

  const out: LayoutSpec = {
    mode: mode === 'HORIZONTAL' ? 'H' : 'V',
  }
  const gap = num(raw.itemSpacing)
  if (gap !== undefined) {
    out.gap = gap
  }
  const pt = num(raw.paddingTop) ?? 0
  const pr = num(raw.paddingRight) ?? 0
  const pb = num(raw.paddingBottom) ?? 0
  const pl = num(raw.paddingLeft) ?? 0
  if (pt || pr || pb || pl) {
    out.pad = [pt, pr, pb, pl]
  }
  const primary = str(raw.primaryAxisAlignItems)
  const counter = str(raw.counterAxisAlignItems)
  if (primary !== undefined || counter !== undefined) {
    out.align = [primary ?? 'MIN', counter ?? 'MIN']
  }
  if (str(raw.layoutWrap) === 'WRAP') {
    out.wrap = true
  }
  return out
}

// ─── text ─────────────────────────────────────────────────────────────────────

const fontNameFromStyle = (
  style: RawTextStyle,
): FigmaFontName => {
  const out: FigmaFontName = {
    family: style.fontFamily ?? 'Unknown',
    style: style.fontStyle ?? 'Regular',
    size: style.fontSize ?? 0,
  }
  if (
    style.lineHeightUnit === 'PIXELS' &&
    style.lineHeightPx !== undefined
  ) {
    out.lineHeight = {
      value: style.lineHeightPx,
      unit: 'PIXELS',
    }
  } else if (
    style.lineHeightUnit === 'PERCENT' &&
    style.lineHeightPercent !== undefined
  ) {
    out.lineHeight = {
      value: style.lineHeightPercent,
      unit: 'PERCENT',
    }
  }
  if (
    style.letterSpacing !== undefined &&
    style.letterSpacing !== 0
  ) {
    out.letterSpacing = {
      value: style.letterSpacing,
      unit: 'PIXELS',
    }
  }
  return out
}

const runSpecs = (
  raw: RawNode,
  bindingNames: BindingNames | undefined,
): TextRun[] | undefined => {
  const { runs: raws } = raw
  if (!Array.isArray(raws) || raws.length === 0) {
    return undefined
  }
  const out: TextRun[] = []
  for (const r of raws as Record<string, unknown>[]) {
    const at = r.at as [number, number] | undefined
    if (at === undefined) {
      continue
    }
    const run: TextRun = { at }
    const style = r.style as RawTextStyle | undefined
    if (style !== undefined) {
      run.font = fontToAtom(fontNameFromStyle(style))
    }
    const { color } = r
    if (Array.isArray(color)) {
      // Per-range override — no run-level style field (textStyleId governs
      // the base text, not a run), so only the variable half applies here.
      const colorAtom = (color as RawPaint[])
        .map(p => paintLeaf(p, undefined, bindingNames))
        .find((a): a is string => a !== null)
      if (colorAtom !== undefined) {
        run.color = colorAtom
      }
    }
    out.push(run)
  }
  return out.length > 0 ? out : undefined
}

const textSpec = (
  raw: RawNode,
  bindingNames: BindingNames | undefined,
): TextSpec | undefined => {
  const content = str(raw.characters)
  const style = raw.style as RawTextStyle | undefined
  if (content === undefined || style === undefined) {
    return undefined
  }
  // textStyleId governs the whole text style (font family/size/lh/ls as one
  // atom) — no separate variable-field wrap here (those bind sub-properties
  // on a scale this reader doesn't currently resolve names for; the style
  // half is the one required, tested surface).
  const textStyleName = bindingNames?.styles?.text
  const out: TextSpec = {
    content,
    font:
      wrapperFor(textStyleName, undefined) +
      fontToAtom(fontNameFromStyle(style)),
  }
  // Text color rides as a leaf atom rendered from the first SOLID fill —
  // the SAME fillStyleId/boundVariables.color as the node's `fills`.
  const fillStyleName = bindingNames?.styles?.fill
  const { fills } = raw
  if (Array.isArray(fills)) {
    const colorAtom = (fills as RawPaint[])
      .filter(
        f => f.visible !== false && f.type === 'SOLID',
      )
      .map(p => paintLeaf(p, fillStyleName, bindingNames))
      .find((a): a is string => a !== null)
    if (colorAtom !== undefined) {
      out.color = colorAtom
    }
  }
  if (style.textAlignHorizontal !== undefined) {
    out.align = style.textAlignHorizontal
  }
  if (style.textAlignVertical !== undefined) {
    out.valign = style.textAlignVertical
  }
  if (
    style.textDecoration !== undefined &&
    style.textDecoration !== 'NONE'
  ) {
    out.decoration = style.textDecoration
  }
  if (
    style.textCase !== undefined &&
    style.textCase !== 'ORIGINAL'
  ) {
    out.case = style.textCase
  }
  if (
    style.paragraphSpacing !== undefined &&
    style.paragraphSpacing !== 0
  ) {
    out.paragraphSpacing = style.paragraphSpacing
  }
  const runs = runSpecs(raw, bindingNames)
  if (runs !== undefined) {
    out.runs = runs
  }
  return out
}

// ─── component / instance meta ────────────────────────────────────────────────

type RawComponentProp = {
  type: string
  value: string | boolean
}

/**
 * Split a raw Figma `componentProperties` map ({ [name]: { type, value } }) into
 * the canonical NodeSpec instance shape — VARIANT props → `variantProperties`
 * ({ [name]: string }), everything else → `componentProperties`
 * ({ [name]: string|boolean }). This is the ONE canonical instance-property
 * projection shared by the READ twin (get_node / get_components / inspect) and
 * the WRITE echo (set_instance), so the round-trip is exact (T2). Returns only
 * the keys with content (an empty group is omitted).
 */
export const splitComponentProperties = (
  props:
    | Record<string, RawComponentProp>
    | undefined
    | null,
): Pick<
  NodeSpec,
  'componentProperties' | 'variantProperties'
> => {
  const out: Pick<
    NodeSpec,
    'componentProperties' | 'variantProperties'
  > = {}
  if (props !== undefined && props !== null) {
    const variant: Record<string, string> = {}
    const component: Record<string, string | boolean> = {}
    for (const [k, v] of Object.entries(props)) {
      if (v.type === 'VARIANT') {
        variant[k] = String(v.value)
      } else {
        component[k] = v.value
      }
    }
    if (Object.keys(variant).length > 0) {
      out.variantProperties = variant
    }
    if (Object.keys(component).length > 0) {
      out.componentProperties = component
    }
  }
  return out
}

const componentMeta = (
  raw: RawNode,
): Pick<
  NodeSpec,
  | 'component'
  | 'componentProperties'
  | 'variantProperties'
  | 'overrides'
> => {
  const out: Pick<
    NodeSpec,
    | 'component'
    | 'componentProperties'
    | 'variantProperties'
    | 'overrides'
  > = {
    ...splitComponentProperties(
      raw.componentProperties as
        | Record<string, RawComponentProp>
        | undefined,
    ),
  }
  // component (INSTANCE main-component ref): emit `{ id }` from the instance's
  // componentId and `{ key }` from componentKey when present, so a locally-
  // created instance round-trips through get_node → create_node (T2). Only
  // INSTANCE nodes carry a main-component reference.
  // M14: also emit `{ remote: true }` from componentRemote when the plugin's
  // isRoot enrichment populated it — signals a published-library main so the
  // write path prefers importComponentByKeyAsync(key) over the doomed local id.
  if (str(raw.type) === 'INSTANCE') {
    const componentId = str(raw.componentId)
    const componentKey = str(raw.componentKey)
    const componentRemote =
      raw.componentRemote === true ? true : undefined
    if (
      componentId !== undefined ||
      componentKey !== undefined
    ) {
      const component: NonNullable<NodeSpec['component']> =
        {}
      if (componentId !== undefined) {
        component.id = componentId
      }
      if (componentKey !== undefined) {
        component.key = componentKey
      }
      if (componentRemote !== undefined) {
        component.remote = componentRemote
      }
      out.component = component
    }
  }
  const rawOverrides = raw.overrides
  if (
    Array.isArray(rawOverrides) &&
    rawOverrides.length > 0
  ) {
    const entries: OverrideEntry[] = []
    for (const o of rawOverrides as Record<
      string,
      unknown
    >[]) {
      const id = str(o.id)
      const fields = o.overriddenFields
      if (id !== undefined && Array.isArray(fields)) {
        for (const field of fields as string[]) {
          entries.push({ path: id, field, value: '' })
        }
      }
    }
    if (entries.length > 0) {
      out.overrides = entries
    }
  }
  return out
}

// ─── stub ─────────────────────────────────────────────────────────────────────

const toStub = (raw: RawNode): IdStub => {
  const { children } = raw
  return {
    id: str(raw.id) ?? '',
    name: str(raw.name) ?? '',
    type: str(raw.type) ?? '',
    size: sizeOf(raw),
    childCount: Array.isArray(children)
      ? children.length
      : 0,
  }
}

// ─── the walk ─────────────────────────────────────────────────────────────────

/**
 * Convert a raw Figma node export (JSON_REST_V1) to a canonical NodeSpec with
 * atom-string leaves.
 *
 * `depth` controls the child boundary (drill-by-id):
 *   depth = 0  → children become IdStubs (default)
 *   depth = N  → N full levels below the root; deeper children become stubs
 *   depth = -1 → the complete subtree (fidelity-first; nothing collapsed)
 *
 * `bindingNames` is `undefined` for every call EXCEPT the one `toNodeSpec`
 * makes for the export root — see the T10 note at the top of this file.
 */
const buildNode = (
  raw: RawNode,
  remaining: number,
  parentBBox: RawBBox | undefined,
  bindingNames: BindingNames | undefined,
): NodeSpec => {
  const out: NodeSpec = {
    type: str(raw.type) ?? '',
  }
  const name = str(raw.name)
  if (name !== undefined) {
    out.name = name
  }
  const id = str(raw.id)
  if (id !== undefined) {
    out.id = id
  }

  const context = str(raw.context)
  if (context !== undefined && context !== '') {
    out.context = context
  }

  out.size = sizeOf(raw)

  const position = positionOf(raw, parentBBox)
  if (position !== undefined) {
    out.position = position
  }

  const layoutPositioning = str(raw.layoutPositioning)
  if (
    layoutPositioning !== undefined &&
    layoutPositioning !== 'AUTO'
  ) {
    out.layoutPositioning =
      layoutPositioning as NodeSpec['layoutPositioning']
  }

  const layout = layoutSpec(raw)
  if (layout !== undefined) {
    out.layout = layout
  }

  const sizingH = str(raw.layoutSizingHorizontal)
  const sizingV = str(raw.layoutSizingVertical)
  if (sizingH !== undefined && sizingV !== undefined) {
    out.sizing = [sizingH, sizingV]
  }

  const constraints = raw.constraints as
    | { horizontal: string; vertical: string }
    | undefined
  if (constraints !== undefined && constraints !== null) {
    out.constraints = [
      restConstraintToPlugin(constraints.horizontal),
      restConstraintToPlugin(constraints.vertical),
    ]
  }

  const fills = paintArray(
    raw.fills,
    bindingNames?.styles?.fill,
    bindingNames,
  )
  if (fills !== undefined) {
    out.fills = fills
  }
  const strokes = paintArray(
    raw.strokes,
    bindingNames?.styles?.stroke,
    bindingNames,
  )
  if (strokes !== undefined) {
    out.strokes = strokes
  }
  const stroke = strokeGeom(raw, bindingNames)
  if (stroke !== undefined) {
    out.stroke = stroke
  }
  const effects = effectArray(
    raw.effects,
    bindingNames?.styles?.effect,
  )
  if (effects !== undefined) {
    out.effects = effects
  }
  const radius = radiusAtom(raw, bindingNames)
  if (radius !== undefined) {
    out.radius = radius
  }

  // grids — Figma's own property is layoutGrids; the NodeSpec field is grids.
  const grids = gridArray(raw.layoutGrids)
  if (grids !== undefined) {
    out.grids = grids
  }

  // vectorPaths — VECTOR nodes only; enriched by the plugin's exportNodeDocument.
  const vp = raw.vectorPaths
  if (Array.isArray(vp)) {
    out.vectorPaths = vp.map((p: unknown) => {
      const path = p as {
        windingRule: string
        data: string
      }
      return pathToAtom({
        windingRule: path.windingRule as
          | 'NONZERO'
          | 'EVENODD'
          | 'NONE',
        data: path.data,
      })
    })
  }

  // node-type-specific shape fields — plain pass-through (no grammar atom)
  // pointCount — POLYGON/STAR: number of points/sides
  const pointCount = num(raw.pointCount)
  if (pointCount !== undefined) {
    out.pointCount = pointCount
  }
  // innerRadius — STAR only: inner radius ratio 0..1
  const innerRadius = num(raw.innerRadius)
  if (innerRadius !== undefined) {
    out.innerRadius = innerRadius
  }
  // sectionContentsHidden — SECTION only: whether contents are collapsed
  if (typeof raw.sectionContentsHidden === 'boolean') {
    out.sectionContentsHidden = raw.sectionContentsHidden
  }
  // isMask / maskType — enriched by the plugin's exportNodeDocument (may not
  // be in JSON_REST_V1). Emit only when isMask is true to keep unmasked nodes
  // clean; maskType is only meaningful when isMask is true.
  if (raw.isMask === true) {
    out.isMask = true
    if (typeof raw.maskType === 'string') {
      out.maskType = raw.maskType as
        | 'ALPHA'
        | 'VECTOR'
        | 'LUMINANCE'
    }
  }
  // explicitVariableModes (M13) — per-collection mode pins; enriched by the
  // plugin's exportNodeDocument (feature-detected; not in JSON_REST_V1).
  // Omit when absent or empty to avoid bloating the NodeSpec.
  if (
    typeof raw.explicitVariableModes === 'object' &&
    raw.explicitVariableModes !== null &&
    Object.keys(raw.explicitVariableModes).length > 0
  ) {
    out.explicitVariableModes =
      raw.explicitVariableModes as Record<string, string>
  }
  // componentPropertyReferences — enriched by the plugin's exportNodeDocument
  // (feature-detected; not in JSON_REST_V1). Maps component property name →
  // the field on this node that the property controls (e.g. { characters:
  // 'Label#45:13' }). Read-only projection; write via update_component's
  // targetNodeId/field binding.
  if (
    raw.componentPropertyReferences &&
    typeof raw.componentPropertyReferences === 'object'
  ) {
    out.componentPropertyReferences =
      raw.componentPropertyReferences as Record<
        string,
        string
      >
  }

  const opacity = num(raw.opacity)
  if (opacity !== undefined && opacity < 1) {
    out.opacity = opacity
  }
  // JSON_REST_V1 carries rotation in RADIANS, sign-flipped relative to the
  // Plugin API's node.rotation (which the writer uses, in DEGREES). Convert so
  // the value round-trips with the writer (set 30 → read 30, not -0.5236).
  const rotationRad = num(raw.rotation)
  if (rotationRad !== undefined) {
    const deg =
      Math.round(((-rotationRad * 180) / Math.PI) * 1000) /
      1000
    if (deg !== 0) {
      out.rotation = deg
    }
  }
  const blend = str(raw.blendMode)
  if (
    blend !== undefined &&
    blend !== 'PASS_THROUGH' &&
    blend !== 'NORMAL'
  ) {
    out.blend = blend
  }
  if (raw.visible === false) {
    out.visible = false
  }
  // clipsContent is a FRAME/COMPONENT/INSTANCE property only; GROUP nodes
  // do not have independent clipping — guard against stale export data.
  const nodeType = str(raw.type) ?? ''
  if (raw.clipsContent === true && nodeType !== 'GROUP') {
    out.clipsContent = true
  }

  const text = textSpec(raw, bindingNames)
  if (text !== undefined) {
    out.text = text
  }

  // exportSettings — persistent export presets (round-trips via get_node /
  // update_node); constraint is revived from the raw {type,value} object to
  // the NodeSpec tuple.
  const exportSettings = exportSettingsArray(
    raw.exportSettings,
  )
  if (exportSettings !== undefined) {
    out.exportSettings = exportSettings
  }

  const meta = componentMeta(raw)
  if (meta.component !== undefined) {
    out.component = meta.component
  }
  if (meta.variantProperties !== undefined) {
    out.variantProperties = meta.variantProperties
  }
  if (meta.componentProperties !== undefined) {
    out.componentProperties = meta.componentProperties
  }
  if (meta.overrides !== undefined) {
    out.overrides = meta.overrides
  }

  const { children } = raw
  if (Array.isArray(children) && children.length > 0) {
    const kids = children as RawNode[]
    if (remaining === 0) {
      const stubs: NodeSpecOrStub[] = kids.map(toStub)
      out.children = stubs
    } else {
      const next = remaining === -1 ? -1 : remaining - 1
      // Thread THIS node's bbox down so each child's position is computed
      // parent-relative (child.bbox − parent.bbox) when no relativeTransform.
      const childParentBBox = bboxOf(raw)
      // T10 — bindingNames is ALWAYS undefined below the root: it is never
      // threaded to a child, regardless of `depth`. A deep, fidelity-first
      // read still resolves NO binding names on descendants (the same
      // bounded-scan rule component.key follows) — see the file-header note.
      const built: NodeSpecOrStub[] = kids.map(c =>
        buildNode(c, next, childParentBBox, undefined),
      )
      out.children = built
    }
  }

  return out
}

export const toNodeSpec = (
  raw: RawNode,
  opts: { depth?: number },
): NodeSpec => {
  const depth = opts.depth ?? 0
  // The export ROOT has no parent frame: positionOf falls back to its own
  // absolute bbox origin (current behavior preserved).
  //
  // bindingNames (Task 1) rides on `raw.bindingNames` for the ROOT call
  // only — the one place this function reads it. Every recursive
  // `buildNode` call for a child passes `undefined` explicitly (T10).
  const bindingNames = raw.bindingNames as
    | BindingNames
    | undefined
  return buildNode(raw, depth, undefined, bindingNames)
}
