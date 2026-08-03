// grammar/figma-paint.ts — AtomAST <-> Figma Paint/Effect/FontName
// objects. The write face parses an atom to a Figma object; the read
// face renders a Figma object back to a (lossy) view atom.
//
// THE GRADIENT-TRANSFORM MATH IS ISOLATED HERE (angleToTransform /
// transformToAngle) with its own tests — it is the historically fiddly
// part. Linear gradients carry an angle derived from gradientTransform;
// radial/angular/diamond carry no angle. Non-trivial geometry rides in
// the {tf=[a,b,c,d,e,f]} attr.

import type { AtomAST, AtomArg, Attrs } from './types'
import { parseAtom } from './parse-atom'
import { renderAtom } from './render-atom'

// --- Figma object shapes (structurally compatible, mutable/plain) ---

export type RGB = { r: number; g: number; b: number }
export type RGBA = {
  r: number
  g: number
  b: number
  a: number
}
export type Transform = [
  [number, number, number],
  [number, number, number],
]

export type FigmaSolidPaint = {
  type: 'SOLID'
  color: RGB
  opacity?: number
  visible?: boolean
  blendMode?: string
}

export type FigmaGradientPaint = {
  type:
    | 'GRADIENT_LINEAR'
    | 'GRADIENT_RADIAL'
    | 'GRADIENT_ANGULAR'
    | 'GRADIENT_DIAMOND'
  gradientStops: { position: number; color: RGBA }[]
  gradientTransform: Transform
  opacity?: number
  visible?: boolean
  blendMode?: string
}

export type FigmaImagePaint = {
  type: 'IMAGE'
  imageHash: string | null
  /** Write-only: a URL the server resolves to a hash. */
  imageUrl?: string
  scaleMode?: string
  rotation?: number
  scalingFactor?: number
  filters?: Record<string, number>
  imageTransform?: Transform
  opacity?: number
  visible?: boolean
  blendMode?: string
}

export type FigmaVideoPaint = {
  type: 'VIDEO'
  videoHash: string | null
  scaleMode?: string
  opacity?: number
  visible?: boolean
  blendMode?: string
}

export type FigmaPatternPaint = {
  type: 'PATTERN'
  sourceNodeId: string
  opacity?: number
  visible?: boolean
  blendMode?: string
}

export type FigmaPaint =
  | FigmaSolidPaint
  | FigmaGradientPaint
  | FigmaImagePaint
  | FigmaVideoPaint
  | FigmaPatternPaint

export type FigmaEffect = {
  type:
    | 'DROP_SHADOW'
    | 'INNER_SHADOW'
    | 'LAYER_BLUR'
    | 'BACKGROUND_BLUR'
  color?: RGBA
  offset?: { x: number; y: number }
  radius: number
  spread?: number
  visible?: boolean
  blendMode?: string
  showShadowBehindNode?: boolean
}

export type FigmaFontName = {
  family: string
  style: string
  size: number
  lineHeight?:
    | { value: number; unit: 'PIXELS' | 'PERCENT' }
    | {
        unit: 'AUTO'
      }
  letterSpacing?: {
    value: number
    unit: 'PIXELS' | 'PERCENT'
  }
}

export type FigmaStrokeGeom = {
  /** Uniform weight, or per-side [top,right,bottom,left]. */
  weight?: number
  weights?: [number, number, number, number]
  align?: string
  cap?: string
  join?: string
  miter?: number
  dash?: number[]
}

// --- color helpers ---

const round3 = (n: number): number =>
  Math.round(n * 1000) / 1000

export const hexToRgba = (hex: string): RGBA => {
  const clean = hex.replace('#', '')
  return {
    r: round3(parseInt(clean.slice(0, 2), 16) / 255),
    g: round3(parseInt(clean.slice(2, 4), 16) / 255),
    b: round3(parseInt(clean.slice(4, 6), 16) / 255),
    a:
      clean.length === 8
        ? round3(parseInt(clean.slice(6, 8), 16) / 255)
        : 1,
  }
}

export const rgbaToHex = (color: RGBA | RGB): string => {
  const toHex = (v: number): string =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()
  const base = `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`
  const a = 'a' in color ? color.a : 1
  if (a !== null && a !== undefined && a < 1) {
    return `${base}${toHex(a)}`
  }
  return base
}

// --- gradient transform math (ISOLATED) ---

/**
 * Build a Figma linear-gradient transform for an angle (degrees). The
 * transform is a rotation by θ about the gradient center (0.5, 0.5):
 * the first row's [cos, sin] encodes the direction so transformToAngle
 * recovers θ. Inverse-consistent with transformToAngle for any angle.
 */
export const angleToTransform = (
  deg: number,
): Transform => {
  const rad = (deg * Math.PI) / 180
  const cos = round3(Math.cos(rad))
  const sin = round3(Math.sin(rad))
  // Rotation about (0.5, 0.5): translate = c - R·c.
  const e = round3(0.5 - (cos * 0.5 + sin * 0.5))
  const f = round3(0.5 - (-sin * 0.5 + cos * 0.5))
  return [
    [cos, sin, e],
    [-sin, cos, f],
  ]
}

/** Recover the angle (degrees, rounded) from a gradient transform. */
export const transformToAngle = (t: Transform): number =>
  Math.round((Math.atan2(t[0][1], t[0][0]) * 180) / Math.PI)

// --- gradient handle-positions -> transform (the inverse direction) ---
//
// JSON_REST_V1 never exports gradientTransform — it exports 3
// gradientHandlePositions instead (node-spec-reader.ts). The math below
// recovers the FULL 6-element transform (skew, non-uniform scale, the
// works) from that triple. It is NOT derived by inspection of Figma's
// source; it was reverse-engineered against the real, live plugin: write a
// known gradientTransform via the write face's {tf=[...]} attr, read back
// the raw gradientHandlePositions Figma computed for it, and solve. See the
// fixtures in figma-paint.test.ts / node-spec-reader.test.ts — every
// expected value there is a live-captured number, not a hand guess.
//
// The relationship found: handle[i] = Sinv(c_i), where c0/c1/c2 are FIXED
// canonical points (below) and Sinv is the INVERSE of the paint's own
// gradientTransform. Equivalently: solve for the affine S with S(c_i) =
// handle[i] (two vector equations: handle1-handle0 and handle2-handle0
// against the canonical basis vectors e1=c1-c0, e2=c2-c0), then invert S to
// recover the transform T = Sinv^-1.

export type GradientHandle = { x: number; y: number }

type GradientKind =
  | 'GRADIENT_LINEAR'
  | 'GRADIENT_RADIAL'
  | 'GRADIENT_ANGULAR'
  | 'GRADIENT_DIAMOND'

// Canonical (identity-transform) handle positions per gradient kind —
// confirmed live: LINEAR's start handle sits at the left-middle edge (a
// linear gradient has no center); RADIAL, ANGULAR and DIAMOND all emit
// IDENTICAL handle positions for the same gradientTransform (one shared,
// center-based basis).
const CANONICAL_HANDLES: Record<
  GradientKind,
  readonly [GradientHandle, GradientHandle, GradientHandle]
> = {
  GRADIENT_LINEAR: [
    { x: 0, y: 0.5 },
    { x: 1, y: 0.5 },
    { x: 0, y: 1 },
  ],
  GRADIENT_RADIAL: [
    { x: 0.5, y: 0.5 },
    { x: 1, y: 0.5 },
    { x: 0.5, y: 1 },
  ],
  GRADIENT_ANGULAR: [
    { x: 0.5, y: 0.5 },
    { x: 1, y: 0.5 },
    { x: 0.5, y: 1 },
  ],
  GRADIENT_DIAMOND: [
    { x: 0.5, y: 0.5 },
    { x: 1, y: 0.5 },
    { x: 0.5, y: 1 },
  ],
}

// Guards the linear-algebra solve below against a truly degenerate handle
// triple (handle1/handle2 collinear with handle0 through the canonical
// basis — should never occur for a real Figma export). This is a
// numerical-stability guard against division by ~0, NOT the value-comparison
// tolerance used elsewhere (FLOAT_TOLERANCE, below) — the two serve
// different purposes and are deliberately different magnitudes.
const DET_EPSILON = 1e-9

/**
 * Derive the full 6-element gradientTransform from Figma's 3
 * gradientHandlePositions. Works for all four gradient types (LINEAR,
 * RADIAL, ANGULAR, DIAMOND) — see the module comment above for the math and
 * the live-verify story. Returns undefined only for a degenerate handle
 * triple (fewer than 3 handles, or the triple is collinear through the
 * canonical basis) — callers should fall back to a lower-fidelity
 * derivation or the identity transform in that case.
 */
export const handlesToTransform = (
  handles: GradientHandle[],
  kind: GradientKind,
): Transform | undefined => {
  if (handles.length < 3) {
    return undefined
  }
  const [h0, h1, h2] = handles
  const [c0, c1, c2] = CANONICAL_HANDLES[kind]
  const e1x = c1.x - c0.x
  const e1y = c1.y - c0.y
  const e2x = c2.x - c0.x
  const e2y = c2.y - c0.y
  // E = [e1 | e2] (columns); invert it to solve As = M . E^-1 below.
  const edet = e1x * e2y - e2x * e1y
  if (Math.abs(edet) < DET_EPSILON) {
    return undefined
  }
  const einv00 = e2y / edet
  const einv01 = -e2x / edet
  const einv10 = -e1y / edet
  const einv11 = e1x / edet
  const dx1 = h1.x - h0.x
  const dy1 = h1.y - h0.y
  const dx2 = h2.x - h0.x
  const dy2 = h2.y - h0.y
  // As = M . E^-1, M = [ [dx1,dx2], [dy1,dy2] ] — the linear part of the
  // affine S with S(c_i) = handle[i].
  const p = dx1 * einv00 + dx2 * einv10
  const q = dx1 * einv01 + dx2 * einv11
  const r = dy1 * einv00 + dy2 * einv10
  const s = dy1 * einv01 + dy2 * einv11
  const u = h0.x - (p * c0.x + q * c0.y)
  const v = h0.y - (r * c0.x + s * c0.y)
  // T = S^-1 (the paint's actual gradientTransform).
  const det = p * s - q * r
  if (Math.abs(det) < DET_EPSILON) {
    return undefined
  }
  return [
    [
      round3(s / det),
      round3(-q / det),
      round3((q * v - s * u) / det),
    ],
    [
      round3(-r / det),
      round3(p / det),
      round3((r * u - p * v) / det),
    ],
  ]
}

// --- pure-rotation / identity predicates (decide when {tf=} is needed) ---
//
// FLOAT_TOLERANCE is the comparison granularity for every transform
// component from here on: values are already stored at round3's 3-decimal
// precision, so this matches that (tighter would trip on ordinary
// floating-point noise from the matrix-inversion above; looser would blur
// genuinely different geometries together).
export const FLOAT_TOLERANCE = 1e-3

const transformsClose = (
  a: Transform,
  b: Transform,
  eps = FLOAT_TOLERANCE,
): boolean =>
  Math.abs(a[0][0] - b[0][0]) <= eps &&
  Math.abs(a[0][1] - b[0][1]) <= eps &&
  Math.abs(a[0][2] - b[0][2]) <= eps &&
  Math.abs(a[1][0] - b[1][0]) <= eps &&
  Math.abs(a[1][1] - b[1][1]) <= eps &&
  Math.abs(a[1][2] - b[1][2]) <= eps

/**
 * True when `t` carries no skew or non-uniform scale — i.e. it is (within
 * FLOAT_TOLERANCE) exactly the rotation-about-center transform that
 * angleToTransform(transformToAngle(t)) would produce. Only these round-trip
 * through the `linear(<angle>, …)` shorthand without loss; anything else
 * needs the `{tf=[a,b,c,d,e,f]}` escape hatch.
 */
export const isPureRotation = (t: Transform): boolean =>
  transformsClose(t, angleToTransform(transformToAngle(t)))

const IDENTITY_TRANSFORM: Transform = [
  [1, 0, 0],
  [0, 1, 0],
]

/**
 * True when `t` is the identity transform (within FLOAT_TOLERANCE) — the
 * only geometry radial/angular/diamond gradients can express WITHOUT a
 * `{tf=...}` attr, since those heads carry no angle argument at all.
 */
export const isIdentityTransform = (
  t: Transform,
): boolean => transformsClose(t, IDENTITY_TRANSFORM)

// --- attr helpers shared across converters ---

const num = (v: unknown): number | undefined =>
  typeof v === 'number' ? v : undefined

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined

const commonPaintAttrs = (
  attrs: Attrs | undefined,
): Pick<
  FigmaSolidPaint,
  'opacity' | 'visible' | 'blendMode'
> => {
  if (attrs === undefined) {
    return {}
  }
  const out: {
    opacity?: number
    visible?: boolean
    blendMode?: string
  } = {}
  if (typeof attrs.op === 'number') {
    out.opacity = attrs.op
  }
  if (attrs.vis === false) {
    out.visible = false
  }
  if (typeof attrs.blend === 'string') {
    out.blendMode = attrs.blend
  }
  return out
}

const paintAttrsFromObj = (p: {
  opacity?: number
  visible?: boolean
  blendMode?: string
}): Attrs => {
  const attrs: Attrs = {}
  if (p.opacity !== undefined && p.opacity < 1) {
    attrs.op = p.opacity
  }
  if (p.visible === false) {
    attrs.vis = false
  }
  if (
    p.blendMode !== undefined &&
    p.blendMode !== 'NORMAL'
  ) {
    attrs.blend = p.blendMode
  }
  return attrs
}

/** Wrap an attr bag as { attrs } only when non-empty. */
const attrsWrap = (attrs: Attrs): { attrs?: Attrs } =>
  Object.keys(attrs).length > 0 ? { attrs } : {}

// --- PAINT: atom <-> Figma ---

const GRADIENT_TYPE = {
  linear: 'GRADIENT_LINEAR',
  radial: 'GRADIENT_RADIAL',
  angular: 'GRADIENT_ANGULAR',
  diamond: 'GRADIENT_DIAMOND',
} as const

const solidFromHex = (
  hex: string,
  attrs: Attrs | undefined,
): FigmaSolidPaint => {
  const rgba = hexToRgba(hex)
  const out: FigmaSolidPaint = {
    type: 'SOLID',
    color: { r: rgba.r, g: rgba.g, b: rgba.b },
  }
  // Color alpha folds into paint opacity (Figma SolidPaint has no
  // color alpha). A {op=} attr takes precedence if present.
  if (rgba.a < 1) {
    out.opacity = rgba.a
  }
  const common = commonPaintAttrs(attrs)
  return { ...out, ...common }
}

const gradientFromHead = (
  head: 'linear' | 'radial' | 'angular' | 'diamond',
  args: AtomArg[],
  attrs: Attrs | undefined,
): FigmaGradientPaint => {
  let angle = 0
  let stopArgs = args
  if (head === 'linear' && args[0]?.kind === 'scalar') {
    angle = Number(args[0].value)
    stopArgs = args.slice(1)
  }
  const gradientStops = stopArgs
    .filter(
      (a): a is Extract<AtomArg, { kind: 'stop' }> =>
        a.kind === 'stop',
    )
    .map(a => ({
      position: a.position / 100,
      color: hexToRgba(a.hex),
    }))
  // tf= overrides the angle-derived transform (non-trivial geometry).
  const tf =
    attrs?.tf !== undefined && Array.isArray(attrs.tf)
      ? (attrs.tf as number[])
      : undefined
  const gradientTransform: Transform =
    tf !== undefined && tf.length === 6
      ? [
          [tf[0], tf[1], tf[2]],
          [tf[3], tf[4], tf[5]],
        ]
      : head === 'linear'
        ? angleToTransform(angle)
        : [
            [1, 0, 0],
            [0, 1, 0],
          ]
  return {
    type: GRADIENT_TYPE[head],
    gradientStops,
    gradientTransform,
    ...commonPaintAttrs(attrs),
  }
}

const imageFromHead = (
  args: AtomArg[],
  attrs: Attrs | undefined,
): FigmaImagePaint => {
  const a = args[0]
  const ref =
    a !== undefined && a.kind === 'scalar'
      ? String(a.value)
      : ''
  // A URL is write-only sugar; a bare token is treated as the hash.
  const isUrl =
    /^https?:\/\//.test(ref) || ref.startsWith('data:')
  const out: FigmaImagePaint = isUrl
    ? { type: 'IMAGE', imageHash: null, imageUrl: ref }
    : { type: 'IMAGE', imageHash: ref }
  if (attrs !== undefined) {
    const scale = str(attrs.scale)
    if (scale !== undefined) {
      out.scaleMode = scale
    }
    const rot = num(attrs.rot)
    if (rot !== undefined) {
      out.rotation = rot
    }
    const tile = num(attrs.tile)
    if (tile !== undefined) {
      out.scalingFactor = tile
    }
  }
  return { ...out, ...commonPaintAttrs(attrs) }
}

const astToPaint = (ast: AtomAST): FigmaPaint => {
  // bare hex literal => solid
  if (
    ast.kind === 'literal' &&
    typeof ast.value === 'string'
  ) {
    return solidFromHex(ast.value, ast.attrs)
  }
  if (ast.kind !== 'head') {
    throw new Error(
      `atomToPaint: not a paint atom (${ast.kind})`,
    )
  }
  const { head, args, attrs } = ast
  switch (head) {
    case 'solid': {
      const a = args[0]
      const hex =
        a.kind === 'color'
          ? a.hex
          : a.kind === 'scalar'
            ? String(a.value)
            : ''
      return solidFromHex(hex, attrs)
    }
    case 'linear':
    case 'radial':
    case 'angular':
    case 'diamond':
      return gradientFromHead(head, args, attrs)
    case 'image':
      return imageFromHead(args, attrs)
    case 'video': {
      const a = args[0]
      const hash =
        a !== undefined && a.kind === 'scalar'
          ? String(a.value)
          : null
      // Figma defaults scaleMode for IMAGE but NOT for VIDEO — a video
      // paint without one is rejected outright ("Required value missing
      // at [0].scaleMode"), so always emit one. scale= is the same attr
      // the image branch reads.
      return {
        type: 'VIDEO',
        videoHash: hash,
        scaleMode: str(attrs?.scale) ?? 'FILL',
        ...commonPaintAttrs(attrs),
      }
    }
    case 'pattern': {
      const a = args[0]
      return {
        type: 'PATTERN',
        sourceNodeId:
          a !== undefined && a.kind === 'scalar'
            ? String(a.value)
            : '',
        ...commonPaintAttrs(attrs),
      }
    }
    default:
      throw new Error(
        `atomToPaint: unknown paint "${head}"`,
      )
  }
}

export const atomToPaint = (s: string): FigmaPaint => {
  const ast = parseAtom(s)
  return astToPaint(ast)
}

const paintToAst = (p: FigmaPaint): AtomAST => {
  if (p.type === 'SOLID') {
    // Fold opacity back into color alpha for the compact hex view.
    const a = p.opacity ?? 1
    const hex = rgbaToHex({ ...p.color, a })
    const attrs = paintAttrsFromObj({
      visible: p.visible,
      blendMode: p.blendMode,
    })
    return {
      kind: 'literal',
      value: hex,
      ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    }
  }
  if (
    p.type === 'GRADIENT_LINEAR' ||
    p.type === 'GRADIENT_RADIAL' ||
    p.type === 'GRADIENT_ANGULAR' ||
    p.type === 'GRADIENT_DIAMOND'
  ) {
    const head = {
      GRADIENT_LINEAR: 'linear',
      GRADIENT_RADIAL: 'radial',
      GRADIENT_ANGULAR: 'angular',
      GRADIENT_DIAMOND: 'diamond',
    }[p.type]
    const args: AtomArg[] = []
    if (p.type === 'GRADIENT_LINEAR') {
      args.push({
        kind: 'scalar',
        value: transformToAngle(p.gradientTransform),
      })
    }
    for (const s of p.gradientStops) {
      args.push({
        kind: 'stop',
        hex: rgbaToHex(s.color),
        position: Math.round(s.position * 100),
      })
    }
    // Non-trivial geometry (skew, non-uniform scale) rides on {tf=...} — a
    // pure rotation keeps reading as linear(<angle>, …) with no tf attr.
    // RADIAL/ANGULAR/DIAMOND carry no angle argument at all, so ANY
    // non-identity transform for them needs tf.
    const attrs = paintAttrsFromObj(p)
    const needsTf =
      p.type === 'GRADIENT_LINEAR'
        ? !isPureRotation(p.gradientTransform)
        : !isIdentityTransform(p.gradientTransform)
    if (needsTf) {
      attrs.tf = p.gradientTransform[0].concat(
        p.gradientTransform[1],
      )
    }
    return {
      kind: 'head',
      head,
      args,
      ...attrsWrap(attrs),
    }
  }
  if (p.type === 'IMAGE') {
    const attrs = paintAttrsFromObj(p)
    if (
      p.scaleMode !== undefined &&
      p.scaleMode !== 'FILL'
    ) {
      attrs.scale = p.scaleMode
    }
    if (p.rotation !== undefined && p.rotation !== 0) {
      attrs.rot = p.rotation
    }
    if (p.scalingFactor !== undefined) {
      attrs.tile = p.scalingFactor
    }
    return {
      kind: 'head',
      head: 'image',
      args: [{ kind: 'scalar', value: p.imageHash ?? '' }],
      ...attrsWrap(attrs),
    }
  }
  if (p.type === 'VIDEO') {
    const attrs = paintAttrsFromObj(p)
    // FILL is what a bare video(...) atom means, so it stays implicit.
    if (
      p.scaleMode !== undefined &&
      p.scaleMode !== 'FILL'
    ) {
      attrs.scale = p.scaleMode
    }
    return {
      kind: 'head',
      head: 'video',
      args: [{ kind: 'scalar', value: p.videoHash ?? '' }],
      ...attrsWrap(attrs),
    }
  }
  if (p.type === 'PATTERN') {
    return {
      kind: 'head',
      head: 'pattern',
      args: [{ kind: 'scalar', value: p.sourceNodeId }],
      ...attrsWrap(paintAttrsFromObj(p)),
    }
  }
  throw new Error('paintToAtom: unknown paint type')
}

export const paintToAtom = (p: FigmaPaint): string =>
  renderAtom(paintToAst(p))

// --- EFFECT: atom <-> Figma ---

const EFFECT_HEAD = {
  shadow: 'DROP_SHADOW',
  'inner-shadow': 'INNER_SHADOW',
  blur: 'LAYER_BLUR',
  'bg-blur': 'BACKGROUND_BLUR',
} as const

const applyEffectAttrs = (
  out: FigmaEffect,
  attrs: Attrs | undefined,
): void => {
  if (attrs === undefined) {
    return
  }
  if (typeof attrs.spread === 'number') {
    out.spread = attrs.spread
  }
  if (typeof attrs.blend === 'string') {
    out.blendMode = attrs.blend
  }
  if (attrs.vis === false) {
    out.visible = false
  }
  if (attrs.behind === true) {
    out.showShadowBehindNode = true
  }
}

export const atomToEffect = (s: string): FigmaEffect => {
  const ast = parseAtom(s)
  if (ast.kind !== 'head') {
    throw new Error('atomToEffect: not an effect atom')
  }
  const { head, args, attrs } = ast
  if (head === 'shadow' || head === 'inner-shadow') {
    const x =
      args[0]?.kind === 'scalar' ? Number(args[0].value) : 0
    const y =
      args[1]?.kind === 'scalar' ? Number(args[1].value) : 0
    const r =
      args[2]?.kind === 'scalar' ? Number(args[2].value) : 0
    const colorArg = args[3]
    const color =
      colorArg?.kind === 'color'
        ? hexToRgba(colorArg.hex)
        : { r: 0, g: 0, b: 0, a: 1 }
    const out: FigmaEffect = {
      type: EFFECT_HEAD[head],
      offset: { x, y },
      radius: r,
      color,
      // Figma requires blendMode + visible on shadow effects; seed defaults so
      // the common path (no {blend=}/{vis=}) yields a valid effect. Explicit
      // attrs still override below.
      blendMode: 'NORMAL',
      visible: true,
    }
    applyEffectAttrs(out, attrs)
    return out
  }
  if (head === 'blur' || head === 'bg-blur') {
    const r =
      args[0]?.kind === 'scalar' ? Number(args[0].value) : 0
    const out: FigmaEffect = {
      type: EFFECT_HEAD[head],
      radius: r,
      // Figma requires visible on blur effects (blurs have no blendMode).
      visible: true,
    }
    applyEffectAttrs(out, attrs)
    return out
  }
  throw new Error(`atomToEffect: unknown effect "${head}"`)
}

const effectToAst = (e: FigmaEffect): AtomAST => {
  const attrs: Attrs = {}
  if (e.spread !== undefined && e.spread !== 0) {
    attrs.spread = e.spread
  }
  if (
    e.blendMode !== undefined &&
    e.blendMode !== 'NORMAL'
  ) {
    attrs.blend = e.blendMode
  }
  if (e.visible === false) {
    attrs.vis = false
  }
  if (e.showShadowBehindNode === true) {
    attrs.behind = true
  }
  if (
    e.type === 'DROP_SHADOW' ||
    e.type === 'INNER_SHADOW'
  ) {
    const head =
      e.type === 'DROP_SHADOW' ? 'shadow' : 'inner-shadow'
    const color = e.color ?? { r: 0, g: 0, b: 0, a: 1 }
    return {
      kind: 'head',
      head,
      args: [
        { kind: 'scalar', value: e.offset?.x ?? 0 },
        { kind: 'scalar', value: e.offset?.y ?? 0 },
        { kind: 'scalar', value: e.radius },
        { kind: 'color', hex: rgbaToHex(color) },
      ],
      ...attrsWrap(attrs),
    }
  }
  const head = e.type === 'LAYER_BLUR' ? 'blur' : 'bg-blur'
  return {
    kind: 'head',
    head,
    args: [{ kind: 'scalar', value: e.radius }],
    ...attrsWrap(attrs),
  }
}

export const effectToAtom = (e: FigmaEffect): string =>
  renderAtom(effectToAst(e))

// --- FONT: atom <-> Figma ---

const parseLineHeight = (
  raw: string,
): FigmaFontName['lineHeight'] => {
  if (raw === 'auto' || raw === 'AUTO') {
    return { unit: 'AUTO' }
  }
  if (raw.endsWith('%')) {
    return {
      value: Number(raw.slice(0, -1)),
      unit: 'PERCENT',
    }
  }
  return { value: Number(raw), unit: 'PIXELS' }
}

const parseLetterSpacing = (
  raw: string,
): NonNullable<FigmaFontName['letterSpacing']> => {
  if (raw.endsWith('%')) {
    return {
      value: Number(raw.slice(0, -1)),
      unit: 'PERCENT',
    }
  }
  return { value: Number(raw), unit: 'PIXELS' }
}

export const atomToFont = (s: string): FigmaFontName => {
  const ast = parseAtom(s)
  if (ast.kind !== 'head' || ast.head !== 'font') {
    throw new Error('atomToFont: not a font atom')
  }
  const { args, attrs } = ast
  const family =
    args[0]?.kind === 'scalar' ? String(args[0].value) : ''
  const style =
    args[1]?.kind === 'scalar' ? String(args[1].value) : ''
  const size =
    args[2]?.kind === 'scalar' ? Number(args[2].value) : 0
  const out: FigmaFontName = { family, style, size }
  if (attrs?.lh !== undefined) {
    out.lineHeight = parseLineHeight(String(attrs.lh))
  }
  if (attrs?.ls !== undefined) {
    out.letterSpacing = parseLetterSpacing(String(attrs.ls))
  }
  return out
}

const fontToAst = (f: FigmaFontName): AtomAST => {
  const attrs: Attrs = {}
  if (f.lineHeight !== undefined) {
    if (f.lineHeight.unit === 'AUTO') {
      // AUTO is the default — omit.
    } else if (f.lineHeight.unit === 'PERCENT') {
      attrs.lh = `${f.lineHeight.value}%`
    } else {
      attrs.lh = f.lineHeight.value
    }
  }
  if (
    f.letterSpacing !== undefined &&
    f.letterSpacing.value !== 0
  ) {
    attrs.ls =
      f.letterSpacing.unit === 'PERCENT'
        ? `${f.letterSpacing.value}%`
        : f.letterSpacing.value
  }
  return {
    kind: 'head',
    head: 'font',
    args: [
      { kind: 'scalar', value: f.family },
      { kind: 'scalar', value: f.style },
      { kind: 'scalar', value: f.size },
    ],
    ...attrsWrap(attrs),
  }
}

export const fontToAtom = (f: FigmaFontName): string =>
  renderAtom(fontToAst(f))

// --- STROKE GEOMETRY: atom <-> Figma ---

export const atomToStroke = (
  s: string,
): FigmaStrokeGeom => {
  const ast = parseAtom(s)
  if (ast.kind !== 'head' || ast.head !== 'stroke') {
    throw new Error('atomToStroke: not a stroke atom')
  }
  const { args, attrs } = ast
  const out: FigmaStrokeGeom = {}
  const a = args[0]
  if (a?.kind === 'scalar') {
    out.weight = Number(a.value)
  } else if (a?.kind === 'tuple') {
    out.weights = a.items.map(Number) as [
      number,
      number,
      number,
      number,
    ]
  }
  if (attrs !== undefined) {
    if (typeof attrs.align === 'string') {
      out.align = attrs.align
    }
    if (typeof attrs.cap === 'string') {
      out.cap = attrs.cap
    }
    if (typeof attrs.join === 'string') {
      out.join = attrs.join
    }
    if (typeof attrs.miter === 'number') {
      out.miter = attrs.miter
    }
    if (Array.isArray(attrs.dash)) {
      out.dash = (attrs.dash as number[]).map(Number)
    }
  }
  return out
}

const strokeToAst = (g: FigmaStrokeGeom): AtomAST => {
  const attrs: Attrs = {}
  if (g.align !== undefined && g.align !== 'CENTER') {
    attrs.align = g.align
  }
  if (g.cap !== undefined) {
    attrs.cap = g.cap
  }
  if (g.join !== undefined) {
    attrs.join = g.join
  }
  if (g.miter !== undefined) {
    attrs.miter = g.miter
  }
  if (g.dash !== undefined && g.dash.length > 0) {
    attrs.dash = g.dash
  }
  const arg: AtomArg =
    g.weights !== undefined
      ? { kind: 'tuple', items: g.weights }
      : { kind: 'scalar', value: g.weight ?? 0 }
  return {
    kind: 'head',
    head: 'stroke',
    args: [arg],
    ...attrsWrap(attrs),
  }
}

export const strokeToAtom = (g: FigmaStrokeGeom): string =>
  renderAtom(strokeToAst(g))
