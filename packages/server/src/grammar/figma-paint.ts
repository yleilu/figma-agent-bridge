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
      return {
        type: 'VIDEO',
        videoHash: hash,
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
    return {
      kind: 'head',
      head,
      args,
      ...attrsWrap(paintAttrsFromObj(p)),
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
    return {
      kind: 'head',
      head: 'video',
      args: [{ kind: 'scalar', value: p.videoHash ?? '' }],
      ...attrsWrap(paintAttrsFromObj(p)),
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
