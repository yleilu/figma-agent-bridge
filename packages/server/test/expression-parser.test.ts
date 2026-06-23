import { describe, expect, it } from 'bun:test'
import {
  parseColorExpression,
  parseFillExpressions,
  parseEffectExpression,
  parseEffectExpressions,
  parseFontExpression,
  parseLineHeightExpression,
  parseLetterSpacingExpression,
} from '@figma-agent-bridge/server/expression-parser'

describe('parseColorExpression', () => {
  it('parses 6-char hex', () => {
    const result = parseColorExpression('#3B82F6')
    expect(result).not.toBeNull()
    if (!result || result.type !== 'SOLID') {
      throw new Error('Expected SOLID')
    }
    expect(result).toEqual({
      type: 'SOLID',
      color: { r: 0.231, g: 0.51, b: 0.965 },
      opacity: 1,
    })
    expect(result.color.r).toBeCloseTo(0.231, 2)
    expect(result.color.g).toBeCloseTo(0.51, 2)
    expect(result.color.b).toBeCloseTo(0.965, 2)
  })

  it('parses 8-char hex with alpha', () => {
    const result = parseColorExpression('#00000040')
    if (!result || result.type !== 'SOLID') {
      throw new Error('Expected SOLID')
    }
    expect(result.color.r).toBe(0)
    expect(result.color.g).toBe(0)
    expect(result.color.b).toBe(0)
    expect(result.opacity).toBeCloseTo(0.251, 2)
  })

  it('strips style() prefix and parses hex', () => {
    const result = parseColorExpression(
      'style(Colors/Primary/500)#3B82F6',
    )
    if (!result || result.type !== 'SOLID') {
      throw new Error('Expected SOLID')
    }
    expect(result.color.r).toBeCloseTo(0.231, 2)
    expect(result.styleName).toBe('Colors/Primary/500')
  })

  it('parses linear-gradient expression', () => {
    const result = parseColorExpression(
      'linear-gradient(90deg, #FF0000 0%, #0000FF 100%)',
    )
    if (!result || result.type !== 'GRADIENT_LINEAR') {
      throw new Error('Expected GRADIENT_LINEAR')
    }
    expect(result.gradientStops).toHaveLength(2)
    expect(result.gradientStops[0].position).toBe(0)
    expect(result.gradientStops[0].color.r).toBeCloseTo(
      1,
      2,
    )
    expect(result.gradientStops[1].position).toBe(1)
    expect(result.gradientStops[1].color.b).toBeCloseTo(
      1,
      2,
    )
    expect(result.angle).toBe(90)
  })

  it('parses radial-gradient expression', () => {
    const result = parseColorExpression(
      'radial-gradient(#FFFFFF 0%, #00000000 100%)',
    )
    if (
      !result ||
      (result.type !== 'GRADIENT_LINEAR' &&
        result.type !== 'GRADIENT_RADIAL' &&
        result.type !== 'GRADIENT_ANGULAR' &&
        result.type !== 'GRADIENT_DIAMOND')
    ) {
      throw new Error('Expected gradient type')
    }
    expect(result.gradientStops).toHaveLength(2)
  })

  it('parses angular-gradient expression', () => {
    const result = parseColorExpression(
      'angular-gradient(#FF0000 0%, #00FF00 50%, #0000FF 100%)',
    )
    if (
      !result ||
      (result.type !== 'GRADIENT_LINEAR' &&
        result.type !== 'GRADIENT_RADIAL' &&
        result.type !== 'GRADIENT_ANGULAR' &&
        result.type !== 'GRADIENT_DIAMOND')
    ) {
      throw new Error('Expected gradient type')
    }
    expect(result.gradientStops).toHaveLength(3)
  })

  it('parses diamond-gradient expression', () => {
    const result = parseColorExpression(
      'diamond-gradient(#FF0000 0%, #0000FF 100%)',
    )
    if (
      !result ||
      (result.type !== 'GRADIENT_LINEAR' &&
        result.type !== 'GRADIENT_RADIAL' &&
        result.type !== 'GRADIENT_ANGULAR' &&
        result.type !== 'GRADIENT_DIAMOND')
    ) {
      throw new Error('Expected gradient type')
    }
    expect(result.gradientStops).toHaveLength(2)
  })

  it('returns image sentinel for "image"', () => {
    const result = parseColorExpression('image')
    if (!result) {
      throw new Error('Expected non-null')
    }
    expect(result.type).toBe('IMAGE')
  })

  it('parses image() with URL', () => {
    const result = parseColorExpression(
      'image(https://example.com/photo.jpg)',
    )
    if (!result || result.type !== 'IMAGE') {
      throw new Error('Expected IMAGE')
    }
    expect(result.imageUrl).toBe(
      'https://example.com/photo.jpg',
    )
  })

  it('parses image() with URL and scaleMode', () => {
    const result = parseColorExpression(
      'image(https://example.com/photo.jpg,FIT)',
    )
    if (!result || result.type !== 'IMAGE') {
      throw new Error('Expected IMAGE')
    }
    expect(result.imageUrl).toBe(
      'https://example.com/photo.jpg',
    )
    expect(result.scaleMode).toBe('FIT')
  })

  it('parses image-hash() with hash value', () => {
    const result = parseColorExpression(
      'image-hash(abc123def)',
    )
    if (!result || result.type !== 'IMAGE') {
      throw new Error('Expected IMAGE')
    }
    expect(result.imageHash).toBe('abc123def')
  })

  // Type narrowing: verify discriminated union narrows correctly
  it('SOLID paint has color and opacity but not gradient fields', () => {
    const result = parseColorExpression('#FF0000')
    if (!result || result.type !== 'SOLID') {
      throw new Error('Expected SOLID')
    }
    expect(result.color).toBeDefined()
    expect(result.opacity).toBe(1)
    // Type narrowing means gradientStops is not accessible here
  })

  it('GRADIENT_LINEAR paint has gradientStops and angle', () => {
    const result = parseColorExpression(
      'linear-gradient(45deg, #FF0000 0%, #0000FF 100%)',
    )
    if (!result || result.type !== 'GRADIENT_LINEAR') {
      throw new Error('Expected GRADIENT_LINEAR')
    }
    expect(result.gradientStops).toHaveLength(2)
    expect(result.angle).toBe(45)
  })

  it('IMAGE paint has imageUrl field', () => {
    const result = parseColorExpression(
      'image(https://cdn.example.com/img.png)',
    )
    if (!result || result.type !== 'IMAGE') {
      throw new Error('Expected IMAGE')
    }
    expect(result.imageUrl).toBe(
      'https://cdn.example.com/img.png',
    )
  })

  it('returns null for 3-char hex shorthand', () => {
    const result = parseColorExpression('#F00')
    expect(result).toBeNull()
  })

  it('omits angle for non-linear gradients', () => {
    const radial = parseColorExpression(
      'radial-gradient(#FFFFFF 0%, #00000000 100%)',
    )
    if (!radial || radial.type !== 'GRADIENT_RADIAL') {
      throw new Error('Expected GRADIENT_RADIAL')
    }
    expect('angle' in radial).toBe(false)

    const angular = parseColorExpression(
      'angular-gradient(#FF0000 0%, #0000FF 100%)',
    )
    if (!angular || angular.type !== 'GRADIENT_ANGULAR') {
      throw new Error('Expected GRADIENT_ANGULAR')
    }
    expect('angle' in angular).toBe(false)
  })

  it('keeps angle for linear gradients', () => {
    const linear = parseColorExpression(
      'linear-gradient(45deg, #FF0000 0%, #0000FF 100%)',
    )
    if (!linear || linear.type !== 'GRADIENT_LINEAR') {
      throw new Error('Expected GRADIENT_LINEAR')
    }
    expect(linear.angle).toBe(45)
  })
})

describe('parseFillExpressions', () => {
  it('converts array of expressions to paint objects', () => {
    const paints = parseFillExpressions([
      '#FF0000',
      '#0000FF80',
    ])
    expect(paints).toHaveLength(2)
    expect(paints[0].type).toBe('SOLID')
    const paint1 = paints[1]
    if (paint1.type !== 'SOLID') {
      throw new Error('Expected SOLID')
    }
    expect(paint1.opacity).toBeCloseTo(0.502, 2)
  })

  it('handles empty array', () => {
    const paints = parseFillExpressions([])
    expect(paints).toHaveLength(0)
  })
})

describe('parseEffectExpressions', () => {
  it('parses shadow() expression', () => {
    const effects = parseEffectExpressions([
      'shadow(0,4,8,#00000040)',
    ])
    expect(effects).toHaveLength(1)
    expect(effects[0].type).toBe('DROP_SHADOW')
    const effect = effects[0]
    if (
      effect.type !== 'DROP_SHADOW' &&
      effect.type !== 'INNER_SHADOW'
    ) {
      throw new Error('Expected shadow type')
    }
    expect(effect.offset).toEqual({ x: 0, y: 4 })
    expect(effect.radius).toBe(8)
    expect(effect.color.a).toBeCloseTo(0.251, 2)
  })

  it('parses shadow() with spread', () => {
    const effects = parseEffectExpressions([
      'shadow(0,4,8,#000000,2)',
    ])
    expect(effects).toHaveLength(1)
    const effect = effects[0]
    if (
      effect.type !== 'DROP_SHADOW' &&
      effect.type !== 'INNER_SHADOW'
    ) {
      throw new Error('Expected shadow type')
    }
    expect(effect.spread).toBe(2)
  })

  it('parses inner-shadow() expression', () => {
    const effects = parseEffectExpressions([
      'inner-shadow(0,2,4,#00000020)',
    ])
    expect(effects).toHaveLength(1)
    expect(effects[0].type).toBe('INNER_SHADOW')
  })

  it('parses blur() expression', () => {
    const effects = parseEffectExpressions(['blur(10)'])
    expect(effects).toHaveLength(1)
    expect(effects[0].type).toBe('LAYER_BLUR')
    expect(effects[0].radius).toBe(10)
  })

  it('parses bg-blur() expression', () => {
    const effects = parseEffectExpressions(['bg-blur(20)'])
    expect(effects).toHaveLength(1)
    expect(effects[0].type).toBe('BACKGROUND_BLUR')
    expect(effects[0].radius).toBe(20)
  })

  it('parses multiple mixed effects', () => {
    const effects = parseEffectExpressions([
      'shadow(0,4,8,#000000)',
      'blur(2)',
    ])
    expect(effects).toHaveLength(2)
    expect(effects[0].type).toBe('DROP_SHADOW')
    expect(effects[1].type).toBe('LAYER_BLUR')
  })

  it('parses shadow with full 6-char hex color values', () => {
    const result = parseEffectExpression(
      'shadow(0,4,8,#000000)',
    )
    expect(result).not.toBeNull()
    if (result && result.type === 'DROP_SHADOW') {
      expect(result.color.r).toBe(0)
      expect(result.color.g).toBe(0)
      expect(result.color.b).toBe(0)
    }
  })

  it('returns null for shadow with 3-char hex', () => {
    const result = parseEffectExpression(
      'shadow(0,4,8,#000)',
    )
    expect(result).toBeNull()
  })

  it('strips style() prefix from effects', () => {
    const effects = parseEffectExpressions([
      'style(Elevation/Medium)shadow(0,4,8,#00000040)',
    ])
    expect(effects).toHaveLength(1)
    expect(effects[0].type).toBe('DROP_SHADOW')
    expect(effects[0].styleName).toBe('Elevation/Medium')
  })

  // Type narrowing: verify discriminated union narrows correctly
  it('DROP_SHADOW effect has offset, color, radius, spread fields', () => {
    const effects = parseEffectExpressions([
      'shadow(2,4,8,#0000FF80,3)',
    ])
    const effect = effects[0]
    expect(effect.type).toBe('DROP_SHADOW')
    if (
      effect.type !== 'DROP_SHADOW' &&
      effect.type !== 'INNER_SHADOW'
    ) {
      throw new Error('Expected shadow type')
    }
    expect(effect.offset).toEqual({ x: 2, y: 4 })
    expect(effect.radius).toBe(8)
    expect(effect.spread).toBe(3)
    expect(effect.color.r).toBe(0)
    expect(effect.color.g).toBe(0)
    expect(effect.color.b).toBeCloseTo(1, 2)
    expect(effect.color.a).toBeCloseTo(0.502, 2)
  })

  it('LAYER_BLUR effect has only radius field', () => {
    const effects = parseEffectExpressions(['blur(15)'])
    const effect = effects[0]
    expect(effect.type).toBe('LAYER_BLUR')
    if (
      effect.type !== 'LAYER_BLUR' &&
      effect.type !== 'BACKGROUND_BLUR'
    ) {
      throw new Error('Expected blur type')
    }
    expect(effect.radius).toBe(15)
    // offset and color are not accessible with narrowing — blur has no offset/color
  })

  it('BACKGROUND_BLUR effect has only radius field', () => {
    const effects = parseEffectExpressions(['bg-blur(8)'])
    const effect = effects[0]
    expect(effect.type).toBe('BACKGROUND_BLUR')
    if (
      effect.type !== 'LAYER_BLUR' &&
      effect.type !== 'BACKGROUND_BLUR'
    ) {
      throw new Error('Expected blur type')
    }
    expect(effect.radius).toBe(8)
  })

  it('throws on an unknown effect expression', () => {
    expect(() =>
      parseEffectExpressions(['glow(5)']),
    ).toThrow('Unknown effect expression: glow(5)')
  })

  it('matches parseEffectExpression for every supported form', () => {
    const inputs = [
      'shadow(0,4,8,#00000040)',
      'shadow(0,4,8,#000000,2)',
      'inner-shadow(0,2,4,#00000020)',
      'blur(10)',
      'bg-blur(20)',
      'style(Elevation/Medium)shadow(0,4,8,#00000040)',
    ]
    const batch = parseEffectExpressions(inputs)
    for (let i = 0; i < inputs.length; i++) {
      expect(batch[i]).toEqual(
        parseEffectExpression(inputs[i])!,
      )
    }
  })
})

describe('parseFontExpression', () => {
  it('parses family/style/size', () => {
    const result = parseFontExpression('Inter/SemiBold/18')
    expect(result.family).toBe('Inter')
    expect(result.style).toBe('SemiBold')
    expect(result.size).toBe(18)
  })

  it('parses style() prefixed font', () => {
    const result = parseFontExpression(
      'style(Heading/H1)Inter/Bold/32',
    )
    expect(result.family).toBe('Inter')
    expect(result.style).toBe('Bold')
    expect(result.size).toBe(32)
    expect(result.styleName).toBe('Heading/H1')
  })

  it('handles multi-word style names', () => {
    const result = parseFontExpression(
      'Inter/Bold Italic/16',
    )
    expect(result.family).toBe('Inter')
    expect(result.style).toBe('Bold Italic')
    expect(result.size).toBe(16)
  })

  it('handles font families with spaces', () => {
    const result = parseFontExpression(
      'Noto Sans/Regular/14',
    )
    expect(result.family).toBe('Noto Sans')
    expect(result.style).toBe('Regular')
    expect(result.size).toBe(14)
  })

  it('throws on a 0-slash font expression', () => {
    expect(() => parseFontExpression('Inter')).toThrow(
      'Invalid font expression',
    )
  })

  it('throws on a 1-slash font expression', () => {
    expect(() => parseFontExpression('Inter/18')).toThrow(
      'Invalid font expression',
    )
  })

  it('throws on a non-numeric font size', () => {
    expect(() =>
      parseFontExpression('Inter/Regular/abc'),
    ).toThrow('Invalid font size')
  })
})

describe('parseLineHeightExpression', () => {
  it('parses px value', () => {
    const result = parseLineHeightExpression('24px')
    expect(result).toEqual({ value: 24, unit: 'PIXELS' })
  })

  it('parses percentage value', () => {
    const result = parseLineHeightExpression('150%')
    expect(result).toEqual({ value: 150, unit: 'PERCENT' })
  })

  it('parses auto', () => {
    const result = parseLineHeightExpression('auto')
    expect(result).toEqual({ unit: 'AUTO' })
  })

  it('throws on a non-numeric line height', () => {
    expect(() =>
      parseLineHeightExpression('abcpx'),
    ).toThrow('Invalid line height')
  })
})

describe('parseLetterSpacingExpression', () => {
  it('parses px value', () => {
    const result = parseLetterSpacingExpression('0.5px')
    expect(result).toEqual({ value: 0.5, unit: 'PIXELS' })
  })

  it('parses percentage value', () => {
    const result = parseLetterSpacingExpression('2%')
    expect(result).toEqual({ value: 2, unit: 'PERCENT' })
  })

  it('throws on a non-numeric letter spacing', () => {
    expect(() =>
      parseLetterSpacingExpression('abcpx'),
    ).toThrow('Invalid letter spacing')
  })
})
