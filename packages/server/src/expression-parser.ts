// --- Color parsing ---

export type ParsedGradientStop = {
  position: number
  color: { r: number; g: number; b: number; a: number }
}

export type ParsedSolidPaint = {
  type: 'SOLID'
  color: { r: number; g: number; b: number }
  opacity: number
  styleName?: string
}

export type ParsedGradientPaint = {
  type:
    | 'GRADIENT_LINEAR'
    | 'GRADIENT_RADIAL'
    | 'GRADIENT_ANGULAR'
    | 'GRADIENT_DIAMOND'
  gradientStops: ParsedGradientStop[]
  angle: number
  styleName?: string
}

export type ParsedImagePaint = {
  type: 'IMAGE'
  imageUrl?: string
  imageHash?: string
  scaleMode?: string
  styleName?: string
}

export type ParsedPaint =
  | ParsedSolidPaint
  | ParsedGradientPaint
  | ParsedImagePaint

export type ParsedShadowEffect = {
  type: 'DROP_SHADOW' | 'INNER_SHADOW'
  offset: { x: number; y: number }
  radius: number
  spread?: number
  color: { r: number; g: number; b: number; a: number }
  styleName?: string
}

export type ParsedBlurEffect = {
  type: 'LAYER_BLUR' | 'BACKGROUND_BLUR'
  radius: number
  styleName?: string
}

export type ParsedEffect =
  | ParsedShadowEffect
  | ParsedBlurEffect

export type ParsedFont = {
  family: string
  style: string
  size: number
  styleName?: string
}

export type ParsedLineHeight =
  | { value: number; unit: 'PIXELS' }
  | { value: number; unit: 'PERCENT' }
  | { unit: 'AUTO' }

export type ParsedLetterSpacing = {
  value: number
  unit: 'PIXELS' | 'PERCENT'
}

// --- Helpers ---

const extractStylePrefix = (
  expr: string,
): { styleName?: string; value: string } => {
  const match = expr.match(/^style\(([^)]+)\)(.*)$/)
  if (match) {
    return { styleName: match[1], value: match[2] }
  }
  return { value: expr }
}

const round3 = (n: number): number =>
  Math.round(n * 1000) / 1000

const hexToRgb = (
  hex: string,
): { r: number; g: number; b: number; a: number } => {
  const clean = hex.replace('#', '')
  const r = round3(parseInt(clean.slice(0, 2), 16) / 255)
  const g = round3(parseInt(clean.slice(2, 4), 16) / 255)
  const b = round3(parseInt(clean.slice(4, 6), 16) / 255)
  const a =
    clean.length === 8
      ? round3(parseInt(clean.slice(6, 8), 16) / 255)
      : 1
  return { r, g, b, a }
}

const isValidHexLength = (hex: string): boolean => {
  const clean = hex.replace('#', '')
  return clean.length === 6 || clean.length === 8
}

const parseGradientStops = (
  stopsStr: string,
): ParsedGradientStop[] => {
  const stops: ParsedGradientStop[] = []
  // Match patterns like "#FF0000 0%" or "#00FF00 50%"
  const regex = /(#[0-9A-Fa-f]{6,8})\s+(\d+(?:\.\d+)?)%/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(stopsStr)) !== null) {
    const color = hexToRgb(match[1])
    const position = parseFloat(match[2]) / 100
    stops.push({ position, color })
  }
  return stops
}

// --- Public API ---

export const parseColorExpression = (
  expr: string,
): ParsedPaint | null => {
  const { styleName, value } = extractStylePrefix(expr)

  if (value === 'image') {
    const result: ParsedImagePaint = {
      type: 'IMAGE',
      ...(styleName ? { styleName } : {}),
    }
    return result
  }

  // image(url) or image(url,scaleMode)
  const imageUrlMatch = value.match(
    /^image\((.+?)(?:,(\w+))?\)$/,
  )
  if (imageUrlMatch) {
    const result: ParsedImagePaint = {
      type: 'IMAGE',
      imageUrl: imageUrlMatch[1],
      ...(imageUrlMatch[2]
        ? { scaleMode: imageUrlMatch[2] }
        : {}),
      ...(styleName ? { styleName } : {}),
    }
    return result
  }

  // image-hash(hash)
  const imageHashMatch = value.match(
    /^image-hash\((.+?)\)$/,
  )
  if (imageHashMatch) {
    const result: ParsedImagePaint = {
      type: 'IMAGE',
      imageHash: imageHashMatch[1],
      ...(styleName ? { styleName } : {}),
    }
    return result
  }

  // Gradient patterns
  const gradientMatch = value.match(
    /^(linear|radial|angular|diamond)-gradient\((.+)\)$/,
  )
  if (gradientMatch) {
    const gradientType = gradientMatch[1]
    const inner = gradientMatch[2]

    const typeMap: Record<
      string,
      ParsedGradientPaint['type']
    > = {
      linear: 'GRADIENT_LINEAR',
      radial: 'GRADIENT_RADIAL',
      angular: 'GRADIENT_ANGULAR',
      diamond: 'GRADIENT_DIAMOND',
    }

    let angle = 0
    let stopsStr = inner

    if (gradientType === 'linear') {
      const angleMatch = inner.match(
        /^(-?\d+(?:\.\d+)?)deg,\s*(.+)$/,
      )
      if (angleMatch) {
        angle = parseFloat(angleMatch[1])
        // eslint-disable-next-line @typescript-eslint/prefer-destructuring
        stopsStr = angleMatch[2]
      }
    }

    const gradientStops = parseGradientStops(stopsStr)

    const result: ParsedGradientPaint = {
      type: typeMap[gradientType],
      gradientStops,
      angle,
      ...(styleName ? { styleName } : {}),
    }
    return result
  }

  // Solid hex — must be 6 or 8 chars (no shorthand)
  if (!isValidHexLength(value)) {
    return null
  }
  const color = hexToRgb(value)
  const result: ParsedSolidPaint = {
    type: 'SOLID',
    color: { r: color.r, g: color.g, b: color.b },
    opacity: color.a,
    ...(styleName ? { styleName } : {}),
  }
  return result
}

export const parseFillExpressions = (
  expressions: string[],
): ParsedPaint[] => {
  return expressions
    .map(parseColorExpression)
    .filter((p): p is ParsedPaint => p !== null)
}

export const parseEffectExpression = (
  expr: string,
): ParsedEffect | null => {
  const { styleName, value } = extractStylePrefix(expr)

  // shadow(x,y,radius,color) or shadow(x,y,radius,color,spread)
  const shadowMatch = value.match(
    /^(shadow|inner-shadow)\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(#[0-9A-Fa-f]{6,8})(?:,(\d+(?:\.\d+)?))?\)$/,
  )
  if (shadowMatch) {
    const color = hexToRgb(shadowMatch[5])
    const result: ParsedShadowEffect = {
      type:
        shadowMatch[1] === 'shadow'
          ? 'DROP_SHADOW'
          : 'INNER_SHADOW',
      offset: {
        x: parseFloat(shadowMatch[2]),
        y: parseFloat(shadowMatch[3]),
      },
      radius: parseFloat(shadowMatch[4]),
      color,
      ...(shadowMatch[6] !== undefined
        ? { spread: parseFloat(shadowMatch[6]) }
        : {}),
      ...(styleName ? { styleName } : {}),
    }
    return result
  }

  // blur(radius)
  const blurMatch = value.match(
    /^(blur|bg-blur)\((\d+(?:\.\d+)?)\)$/,
  )
  if (blurMatch) {
    const result: ParsedBlurEffect = {
      type:
        blurMatch[1] === 'blur'
          ? 'LAYER_BLUR'
          : 'BACKGROUND_BLUR',
      radius: parseFloat(blurMatch[2]),
      ...(styleName ? { styleName } : {}),
    }
    return result
  }

  return null
}

export const parseEffectExpressions = (
  expressions: string[],
): ParsedEffect[] => {
  return expressions.map(expr => {
    const { styleName, value } = extractStylePrefix(expr)

    // shadow(x,y,radius,color) or shadow(x,y,radius,color,spread)
    const shadowMatch = value.match(
      /^(shadow|inner-shadow)\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(#[0-9A-Fa-f]{6,8})(?:,(\d+(?:\.\d+)?))?\)$/,
    )
    if (shadowMatch) {
      const color = hexToRgb(shadowMatch[5])
      const result: ParsedShadowEffect = {
        type:
          shadowMatch[1] === 'shadow'
            ? 'DROP_SHADOW'
            : 'INNER_SHADOW',
        offset: {
          x: parseFloat(shadowMatch[2]),
          y: parseFloat(shadowMatch[3]),
        },
        radius: parseFloat(shadowMatch[4]),
        color,
        ...(shadowMatch[6] !== undefined
          ? { spread: parseFloat(shadowMatch[6]) }
          : {}),
        ...(styleName ? { styleName } : {}),
      }
      return result
    }

    // blur(radius)
    const blurMatch = value.match(
      /^(blur|bg-blur)\((\d+(?:\.\d+)?)\)$/,
    )
    if (blurMatch) {
      const result: ParsedBlurEffect = {
        type:
          blurMatch[1] === 'blur'
            ? 'LAYER_BLUR'
            : 'BACKGROUND_BLUR',
        radius: parseFloat(blurMatch[2]),
        ...(styleName ? { styleName } : {}),
      }
      return result
    }

    throw new Error(`Unknown effect expression: ${expr}`)
  })
}

export const parseFontExpression = (
  expr: string,
): ParsedFont => {
  const { styleName, value } = extractStylePrefix(expr)

  // Font format: Family/Style/Size
  // Split from the right — size is always last, style is second-to-last
  const lastSlash = value.lastIndexOf('/')
  const sizeStr = value.slice(lastSlash + 1)
  const rest = value.slice(0, lastSlash)
  const secondSlash = rest.lastIndexOf('/')
  const style = rest.slice(secondSlash + 1)
  const family = rest.slice(0, secondSlash)

  return {
    family,
    style,
    size: parseFloat(sizeStr),
    ...(styleName ? { styleName } : {}),
  }
}

export const parseLineHeightExpression = (
  expr: string,
): ParsedLineHeight => {
  if (expr === 'auto') {
    return { unit: 'AUTO' }
  }
  if (expr.endsWith('px')) {
    return { value: parseFloat(expr), unit: 'PIXELS' }
  }
  if (expr.endsWith('%')) {
    return { value: parseFloat(expr), unit: 'PERCENT' }
  }
  // Default to pixels if no unit
  return { value: parseFloat(expr), unit: 'PIXELS' }
}

export const parseLetterSpacingExpression = (
  expr: string,
): ParsedLetterSpacing => {
  if (expr.endsWith('%')) {
    return { value: parseFloat(expr), unit: 'PERCENT' }
  }
  if (expr.endsWith('px')) {
    return { value: parseFloat(expr), unit: 'PIXELS' }
  }
  return { value: parseFloat(expr), unit: 'PIXELS' }
}
