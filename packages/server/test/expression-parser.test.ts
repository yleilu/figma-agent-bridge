import { describe, expect, it } from 'bun:test'
import {
  parseColorExpression,
  parseFillExpressions,
  parseEffectExpressions,
  parseFontExpression,
  parseLineHeightExpression,
  parseLetterSpacingExpression,
} from '@figma-agent-bridge/server/expression-parser'

describe('parseColorExpression', () => {
  it('parses 6-char hex', () => {
    const result = parseColorExpression('#3B82F6')
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
    expect(result.color.r).toBe(0)
    expect(result.color.g).toBe(0)
    expect(result.color.b).toBe(0)
    expect(result.opacity).toBeCloseTo(0.251, 2)
  })

  it('strips style() prefix and parses hex', () => {
    const result = parseColorExpression(
      'style(Colors/Primary/500)#3B82F6',
    )
    expect(result.color.r).toBeCloseTo(0.231, 2)
    expect(result.styleName).toBe('Colors/Primary/500')
  })

  it('parses linear-gradient expression', () => {
    const result = parseColorExpression(
      'linear-gradient(90deg, #FF0000 0%, #0000FF 100%)',
    )
    expect(result.type).toBe('GRADIENT_LINEAR')
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
    expect(result.type).toBe('GRADIENT_RADIAL')
    expect(result.gradientStops).toHaveLength(2)
  })

  it('parses angular-gradient expression', () => {
    const result = parseColorExpression(
      'angular-gradient(#FF0000 0%, #00FF00 50%, #0000FF 100%)',
    )
    expect(result.type).toBe('GRADIENT_ANGULAR')
    expect(result.gradientStops).toHaveLength(3)
  })

  it('parses diamond-gradient expression', () => {
    const result = parseColorExpression(
      'diamond-gradient(#FF0000 0%, #0000FF 100%)',
    )
    expect(result.type).toBe('GRADIENT_DIAMOND')
    expect(result.gradientStops).toHaveLength(2)
  })

  it('returns image sentinel for "image"', () => {
    const result = parseColorExpression('image')
    expect(result.type).toBe('IMAGE')
  })

  it('parses image() with URL', () => {
    const result = parseColorExpression(
      'image(https://example.com/photo.jpg)',
    )
    expect(result.type).toBe('IMAGE')
    expect((result as { imageUrl: string }).imageUrl).toBe(
      'https://example.com/photo.jpg',
    )
  })

  it('parses image() with URL and scaleMode', () => {
    const result = parseColorExpression(
      'image(https://example.com/photo.jpg,FIT)',
    )
    expect(result.type).toBe('IMAGE')
    expect((result as { imageUrl: string }).imageUrl).toBe(
      'https://example.com/photo.jpg',
    )
    expect(
      (result as { scaleMode: string }).scaleMode,
    ).toBe('FIT')
  })

  it('parses image-hash() with hash value', () => {
    const result = parseColorExpression(
      'image-hash(abc123def)',
    )
    expect(result.type).toBe('IMAGE')
    expect(
      (result as { imageHash: string }).imageHash,
    ).toBe('abc123def')
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
    expect(paints[1].opacity).toBeCloseTo(0.502, 2)
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
    expect(effects[0].offset).toEqual({ x: 0, y: 4 })
    expect(effects[0].radius).toBe(8)
    expect(effects[0].color.a).toBeCloseTo(0.251, 2)
  })

  it('parses shadow() with spread', () => {
    const effects = parseEffectExpressions([
      'shadow(0,4,8,#000000,2)',
    ])
    expect(effects).toHaveLength(1)
    expect(effects[0].spread).toBe(2)
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
      'shadow(0,4,8,#000)',
      'blur(2)',
    ])
    expect(effects).toHaveLength(2)
    expect(effects[0].type).toBe('DROP_SHADOW')
    expect(effects[1].type).toBe('LAYER_BLUR')
  })

  it('strips style() prefix from effects', () => {
    const effects = parseEffectExpressions([
      'style(Elevation/Medium)shadow(0,4,8,#00000040)',
    ])
    expect(effects).toHaveLength(1)
    expect(effects[0].type).toBe('DROP_SHADOW')
    expect(effects[0].styleName).toBe('Elevation/Medium')
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
})
