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
// Both wrappers REACH DESCENDANTS: `bindingNames` is a field the plugin
// populates on every node a read returns complete (expression-formats.md,
// "Wrappers reach descendants"), so this module reads it off EACH node's own
// raw export rather than threading the root's down. A descendant therefore
// wraps its own bindings and only its own — a node that happens to reuse the
// same variable id still needs its own `bindingNames` entry to render a name,
// which is exactly the isolation the old root-only threading bought.

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
import { renderResolvedList } from './styled-fields'

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
 * The plugin's enrichment, present on `raw.bindingNames` for every node the
 * read returns complete: `styles` maps a grammar field name
 * (fill/stroke/effect/text) to the bound style's NAME; `variables` maps a
 * variable id to its NAME. Both are resolved lookups (may omit an id/field the
 * plugin's runtime couldn't resolve) — see the "never fall back to the id"
 * rule below.
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

/**
 * A styleable ARRAY field as the read emits it (expression-formats.md — "A
 * styled field is a reference, not a list").
 *
 * Unstyled, the field is the array of atoms it has always been. Styled, it is
 * ONE atom: the style named once, then the list it resolves to, bracketed and
 * comma-space separated. The brackets are ALWAYS there — a style holding one
 * effect emits a one-entry list — so the form is parsed unconditionally rather
 * than sniffed, and writing the emission back verbatim is a no-op.
 */
const styledField = (
  styleName: string | undefined,
  atoms: string[] | undefined,
): string | string[] | undefined => {
  if (atoms === undefined || styleName === undefined) {
    return atoms
  }
  // The list is rendered by the SAME function the write face's differ compares
  // against (T8): two renderings that must agree byte for byte, or a verbatim
  // write-back starts warning about a difference that is only in the spacing.
  return (
    renderWrapper({ kind: 'style', name: styleName }) +
    renderResolvedList(atoms)
  )
}

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

// ─── REST→Plugin vocabulary ───────────────────────────────────────────────────
//
// Figma spells several enums one way in a JSON_REST_V1 export and another in
// the Plugin API. The export is what a READ sees; the Plugin API is what a
// WRITE must supply. So passing REST's spelling through hands the agent a value
// its own next call rejects. expression-formats.md fixes ONE vocabulary — the
// Plugin API's, because only that one writes (T2, T8).
//
// Every such field is a table below plus one `restVocab(...)` line; a fourth is
// a table entry, not a fourth hand-rolled function.

/**
 * A REST→Plugin lookup with an unchanged pass-through default.
 *
 * `undefined` in, `undefined` out — an optional field needs no guard at the
 * call site.
 */
type RestVocab = {
  (value: string): string
  (value: string | undefined): string | undefined
}

/**
 * Build a normaliser over one REST-spelling → Plugin-spelling table.
 *
 * A table may be MANY-TO-ONE: constraints collapse both LEFT and TOP onto the
 * single Plugin value MIN.
 *
 * Tables are per-field on purpose — there is no one global vocabulary to fold
 * them into, because the same word can sit on opposite sides in two fields:
 * STRETCH is a Plugin *constraint* value and also REST's spelling of an image's
 * CROP.
 *
 * Anything absent from the table passes through UNCHANGED, including a value
 * that is already Plugin vocab (MIN, ROUND, CROP). These fields carry no enum
 * in the schema, and a value that is already right must not be corrupted.
 */
const restVocab = (
  table: Record<string, string>,
): RestVocab =>
  ((value: string | undefined) =>
    value === undefined
      ? undefined
      : (table[value] ?? value)) as RestVocab

/**
 * REST uses LEFT/RIGHT/TOP/BOTTOM/LEFT_RIGHT/TOP_BOTTOM; the Plugin API uses
 * MIN/MAX/STRETCH (CENTER and SCALE are shared, so neither appears here).
 */
const restConstraintToPlugin = restVocab({
  LEFT: 'MIN',
  TOP: 'MIN',
  RIGHT: 'MAX',
  BOTTOM: 'MAX',
  LEFT_RIGHT: 'STRETCH',
  TOP_BOTTOM: 'STRETCH',
})

/**
 * REST's spelling of the two arrow caps → the Plugin API's.
 *
 * Figma calls the same cap `LINE_ARROW` in a JSON_REST_V1 export and
 * `ARROW_LINES` in the Plugin API, and likewise `TRIANGLE_ARROW` /
 * `ARROW_EQUILATERAL` — verified live: create_node answers "Invalid enum value.
 * Expected 'NONE' | 'ROUND' | 'SQUARE' | 'ARROW_LINES' | 'ARROW_EQUILATERAL'".
 *
 * Per-point caps need no such mapping: they come off `vectorNetwork` through
 * the plugin, which speaks the Plugin API already.
 */
const pluginStrokeCap = restVocab({
  LINE_ARROW: 'ARROW_LINES',
  TRIANGLE_ARROW: 'ARROW_EQUILATERAL',
})

/**
 * REST's spelling of an image's CROP scale mode → the Plugin API's.
 *
 * `ImagePaint.scaleMode` is FILL/FIT/CROP/TILE in the Plugin API
 * (expression-formats.md:116); a JSON_REST_V1 export spells CROP as `STRETCH`,
 * which is not a scaleMode the Plugin API has any name for. FILL, FIT and TILE
 * are spelled the same on both sides and pass through (B11).
 *
 * IMAGE only: a VIDEO paint carries a scaleMode too, but never reaches this —
 * `rawToFigmaPaint` returns null for every type but SOLID, the four gradients
 * and IMAGE.
 */
const pluginScaleMode = restVocab({ STRETCH: 'CROP' })

/**
 * `[width, height]`, or undefined when the node has no size at all.
 *
 * A PAGE has none — Figma does not maintain width/height on one — and the
 * fallback used to invent `[0, 0]` for it, and for every child of a page-rooted
 * read (B51). B26's rule is the answer: never present a value the engine is not
 * maintaining. An absent `size` is legible; a fabricated one is not, and a
 * frame-rooted control returning real sizes made the zeros look like a fact
 * about the file.
 */
const sizeOf = (
  raw: RawNode,
): [number, number] | undefined => {
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
  if (
    bbox !== undefined &&
    bbox !== null &&
    typeof bbox.width === 'number' &&
    typeof bbox.height === 'number'
  ) {
    return [bbox.width, bbox.height]
  }
  return w !== undefined || h !== undefined
    ? [w ?? 0, h ?? 0]
    : undefined
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

/**
 * Does this node lay its children out? Auto-layout (H/V/GRID) does; a plain
 * frame — `layoutMode: NONE`, or no `layoutMode` at all, which is what
 * JSON_REST_V1 emits for everything that is not a frame — does not.
 */
const laysOutChildren = (raw: RawNode): boolean => {
  const mode = str(raw.layoutMode)
  return (
    mode === 'HORIZONTAL' ||
    mode === 'VERTICAL' ||
    mode === 'GRID'
  )
}

/**
 * Is this node's stored x/y a value the layout engine stopped maintaining?
 *
 * Figma never lays out an INVISIBLE child of an auto-layout parent: the child
 * keeps whatever x/y it last had, and both the parent's and the child's own
 * geometry drift on around it. Emitting that unqualified reads as live
 * geometry — a hidden legend parked at x=607 inside a 522-wide header says
 * "this container is broken" when nothing is (T7: a value the engine is not
 * maintaining is not presented as live).
 *
 * Two hidden children keep theirs, because theirs are real: an ABSOLUTE child
 * is positioned by its own coordinates rather than by the flow, and a hidden
 * child of a PLAIN frame was never laid out by anything, so nothing went stale.
 */
const positionIsStale = (
  raw: RawNode,
  parentLaysOutChildren: boolean,
): boolean =>
  parentLaysOutChildren &&
  raw.visible === false &&
  str(raw.layoutPositioning) !== 'ABSOLUTE'

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
      out.scaleMode = pluginScaleMode(p.scaleMode)
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

/**
 * Render a paint array to atom strings.
 *
 * A hidden paint is NOT filtered out. `visible: false` is paint STATE, and
 * the grammar carries it as `{vis=false}` (expression-formats.md) — which
 * `paintToAtom` emits and `atomToPaint` parses. Dropping it here made a
 * read-modify-write DESTROY the paint: the agent echoed back the fills it
 * was shown, and the hidden one was never shown.
 *
 * A paint the grammar cannot render yet (VIDEO / PATTERN / SHADER, or a
 * malformed export) still has to be dropped — but it is announced on
 * `warnings`, never dropped silently (T7). `field` names the array so the
 * warning says which one came back incomplete.
 */
const paintArray = (
  raw: unknown,
  styleName: string | undefined,
  bindingNames: BindingNames | undefined,
  field: 'fills' | 'strokes',
  warnings: string[],
): string | string[] | undefined => {
  if (!Array.isArray(raw)) {
    return undefined
  }
  // When a style owns the field, it is named ONCE outside the list and no
  // entry inside carries a wrapper of its own — neither the style (which would
  // repeat it per paint) nor a variable (which the style already governs).
  const inner =
    styleName === undefined ? bindingNames : undefined
  const atoms: string[] = []
  for (const p of raw as RawPaint[]) {
    const atom = paintLeaf(p, undefined, inner)
    if (atom === null) {
      warnings.push(
        `${field}: dropped a paint this read cannot render (type ${
          p.type ?? 'unknown'
        }) — the returned ${field} array is incomplete`,
      )
      continue
    }
    atoms.push(atom)
  }
  return styledField(
    styleName,
    atoms.length > 0 ? atoms : undefined,
  )
}

// ─── effects ──────────────────────────────────────────────────────────────────

const effectArray = (
  raw: unknown,
  styleName: string | undefined,
): string | string[] | undefined => {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const atoms = (raw as RawEffect[])
    // No visibility filter: a hidden effect is still ON the node, and the
    // grammar spells it (`{vis=false}`). Dropping it here made a
    // read-modify-write delete the designer's hidden shadow — the same defect
    // the fills path carried. `visible` must be carried onto the FigmaEffect
    // below, or the effect reads back as visible and the write-back UN-hides it.
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
      if (e.visible === false) {
        figma.visible = false
      }
      return effectToAtom(figma)
    })
  return styledField(
    styleName,
    atoms.length > 0 ? atoms : undefined,
  )
}

// ─── stroke geometry ──────────────────────────────────────────────────────────

/** REST's per-side positional keys under `individualStrokeWeights`. */
const STROKE_WEIGHT_BOUND_KEYS = [
  'BORDER_TOP_WEIGHT',
  'BORDER_RIGHT_WEIGHT',
  'BORDER_BOTTOM_WEIGHT',
  'BORDER_LEFT_WEIGHT',
] as const

/** REST's per-side keys, in the tuple's [top,right,bottom,left] order. */
const REST_STROKE_WEIGHT_KEYS = [
  'top',
  'right',
  'bottom',
  'left',
] as const

/**
 * The four per-side stroke weights as `[t,r,b,l]`, or undefined when this node
 * does not report them (B27).
 *
 * TWO SOURCES, one shape. The guaranteed one is the plugin's enrichment
 * (enrich-nodes.ts `syncPatch`), which patches the FLAT Plugin-API field names
 * onto the exported node — and only when the sides DIFFER, so an ordinary
 * uniformly-stroked node carries none of this. The second is REST's own nested
 * `individualStrokeWeights` object, read when a raw JSON_REST_V1 dump happens
 * to carry it; a dump carrying neither reads from the uniform `strokeWeight`
 * exactly as it always has.
 *
 * All four or nothing: a partial set says nothing trustworthy about the sides
 * it omits, and half a tuple would be a worse answer than the uniform number.
 */
const perSideWeights = (
  raw: RawNode,
): [number, number, number, number] | undefined => {
  const flat = [
    num(raw.strokeTopWeight),
    num(raw.strokeRightWeight),
    num(raw.strokeBottomWeight),
    num(raw.strokeLeftWeight),
  ]
  if (flat.every(w => w !== undefined)) {
    return flat as [number, number, number, number]
  }
  const nested = raw.individualStrokeWeights
  if (nested === null || typeof nested !== 'object') {
    return undefined
  }
  const rest = REST_STROKE_WEIGHT_KEYS.map(k =>
    num((nested as Record<string, unknown>)[k]),
  )
  return rest.every(w => w !== undefined)
    ? (rest as [number, number, number, number])
    : undefined
}

/**
 * The stroke's GEOMETRY (expression-formats.md) — so a node with no stroke has
 * none to report. `hasStroke` is the caller's already-computed `strokes` atom
 * array, not a second derivation of it.
 *
 * Figma keeps a default `strokeWeight` (and `strokeAlign`) on EVERY node
 * whether or not a stroke exists, so `weight > 0` alone is not evidence of a
 * stroke: it put `stroke(1){align=INSIDE}` on every strokeless FRAME,
 * RECTANGLE and TEXT ever read — 33 characters per node describing something
 * that is not there (a T4 cost and a T7 honesty problem).
 */
const strokeGeom = (
  raw: RawNode,
  bindingNames: BindingNames | undefined,
  hasStroke: boolean,
): string | undefined => {
  if (!hasStroke) {
    return undefined
  }
  // Per-side weights first (B27). They are the only truthful account of a node
  // whose sides differ — its `strokeWeight` is `figma.mixed` there, so the
  // uniform field is either absent from the export or not one value at all.
  // The tuple is emitted ONLY when the sides actually differ: four equal sides
  // are the plain number, which is what the write face round-trips back and
  // what expression-formats.md shows.
  const per = perSideWeights(raw)
  const uniform =
    per === undefined ||
    (per[0] === per[1] &&
      per[1] === per[2] &&
      per[2] === per[3])
  // A non-uniform node is drawn wherever ANY side is non-zero — `[0,0,1,0]` is
  // a bottom rule, not an absent stroke — so the "is anything drawn" gate reads
  // the largest side.
  const weight = uniform
    ? (per?.[0] ?? num(raw.strokeWeight))
    : Math.max(...(per as number[]))
  if (weight === undefined || weight <= 0) {
    return undefined
  }
  const geom: FigmaStrokeGeom = uniform
    ? { weight }
    : { weights: per }
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
  const cap = pluginStrokeCap(str(raw.strokeCap))
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
    if (Array.isArray(per) && per.length === 4) {
      if (
        !(
          per[0] === per[1] &&
          per[1] === per[2] &&
          per[2] === per[3]
        )
      ) {
        return `[${per.join(',')}]`
      }
      // Four EQUAL corners are one radius, and the group is the only
      // place that value is guaranteed to appear: Figma omits the flat
      // `cornerRadius` key whenever the corners are bound to a variable
      // (live-verified — bind_variable(field:'cornerRadius') on a FRAME
      // emits boundVariables.rectangleCornerRadii ×4 and no scalar).
      // Deriving the scalar here is what keeps such a read from losing
      // BOTH its value and its binding. A 0 group falls through to the
      // flat key, which is where a T4 default is already elided.
      const corner = num(per[0])
      if (corner !== undefined && corner > 0) {
        return String(corner)
      }
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
const gridArray = (
  raw: unknown,
  styleName: string | undefined,
): string | string[] | undefined => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined
  }
  return styledField(
    styleName,
    (raw as FigmaLayoutGrid[]).map(g => gridToAtom(g)),
  )
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

  // Padding applies to every auto-layout mode, GRID included.
  const pt = num(raw.paddingTop) ?? 0
  const pr = num(raw.paddingRight) ?? 0
  const pb = num(raw.paddingBottom) ?? 0
  const pl = num(raw.paddingLeft) ?? 0
  const pad: LayoutSpec['pad'] | undefined =
    pt || pr || pb || pl ? [pt, pr, pb, pl] : undefined

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
    if (pad !== undefined) {
      out.pad = pad
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
  if (pad !== undefined) {
    out.pad = pad
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

/**
 * The per-range text overrides, from the plugin's `runs` enrichment.
 *
 * `runs` is NOT a JSON_REST_V1 field — REST spells mixed text as
 * `characterStyleOverrides` plus a `styleOverrideTable`, which this reader does
 * not speak. The plugin projects `getStyledTextSegments` into this shape
 * instead (figma-plugin/src/text-runs.ts), and that projection is CAPPED: a
 * text styled per character would otherwise put thousands of runs on one node.
 * `runsOmitted` carries what the cap dropped, and it becomes a warning here
 * rather than a silent short list (T7/T10).
 */
const runSpecs = (
  raw: RawNode,
  bindingNames: BindingNames | undefined,
  warnings: string[],
): TextRun[] | undefined => {
  const { runs: raws } = raw
  if (!Array.isArray(raws) || raws.length === 0) {
    return undefined
  }
  const omitted = num(raw.runsOmitted)
  if (omitted !== undefined && omitted > 0) {
    warnings.push(
      `text.runs: ${omitted} further style run(s) omitted — this text has more distinct style ranges than one read carries; the returned runs cover the start of the text only`,
    )
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
  warnings: string[],
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
  const runs = runSpecs(raw, bindingNames, warnings)
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
          // Field NAME only. Figma's override record is
          // `{id, overriddenFields}` — it never says what a field was
          // overridden TO, so any `value` here would be invented. The
          // old `value: ''` read as "overridden to blank".
          entries.push({ path: id, field })
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

/**
 * Is this raw node a boundary the PLUGIN drew — a row that states how many
 * children it has instead of carrying them?
 *
 * A PAGE read at `depth: 0` answers exactly that for each of its children: the
 * plugin does not serialize their subtrees, because the caller asked for the
 * page alone. The row is a stub, and the reader keeps it one — building it as a
 * childless NodeSpec instead would report the level as empty and let the
 * receipt claim nothing was cut (B51).
 */
const isDrawnBoundary = (raw: RawNode): boolean =>
  !Array.isArray(raw.children) &&
  num(raw.childCount) !== undefined

const toStub = (raw: RawNode): IdStub => {
  const { children } = raw
  const size = sizeOf(raw)
  return {
    id: str(raw.id) ?? '',
    name: str(raw.name) ?? '',
    type: str(raw.type) ?? '',
    // Omitted rather than zeroed: a PAGE has no size (B26).
    ...(size !== undefined ? { size } : {}),
    // A boundary row states its own count; a serialized node is counted.
    childCount: Array.isArray(children)
      ? children.length
      : (num(raw.childCount) ?? 0),
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
 * `bindingNames` is read off THIS node's own raw export — see the note at the
 * top of this file. It is never inherited from an ancestor.
 *
 * `parentLaysOutChildren` is the ACTUAL parent's auto-layout state, threaded
 * down from the recursion site (a node's own `layoutMode` says nothing about
 * whether something lays IT out). It decides whether this node's stored
 * position is live — see positionIsStale.
 */
const buildNode = (
  raw: RawNode,
  remaining: number,
  parentBBox: RawBBox | undefined,
  parentLaysOutChildren: boolean,
): NodeSpec => {
  const bindingNames = raw.bindingNames as
    | BindingNames
    | undefined
  const out: NodeSpec = {
    type: str(raw.type) ?? '',
  }
  // Per-node sink for read-face honesty: anything this node's export
  // carried that the read could not represent is named here rather than
  // vanishing. Attached to `out` only when non-empty; a child's warning
  // lands on the child's own spec (buildNode recurses with a fresh sink).
  const warnings: string[] = []
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

  // The plugin's per-node degrade (T7): this node refused to be read, and the
  // enrichment named the failure instead of losing the whole export. Passed
  // straight through — a node that comes back thin has to SAY it is thin, or
  // the read is quietly wrong about the document.
  const readError = str(raw.readError)
  if (readError !== undefined && readError !== '') {
    out.readError = readError
  }

  // …and the failures that had no node of their own to land on, reported by
  // the plugin on the ROOT of the returned tree (a stale handle is named by one
  // id during the walk and another in the export, so the patch matches
  // nothing).
  const { readErrors } = raw
  if (Array.isArray(readErrors)) {
    const named = readErrors.filter(
      (e): e is string => typeof e === 'string' && e !== '',
    )
    if (named.length > 0) {
      out.readErrors = named
    }
  }

  const size = sizeOf(raw)
  if (size !== undefined) {
    out.size = size
  }

  // B26 — an invisible child of an auto-layout parent has no live position, so
  // it is emitted with none (see positionIsStale). `visible: false` and the
  // parent's `layout.mode` are both in the read, so the absence is legible.
  const position = positionIsStale(
    raw,
    parentLaysOutChildren,
  )
    ? undefined
    : positionOf(raw, parentBBox)
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
    'fills',
    warnings,
  )
  if (fills !== undefined) {
    out.fills = fills
  }
  const strokes = paintArray(
    raw.strokes,
    bindingNames?.styles?.stroke,
    bindingNames,
    'strokes',
    warnings,
  )
  if (strokes !== undefined) {
    out.strokes = strokes
  }
  const stroke = strokeGeom(
    raw,
    bindingNames,
    strokes !== undefined,
  )
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
  // The fourth styleable array field: a grid style owns it exactly as a paint
  // style owns `fills` (the plugin's enrichment resolves `gridStyleId`).
  const grids = gridArray(
    raw.layoutGrids,
    bindingNames?.styles?.grid,
  )
  if (grids !== undefined) {
    out.grids = grids
  }

  // vectorPaths — VECTOR nodes only; enriched by the plugin's exportNodeDocument.
  const vp = raw.vectorPaths
  if (Array.isArray(vp)) {
    // Per-point detail rides in the atom's {…} channel. The plugin sends it
    // separately — `vectorCorners`, `vectorCaps`, `vectorJoins` — because it
    // lives on the
    // network, which never crosses the wire; folding it in here is what keeps
    // the indices and the points they count inside one value.
    //
    // The indices are into ONE path's points, but the network numbers its
    // vertices across the whole node. Those agree only while the node has a
    // single entry — which is the shape Figma emits for an ordinary vector,
    // subpaths and all, and the shape this was verified against. With several
    // entries the basis is genuinely unsettled, so say so rather than emit an
    // index that may point at the wrong point (T7).
    const sparseDetail = <T>(
      value: unknown,
    ): Record<number, T> | undefined => {
      const usable =
        value !== undefined &&
        value !== null &&
        typeof value === 'object'
      return usable
        ? (value as Record<number, T>)
        : undefined
    }
    const corners = sparseDetail<number>(raw.vectorCorners)
    const caps = sparseDetail<string>(raw.vectorCaps)
    const joins = sparseDetail<string>(raw.vectorJoins)
    const dropped = [
      ...Object.keys(corners ?? {}),
      ...Object.keys(caps ?? {}),
      ...Object.keys(joins ?? {}),
    ].length
    if (dropped > 0 && vp.length > 1) {
      warnings.push(
        `vectorPaths: per-point detail on ${dropped} point(s) omitted — this node has ${
          vp.length
        } paths and the point indices cannot be attributed to one of them; the returned vectorPaths show those points as unstyled`,
      )
    }
    const foldable = vp.length === 1
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
        ...(foldable && corners !== undefined
          ? { corners }
          : {}),
        ...(foldable && caps !== undefined ? { caps } : {}),
        ...(foldable && joins !== undefined
          ? { joins }
          : {}),
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

  const text = textSpec(raw, bindingNames, warnings)
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
      // …and THIS node's auto-layout state, which is the only place a child can
      // learn whether anything is laying it out (B26).
      const childParentLaysOut = laysOutChildren(raw)
      // Each child resolves its own bindingNames off its own raw export
      // (buildNode reads them there), so a wrapper never leaks down from an
      // ancestor and a descendant the read returns complete keeps the
      // style(...)/var(...) it actually has.
      const built: NodeSpecOrStub[] = kids.map(c =>
        // A row the plugin drew as a boundary stays a stub however much depth
        // is left: the subtree was never sent, so there is nothing to build.
        isDrawnBoundary(c)
          ? toStub(c)
          : buildNode(
              c,
              next,
              childParentBBox,
              childParentLaysOut,
            ),
      )
      out.children = built
    }
  }

  if (warnings.length > 0) {
    out.warnings = warnings
  }

  return out
}

export const toNodeSpec = (
  raw: RawNode,
  opts: { depth?: number },
): NodeSpec => {
  const depth = opts.depth ?? 0
  // The export ROOT has no parent frame: positionOf falls back to its own
  // absolute bbox origin (current behavior preserved), and with no parent in
  // hand its position is never called stale — the read cannot know what, if
  // anything, lays the root out.
  return buildNode(raw, depth, undefined, false)
}
