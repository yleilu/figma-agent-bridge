import { describe, expect, it } from 'bun:test'
import { parseNode } from '@figma-agent-bridge/server/parser'
import { parseColorExpression } from '@figma-agent-bridge/server/expression-parser'

describe('parser round-trip fixes', () => {
  it('includes shadow spread in effect expression', () => {
    const raw = {
      id: '1:1',
      name: 'Box',
      type: 'FRAME',
      absoluteBoundingBox: {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
      fills: [],
      effects: [
        {
          type: 'DROP_SHADOW',
          visible: true,
          color: { r: 0, g: 0, b: 0, a: 0.25 },
          offset: { x: 0, y: 4 },
          radius: 8,
          spread: 2,
        },
      ],
    }

    const parsed = parseNode(raw)
    expect(parsed.effects).toBeDefined()
    expect(parsed.effects![0]).toBe(
      'shadow(0,4,8,#00000040,2)',
    )
  })

  it('omits spread from expression when spread is 0', () => {
    const raw = {
      id: '1:2',
      name: 'Box2',
      type: 'FRAME',
      absoluteBoundingBox: {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
      fills: [],
      effects: [
        {
          type: 'DROP_SHADOW',
          visible: true,
          color: { r: 0, g: 0, b: 0, a: 0.25 },
          offset: { x: 0, y: 4 },
          radius: 8,
          spread: 0,
        },
      ],
    }

    const parsed = parseNode(raw)
    expect(parsed.effects![0]).toBe(
      'shadow(0,4,8,#00000040)',
    )
  })

  it('emits inner-shadow() for INNER_SHADOW effects', () => {
    const raw = {
      id: '1:1b',
      name: 'InnerBox',
      type: 'FRAME',
      absoluteBoundingBox: {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
      fills: [],
      effects: [
        {
          type: 'INNER_SHADOW',
          visible: true,
          color: { r: 0, g: 0, b: 0, a: 0.5 },
          offset: { x: 2, y: 2 },
          radius: 4,
          spread: 0,
        },
      ],
    }

    const parsed = parseNode(raw)
    expect(parsed.effects![0]).toBe(
      'inner-shadow(2,2,4,#00000080)',
    )
  })

  it('emits bg-blur() for BACKGROUND_BLUR effects', () => {
    const raw = {
      id: '1:1c',
      name: 'BlurBox',
      type: 'FRAME',
      absoluteBoundingBox: {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
      fills: [],
      effects: [
        {
          type: 'BACKGROUND_BLUR',
          visible: true,
          radius: 10,
        },
      ],
    }

    const parsed = parseNode(raw)
    expect(parsed.effects![0]).toBe('bg-blur(10)')
  })

  it('includes strokeAlign in parsed output', () => {
    const raw = {
      id: '1:3',
      name: 'Bordered',
      type: 'RECTANGLE',
      absoluteBoundingBox: {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
      fills: [
        {
          type: 'SOLID',
          visible: true,
          color: { r: 1, g: 1, b: 1, a: 1 },
        },
      ],
      strokes: [
        {
          type: 'SOLID',
          visible: true,
          color: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
      strokeWeight: 2,
      strokeAlign: 'INSIDE',
      dashPattern: [4, 4],
    }

    const parsed = parseNode(raw)
    expect(parsed.strokeWeight).toBe(2)
    expect(parsed.strokeAlign).toBe('INSIDE')
    expect(parsed.strokeDash).toEqual([4, 4])
  })

  it('includes per-corner radius', () => {
    const raw = {
      id: '1:4',
      name: 'Rounded',
      type: 'RECTANGLE',
      absoluteBoundingBox: {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
      fills: [],
      cornerRadius: null, // mixed
      rectangleCornerRadii: [8, 8, 0, 0],
    }

    const parsed = parseNode(raw)
    expect(parsed.radius).toEqual([8, 8, 0, 0])
  })

  it('includes text lineHeight and letterSpacing', () => {
    const raw = {
      id: '1:5',
      name: 'Styled Text',
      type: 'TEXT',
      absoluteBoundingBox: {
        x: 0,
        y: 0,
        width: 200,
        height: 48,
      },
      fills: [
        {
          type: 'SOLID',
          visible: true,
          color: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
      characters: 'Hello',
      style: {
        fontFamily: 'Inter',
        fontStyle: 'Regular',
        fontSize: 16,
        textAlignHorizontal: 'LEFT',
        lineHeightPx: 24,
        lineHeightUnit: 'PIXELS',
        letterSpacing: 0.5,
      },
      textAutoResize: 'HEIGHT',
    }

    const parsed = parseNode(raw)
    expect(parsed.text).toBeDefined()
    expect(parsed.text!.lineHeight).toBe('24px')
    expect(parsed.text!.letterSpacing).toBe('0.5px')
    expect(parsed.textAutoResize).toBe('HEIGHT')
  })

  it('includes text decoration and case', () => {
    const raw = {
      id: '1:6',
      name: 'Decorated',
      type: 'TEXT',
      absoluteBoundingBox: {
        x: 0,
        y: 0,
        width: 200,
        height: 24,
      },
      fills: [
        {
          type: 'SOLID',
          visible: true,
          color: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
      characters: 'Hello',
      style: {
        fontFamily: 'Inter',
        fontStyle: 'Regular',
        fontSize: 16,
        textAlignHorizontal: 'LEFT',
        textDecoration: 'UNDERLINE',
        textCase: 'UPPER',
      },
    }

    const parsed = parseNode(raw)
    expect(parsed.text!.decoration).toBe('UNDERLINE')
    expect(parsed.text!.case).toBe('UPPER')
  })

  it('includes layoutPositioning', () => {
    const raw = {
      id: '1:7',
      name: 'Badge',
      type: 'FRAME',
      absoluteBoundingBox: {
        x: 0,
        y: 0,
        width: 40,
        height: 40,
      },
      fills: [],
      layoutPositioning: 'ABSOLUTE',
    }

    const parsed = parseNode(raw)
    expect(parsed.layoutPositioning).toBe('ABSOLUTE')
  })

  it('includes gradient fills as expressions', () => {
    const raw = {
      id: '1:8',
      name: 'Gradient',
      type: 'RECTANGLE',
      absoluteBoundingBox: {
        x: 0,
        y: 0,
        width: 400,
        height: 300,
      },
      fills: [
        {
          type: 'GRADIENT_LINEAR',
          visible: true,
          gradientTransform: [
            [0, -1, 1],
            [1, 0, 0],
          ],
          gradientStops: [
            {
              position: 0,
              color: { r: 1, g: 0, b: 0, a: 1 },
            },
            {
              position: 1,
              color: { r: 0, g: 0, b: 1, a: 1 },
            },
          ],
        },
      ],
    }

    const parsed = parseNode(raw)
    expect(parsed.fills).toBeDefined()
    expect(parsed.fills![0]).toMatch(/^linear-gradient\(/)
    expect(parsed.fills![0]).toContain('#FF0000')
    expect(parsed.fills![0]).toContain('#0000FF')
  })

  it('round-trips a negative linear-gradient angle exactly', () => {
    const raw = {
      id: '1:9',
      name: 'NegGradient',
      type: 'RECTANGLE',
      absoluteBoundingBox: {
        x: 0,
        y: 0,
        width: 400,
        height: 300,
      },
      fills: [
        {
          type: 'GRADIENT_LINEAR',
          visible: true,
          // atan2(transform[0][1], transform[0][0]) = atan2(-1, 0) = -90deg
          gradientTransform: [
            [0, -1, 1],
            [1, 0, 0],
          ],
          gradientStops: [
            {
              position: 0,
              color: { r: 1, g: 0, b: 0, a: 1 },
            },
            {
              position: 1,
              color: { r: 0, g: 0, b: 1, a: 1 },
            },
          ],
        },
      ],
    }

    const parsed = parseNode(raw)
    const expr = parsed.fills![0]
    expect(expr).toBe(
      'linear-gradient(-90deg, #FF0000 0%, #0000FF 100%)',
    )

    const reparsed = parseColorExpression(expr)
    if (!reparsed || reparsed.type !== 'GRADIENT_LINEAR') {
      throw new Error('Expected GRADIENT_LINEAR')
    }
    expect(reparsed.angle).toBe(-90)
  })
})
