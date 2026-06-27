// figma-paint.test.ts — AST <-> Figma object converters.
//
// atomToX(XToAtom(obj)) deep-equals obj for paints/effects/font/stroke;
// the gradient-transform math (angleToTransform/transformToAngle) is
// covered explicitly incl. negative angles (feedback_gradient_tests).

import { describe, expect, it } from 'bun:test'
import {
  atomToPaint,
  paintToAtom,
  atomToEffect,
  effectToAtom,
  atomToFont,
  fontToAtom,
  atomToStroke,
  strokeToAtom,
  angleToTransform,
  transformToAngle,
  hexToRgba,
  rgbaToHex,
} from '@figma-agent-bridge/server/grammar'
import type {
  FigmaPaint,
  FigmaEffect,
  FigmaFontName,
  FigmaStrokeGeom,
} from '@figma-agent-bridge/server/grammar'

// --- color helpers ---
describe('color helpers', () => {
  it('hexToRgba 6-char', () => {
    expect(hexToRgba('#FF0000')).toEqual({
      r: 1,
      g: 0,
      b: 0,
      a: 1,
    })
  })
  it('hexToRgba 8-char alpha', () => {
    expect(hexToRgba('#00000080').a).toBe(0.502)
  })
  it('rgbaToHex drops alpha when opaque', () => {
    expect(rgbaToHex({ r: 1, g: 0, b: 0, a: 1 })).toBe(
      '#FF0000',
    )
  })
  it('rgbaToHex keeps alpha when translucent', () => {
    expect(rgbaToHex({ r: 0, g: 0, b: 0, a: 0.502 })).toBe(
      '#00000080',
    )
  })
})

// --- gradient transform math (ISOLATED) ---
describe('gradient transform math', () => {
  const angles = [0, 45, 90, 135, 180, -45, -90, -135]
  for (const a of angles) {
    it(`angle ${a} -> transform -> angle`, () => {
      expect(transformToAngle(angleToTransform(a))).toBe(a)
    })
  }
  it('transform is a 2x3 matrix', () => {
    const t = angleToTransform(45)
    expect(t).toHaveLength(2)
    expect(t[0]).toHaveLength(3)
    expect(t[1]).toHaveLength(3)
  })
  it('angle 0 is the identity-direction transform', () => {
    const t = angleToTransform(0)
    expect(t[0][0]).toBe(1)
    expect(t[0][1]).toBe(0)
  })
})

// --- PAINT round-trip ---
describe('paint: atomToPaint(paintToAtom(p)) deep-equals p', () => {
  const cases: { name: string; p: FigmaPaint }[] = [
    {
      name: 'solid opaque',
      p: {
        type: 'SOLID',
        color: { r: 0.231, g: 0.51, b: 0.965 },
      },
    },
    {
      name: 'solid translucent (alpha->opacity)',
      p: {
        type: 'SOLID',
        color: { r: 0, g: 0, b: 0 },
        opacity: 0.502,
      },
    },
    {
      name: 'linear gradient (angle + stops)',
      p: {
        type: 'GRADIENT_LINEAR',
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
        gradientTransform: angleToTransform(135),
      },
    },
    {
      name: 'radial gradient',
      p: {
        type: 'GRADIENT_RADIAL',
        gradientStops: [
          {
            position: 0,
            color: { r: 1, g: 1, b: 1, a: 1 },
          },
          {
            position: 1,
            color: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
        gradientTransform: [
          [1, 0, 0],
          [0, 1, 0],
        ],
      },
    },
    {
      name: 'angular gradient',
      p: {
        type: 'GRADIENT_ANGULAR',
        gradientStops: [
          {
            position: 0,
            color: { r: 1, g: 0, b: 0, a: 1 },
          },
          {
            position: 0.5,
            color: { r: 0, g: 1, b: 0, a: 1 },
          },
          {
            position: 1,
            color: { r: 0, g: 0, b: 1, a: 1 },
          },
        ],
        gradientTransform: [
          [1, 0, 0],
          [0, 1, 0],
        ],
      },
    },
    {
      name: 'diamond gradient',
      p: {
        type: 'GRADIENT_DIAMOND',
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
        gradientTransform: [
          [1, 0, 0],
          [0, 1, 0],
        ],
      },
    },
    {
      name: 'image (hash)',
      p: { type: 'IMAGE', imageHash: 'abc123' },
    },
    {
      name: 'image with scale/rot',
      p: {
        type: 'IMAGE',
        imageHash: 'abc123',
        scaleMode: 'CROP',
        rotation: 90,
      },
    },
    {
      name: 'video',
      p: { type: 'VIDEO', videoHash: 'vid1' },
    },
    {
      name: 'pattern',
      p: { type: 'PATTERN', sourceNodeId: '12:34' },
    },
  ]

  for (const { name, p } of cases) {
    it(name, () => {
      const atom = paintToAtom(p)
      expect(atomToPaint(atom)).toEqual(p)
    })
  }

  it('linear gradient angle survives the object round-trip', () => {
    const p: FigmaPaint = {
      type: 'GRADIENT_LINEAR',
      gradientStops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
      ],
      gradientTransform: angleToTransform(-45),
    }
    const back = atomToPaint(paintToAtom(p))
    if (back.type !== 'GRADIENT_LINEAR') {
      throw new Error('expected linear')
    }
    expect(transformToAngle(back.gradientTransform)).toBe(
      -45,
    )
  })
})

// --- EFFECT round-trip ---
describe('effect: atomToEffect(effectToAtom(e)) deep-equals e', () => {
  // Effects are COMPLETE Figma objects: shadows carry blendMode + visible,
  // blurs carry visible (Figma requires them). effectToAtom drops the
  // NORMAL/true defaults so atoms stay compact; atomToEffect re-seeds them,
  // so the round-trip is a true identity.
  const cases: { name: string; e: FigmaEffect }[] = [
    {
      name: 'drop shadow',
      e: {
        type: 'DROP_SHADOW',
        offset: { x: 0, y: 4 },
        radius: 8,
        color: { r: 0, g: 0, b: 0, a: 0.251 },
        blendMode: 'NORMAL',
        visible: true,
      },
    },
    {
      name: 'inner shadow',
      e: {
        type: 'INNER_SHADOW',
        offset: { x: 0, y: 2 },
        radius: 4,
        color: { r: 0, g: 0, b: 0, a: 0.125 },
        blendMode: 'NORMAL',
        visible: true,
      },
    },
    {
      name: 'drop shadow with spread + behind',
      e: {
        type: 'DROP_SHADOW',
        offset: { x: 0, y: 4 },
        radius: 12,
        color: { r: 0, g: 0, b: 0, a: 0.102 },
        spread: 2,
        showShadowBehindNode: true,
        blendMode: 'NORMAL',
        visible: true,
      },
    },
    {
      name: 'drop shadow with explicit blend (MULTIPLY)',
      e: {
        type: 'DROP_SHADOW',
        offset: { x: 0, y: 4 },
        radius: 8,
        color: { r: 0, g: 0, b: 0, a: 0.251 },
        blendMode: 'MULTIPLY',
        visible: true,
      },
    },
    {
      name: 'layer blur',
      e: { type: 'LAYER_BLUR', radius: 10, visible: true },
    },
    {
      name: 'background blur',
      e: {
        type: 'BACKGROUND_BLUR',
        radius: 20,
        visible: true,
      },
    },
  ]
  for (const { name, e } of cases) {
    it(name, () => {
      expect(atomToEffect(effectToAtom(e))).toEqual(e)
    })
  }
})

// Shape guard (guard-b): atomToEffect must emit the fields Figma REQUIRES on
// each effect — shadows need blendMode + visible, blurs need visible. Omitting
// them is exactly the A1 bug Figma rejected at runtime; this catches the drift
// at the converter (the source) without instrumenting the whole mock.
describe('effect: atomToEffect emits Figma-required fields', () => {
  it('drop shadow (default path) carries blendMode + visible', () => {
    const e = atomToEffect('shadow(0,4,8,#00000040)')
    expect(e.blendMode).toBe('NORMAL')
    expect(e.visible).toBe(true)
  })
  it('inner shadow carries blendMode + visible', () => {
    const e = atomToEffect('inner-shadow(0,2,4,#00000020)')
    expect(e.blendMode).toBe('NORMAL')
    expect(e.visible).toBe(true)
  })
  it('blur carries visible but NOT blendMode', () => {
    const e = atomToEffect('blur(10)')
    expect(e.visible).toBe(true)
    expect(e.blendMode).toBeUndefined()
  })
  it('explicit {blend=} overrides the seeded default', () => {
    const e = atomToEffect(
      'shadow(0,4,8,#000000){blend=MULTIPLY}',
    )
    expect(e.blendMode).toBe('MULTIPLY')
    expect(e.visible).toBe(true)
  })
  it('explicit {vis=false} overrides the seeded default', () => {
    const e = atomToEffect(
      'shadow(0,4,8,#000000){vis=false}',
    )
    expect(e.visible).toBe(false)
  })
})

// --- FONT round-trip ---
describe('font: atomToFont(fontToAtom(f)) deep-equals f', () => {
  const cases: { name: string; f: FigmaFontName }[] = [
    {
      name: 'plain',
      f: { family: 'Inter', style: 'SemiBold', size: 18 },
    },
    {
      name: 'with px line height',
      f: {
        family: 'Inter',
        style: 'SemiBold',
        size: 18,
        lineHeight: { value: 24, unit: 'PIXELS' },
      },
    },
    {
      name: 'with percent line height',
      f: {
        family: 'Inter',
        style: 'Regular',
        size: 16,
        lineHeight: { value: 150, unit: 'PERCENT' },
      },
    },
    {
      name: 'with letter spacing',
      f: {
        family: 'Inter',
        style: 'Bold',
        size: 32,
        letterSpacing: { value: 0.5, unit: 'PIXELS' },
      },
    },
    {
      name: 'with percent letter spacing',
      f: {
        family: 'Inter',
        style: 'Bold',
        size: 32,
        // PERCENT must round-trip as PERCENT, not silently become PIXELS.
        letterSpacing: { value: 5, unit: 'PERCENT' },
      },
    },
  ]
  for (const { name, f } of cases) {
    it(name, () => {
      expect(atomToFont(fontToAtom(f))).toEqual(f)
    })
  }
})

// --- STROKE round-trip ---
describe('stroke: atomToStroke(strokeToAtom(g)) deep-equals g', () => {
  const cases: { name: string; g: FigmaStrokeGeom }[] = [
    { name: 'uniform weight', g: { weight: 2 } },
    {
      name: 'full geometry',
      g: {
        weight: 2,
        align: 'INSIDE',
        cap: 'ROUND',
        join: 'MITER',
        miter: 4,
        dash: [4, 4],
      },
    },
    {
      name: 'per-side weights',
      g: { weights: [2, 0, 2, 0] },
    },
    {
      name: 'arbitrary-length dash',
      g: { weight: 1, dash: [4, 2, 1, 2] },
    },
  ]
  for (const { name, g } of cases) {
    it(name, () => {
      expect(atomToStroke(strokeToAtom(g))).toEqual(g)
    })
  }
})

// --- lossy-view defaults are dropped on render (T4) ---
// The string round-trip law holds because a default is dropped on BOTH
// faces; these lock the drop *direction* so a future change that starts
// emitting a default value is caught (the round-trip tests above would
// still pass since they never carry the default).
describe('lossy defaults are omitted on render (T4)', () => {
  it('drops spread=0 from a shadow', () => {
    expect(
      effectToAtom({
        type: 'DROP_SHADOW',
        offset: { x: 0, y: 4 },
        radius: 8,
        color: { r: 0, g: 0, b: 0, a: 0.251 },
        spread: 0,
      }),
    ).not.toContain('spread')
  })
  it('drops opacity=1 (op) from a solid paint', () => {
    expect(
      paintToAtom({
        type: 'SOLID',
        color: { r: 0, g: 0, b: 0 },
        opacity: 1,
      }),
    ).not.toContain('op=')
  })
  it('drops align=CENTER (default) from stroke geometry', () => {
    expect(
      strokeToAtom({ weight: 2, align: 'CENTER' }),
    ).not.toContain('align')
  })
})
