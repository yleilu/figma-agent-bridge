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
// var() read-back: a variable-bound paint renders with its var(<id>) wrapper on
// the leaf atom. There is no boundVariables field on NodeSpec — the binding
// rides on the appearance atom.

import type {
  NodeSpec,
  NodeSpecOrStub,
  IdStub,
  LayoutSpec,
  TextSpec,
  TextRun,
  OverrideEntry,
} from '@figma-agent-bridge/shared/node-spec'
import {
  paintToAtom,
  effectToAtom,
  fontToAtom,
  strokeToAtom,
  pathToAtom,
  type FigmaPaint,
  type FigmaEffect,
  type FigmaFontName,
  type FigmaStrokeGeom,
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

type RawPaint = {
  type: string
  visible?: boolean
  opacity?: number
  blendMode?: string
  color?: RawColor
  gradientStops?: { position: number; color: RGBA }[]
  gradientTransform?: number[][]
  imageRef?: string
  imageHash?: string
  scaleMode?: string
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
  const bbox = raw.absoluteBoundingBox as
    | { width: number; height: number }
    | undefined
  if (bbox !== undefined && bbox !== null) {
    return [bbox.width, bbox.height]
  }
  const w = num(raw.width)
  const h = num(raw.height)
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
    const tf = p.gradientTransform
    const gradientTransform: Transform =
      tf !== undefined && tf.length === 2
        ? [
            [tf[0][0], tf[0][1], tf[0][2]],
            [tf[1][0], tf[1][1], tf[1][2]],
          ]
        : [
            [1, 0, 0],
            [0, 1, 0],
          ]
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
    return out
  }
  return null
}

/**
 * Render a paint leaf to an atom string, wrapping it in var(<id>) when the
 * paint is bound to a variable (binding read-back).
 */
const paintLeaf = (p: RawPaint): string | null => {
  const figma = rawToFigmaPaint(p)
  if (figma === null) {
    return null
  }
  const atom = paintToAtom(figma)
  const binding = p.boundVariables?.color
  if (binding !== undefined) {
    return `var(${binding.id})${atom}`
  }
  return atom
}

const paintArray = (raw: unknown): string[] | undefined => {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const atoms = (raw as RawPaint[])
    .filter(p => p.visible !== false)
    .map(paintLeaf)
    .filter((a): a is string => a !== null)
  return atoms.length > 0 ? atoms : undefined
}

// ─── effects ──────────────────────────────────────────────────────────────────

const effectArray = (
  raw: unknown,
): string[] | undefined => {
  if (!Array.isArray(raw)) {
    return undefined
  }
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
      return effectToAtom(figma)
    })
  return atoms.length > 0 ? atoms : undefined
}

// ─── stroke geometry ──────────────────────────────────────────────────────────

const strokeGeom = (raw: RawNode): string | undefined => {
  const weight = num(raw.strokeWeight)
  if (weight === undefined || weight <= 0) {
    return undefined
  }
  const geom: FigmaStrokeGeom = { weight }
  const align = str(raw.strokeAlign)
  if (align !== undefined && align !== 'CENTER') {
    geom.align = align
  }
  const dash = raw.dashPattern
  if (Array.isArray(dash) && dash.length > 0) {
    geom.dash = dash as number[]
  }
  return strokeToAtom(geom)
}

// ─── radius ───────────────────────────────────────────────────────────────────

const radiusAtom = (raw: RawNode): string | undefined => {
  const per = raw.rectangleCornerRadii as
    | [number, number, number, number]
    | undefined
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
}

// ─── layout ───────────────────────────────────────────────────────────────────

const layoutSpec = (
  raw: RawNode,
): LayoutSpec | undefined => {
  const mode = str(raw.layoutMode)
  if (mode !== 'HORIZONTAL' && mode !== 'VERTICAL') {
    return undefined
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

const runSpecs = (raw: RawNode): TextRun[] | undefined => {
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
      const colorAtom = (color as RawPaint[])
        .map(paintLeaf)
        .find((a): a is string => a !== null)
      if (colorAtom !== undefined) {
        run.color = colorAtom
      }
    }
    out.push(run)
  }
  return out.length > 0 ? out : undefined
}

const textSpec = (raw: RawNode): TextSpec | undefined => {
  const content = str(raw.characters)
  const style = raw.style as RawTextStyle | undefined
  if (content === undefined || style === undefined) {
    return undefined
  }
  const out: TextSpec = {
    content,
    font: fontToAtom(fontNameFromStyle(style)),
  }
  // Text color rides as a leaf atom rendered from the first SOLID fill.
  const { fills } = raw
  if (Array.isArray(fills)) {
    const colorAtom = (fills as RawPaint[])
      .filter(
        f => f.visible !== false && f.type === 'SOLID',
      )
      .map(paintLeaf)
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
  const runs = runSpecs(raw)
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
  if (str(raw.type) === 'INSTANCE') {
    const componentId = str(raw.componentId)
    const componentKey = str(raw.componentKey)
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
 */
const buildNode = (
  raw: RawNode,
  remaining: number,
  parentBBox: RawBBox | undefined,
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

  const fills = paintArray(raw.fills)
  if (fills !== undefined) {
    out.fills = fills
  }
  const strokes = paintArray(raw.strokes)
  if (strokes !== undefined) {
    out.strokes = strokes
  }
  const stroke = strokeGeom(raw)
  if (stroke !== undefined) {
    out.stroke = stroke
  }
  const effects = effectArray(raw.effects)
  if (effects !== undefined) {
    out.effects = effects
  }
  const radius = radiusAtom(raw)
  if (radius !== undefined) {
    out.radius = radius
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

  const text = textSpec(raw)
  if (text !== undefined) {
    out.text = text
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
      const built: NodeSpecOrStub[] = kids.map(c =>
        buildNode(c, next, childParentBBox),
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
  return buildNode(raw, depth, undefined)
}
