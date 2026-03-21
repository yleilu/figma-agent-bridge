// --- Color parsing ---

export type ParsedGradientStop = {
  position: number
  color: { r: number; g: number; b: number; a: number }
}

// Flat paint descriptor — all fields are present on every variant
// (fields irrelevant to a given type will be absent at runtime but
//  TypeScript treats them as potentially present so tests can access
//  them without narrowing)
export interface ParsedPaint {
  type:
    | 'SOLID'
    | 'GRADIENT_LINEAR'
    | 'GRADIENT_RADIAL'
    | 'GRADIENT_ANGULAR'
    | 'GRADIENT_DIAMOND'
    | 'IMAGE'
  color: { r: number; g: number; b: number }
  opacity: number
  gradientStops: ParsedGradientStop[]
  angle: number
  imageUrl: string
  imageHash: string
  scaleMode: string
  styleName: string
}

export interface ParsedEffect {
  type:
    | 'DROP_SHADOW'
    | 'INNER_SHADOW'
    | 'LAYER_BLUR'
    | 'BACKGROUND_BLUR'
  offset: { x: number; y: number }
  radius: number
  color: { r: number; g: number; b: number; a: number }
  spread: number
  styleName: string
}

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
  let clean = hex.replace('#', '')
  // Expand 3-char shorthand to 6-char
  if (clean.length === 3) {
    clean =
      clean[0] +
      clean[0] +
      clean[1] +
      clean[1] +
      clean[2] +
      clean[2]
  }
  const r = round3(parseInt(clean.slice(0, 2), 16) / 255)
  const g = round3(parseInt(clean.slice(2, 4), 16) / 255)
  const b = round3(parseInt(clean.slice(4, 6), 16) / 255)
  const a =
    clean.length === 8
      ? round3(parseInt(clean.slice(6, 8), 16) / 255)
      : 1
  return { r, g, b, a }
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
): ParsedPaint => {
  const { styleName, value } = extractStylePrefix(expr)

  if (value === 'image') {
    return {
      type: 'IMAGE',
      ...(styleName ? { styleName } : {}),
    } as unknown as ParsedPaint
  }

  // image(url) or image(url,scaleMode)
  const imageUrlMatch = value.match(
    /^image\((.+?)(?:,(\w+))?\)$/,
  )
  if (imageUrlMatch) {
    return {
      type: 'IMAGE',
      imageUrl: imageUrlMatch[1],
      ...(imageUrlMatch[2]
        ? { scaleMode: imageUrlMatch[2] }
        : {}),
      ...(styleName ? { styleName } : {}),
    } as unknown as ParsedPaint
  }

  // image-hash(hash)
  const imageHashMatch = value.match(
    /^image-hash\((.+?)\)$/,
  )
  if (imageHashMatch) {
    return {
      type: 'IMAGE',
      imageHash: imageHashMatch[1],
      ...(styleName ? { styleName } : {}),
    } as unknown as ParsedPaint
  }

  // Gradient patterns
  const gradientMatch = value.match(
    /^(linear|radial|angular|diamond)-gradient\((.+)\)$/,
  )
  if (gradientMatch) {
    const gradientType = gradientMatch[1]
    const inner = gradientMatch[2]

    const typeMap: Record<string, ParsedPaint['type']> = {
      linear: 'GRADIENT_LINEAR',
      radial: 'GRADIENT_RADIAL',
      angular: 'GRADIENT_ANGULAR',
      diamond: 'GRADIENT_DIAMOND',
    }

    let angle: number | undefined
    let stopsStr = inner

    if (gradientType === 'linear') {
      const angleMatch = inner.match(
        /^(\d+(?:\.\d+)?)deg,\s*(.+)$/,
      )
      if (angleMatch) {
        angle = parseFloat(angleMatch[1])
        // eslint-disable-next-line @typescript-eslint/prefer-destructuring
        stopsStr = angleMatch[2]
      }
    }

    const gradientStops = parseGradientStops(stopsStr)

    return {
      type: typeMap[gradientType],
      gradientStops,
      ...(angle !== undefined ? { angle } : {}),
      ...(styleName ? { styleName } : {}),
    } as unknown as ParsedPaint
  }

  // Solid hex
  const color = hexToRgb(value)
  return {
    type: 'SOLID',
    color: { r: color.r, g: color.g, b: color.b },
    opacity: color.a,
    ...(styleName ? { styleName } : {}),
  } as unknown as ParsedPaint
}

export const parseFillExpressions = (
  expressions: string[],
): ParsedPaint[] => {
  return expressions.map(parseColorExpression)
}

export const parseEffectExpressions = (
  expressions: string[],
): ParsedEffect[] => {
  return expressions.map(expr => {
    const { styleName, value } = extractStylePrefix(expr)

    // shadow(x,y,radius,color) or shadow(x,y,radius,color,spread)
    const shadowMatch = value.match(
      /^(shadow|inner-shadow)\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(#[0-9A-Fa-f]{3,8})(?:,(\d+(?:\.\d+)?))?\)$/,
    )
    if (shadowMatch) {
      const color = hexToRgb(shadowMatch[5])
      return {
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
      } as unknown as ParsedEffect
    }

    // blur(radius)
    const blurMatch = value.match(
      /^(blur|bg-blur)\((\d+(?:\.\d+)?)\)$/,
    )
    if (blurMatch) {
      return {
        type:
          blurMatch[1] === 'blur'
            ? 'LAYER_BLUR'
            : 'BACKGROUND_BLUR',
        radius: parseFloat(blurMatch[2]),
        ...(styleName ? { styleName } : {}),
      } as unknown as ParsedEffect
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
