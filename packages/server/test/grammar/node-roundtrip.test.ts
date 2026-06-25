// node-roundtrip.test.ts — parse the worked-example node from
// expression-formats.md. Cross-checks that every atom leaf in a real
// NodeSpec parses + renders back to itself, and the typed converters
// turn those leaves into the expected Figma objects.

import { describe, expect, it } from 'bun:test'
import {
  parseAtom,
  renderAtom,
  atomToPaint,
  atomToFont,
  atomToEffect,
  atomToStroke,
  transformToAngle,
} from '@figma-agent-bridge/server/grammar'
import type { NodeSpec } from '@figma-agent-bridge/shared/node-spec'

// The worked example from expression-formats.md, expressed as a
// NodeSpec (atom-string leaves). solid(#FFFFFF) is shown as the
// canonical bare hex (the view face), per the "solid() optional" rule.
const card: NodeSpec = {
  type: 'FRAME',
  name: 'Card',
  id: '12:34',
  size: [320, 180],
  fills: [
    '#FFFFFF',
    'linear(135, #3B82F6@0, #1D4ED8@100){op=0.08}',
  ],
  stroke: 'stroke(1){align=INSIDE}',
  strokes: ['#E5E7EB'],
  effects: ['shadow(0,4,12,#0000001A){spread=0}'],
  radius: '12',
  layout: {
    mode: 'V',
    gap: 8,
    pad: [16, 16, 16, 16],
    align: ['MIN', 'MIN'],
  },
  children: [
    {
      type: 'TEXT',
      name: 'Title',
      text: {
        content: 'Monthly report',
        font: 'style(Heading/H3)font(Inter,SemiBold,18){lh=24}',
        color: '#111827',
      },
    },
    {
      type: 'TEXT',
      name: 'Caption',
      text: {
        content: 'Updated today',
        font: 'font(Inter,Regular,13)',
        color: '#6B7280',
      },
    },
  ],
}

const everyAtom = (n: NodeSpec): string[] => {
  const atoms: string[] = []
  if (n.fills) {
    atoms.push(...n.fills)
  }
  if (n.strokes) {
    atoms.push(...n.strokes)
  }
  if (n.stroke) {
    atoms.push(n.stroke)
  }
  if (n.effects) {
    atoms.push(...n.effects)
  }
  if (n.radius) {
    atoms.push(n.radius)
  }
  if (n.text?.font) {
    atoms.push(n.text.font)
  }
  if (n.text?.color) {
    atoms.push(n.text.color)
  }
  for (const c of n.children ?? []) {
    atoms.push(...everyAtom(c))
  }
  return atoms
}

describe('worked-example node', () => {
  it('every atom leaf round-trips', () => {
    for (const atom of everyAtom(card)) {
      expect(renderAtom(parseAtom(atom))).toBe(atom)
    }
  })

  it('the gradient fill is a linear paint at angle 135 with stops', () => {
    const p = atomToPaint(card.fills![1])
    if (p.type !== 'GRADIENT_LINEAR') {
      throw new Error('expected linear gradient')
    }
    expect(transformToAngle(p.gradientTransform)).toBe(135)
    expect(p.gradientStops).toHaveLength(2)
    expect(p.opacity).toBe(0.08)
  })

  it('the solid white fill folds to opaque solid', () => {
    expect(atomToPaint(card.fills![0])).toEqual({
      type: 'SOLID',
      color: { r: 1, g: 1, b: 1 },
    })
  })

  it('the stroke geometry is weight 1, align INSIDE', () => {
    expect(atomToStroke(card.stroke!)).toEqual({
      weight: 1,
      align: 'INSIDE',
    })
  })

  it('the effect is a drop shadow (x,y,radius) with spread 0', () => {
    // shadow(0,4,12,#0000001A) => x=0, y=4, radius=12.
    const e = atomToEffect(card.effects![0])
    expect(e.type).toBe('DROP_SHADOW')
    expect(e.offset).toEqual({ x: 0, y: 4 })
    expect(e.radius).toBe(12)
    expect(e.spread).toBe(0)
  })

  it('the Title font carries the style() wrapper + line height', () => {
    const title = card.children![0] as NodeSpec
    const fontAtom = title.text!.font
    const ast = parseAtom(fontAtom)
    expect(ast.wrapper).toEqual({
      kind: 'style',
      name: 'Heading/H3',
    })
    // atomToFont drops the wrapper to the resolved font.
    expect(atomToFont(fontAtom)).toEqual({
      family: 'Inter',
      style: 'SemiBold',
      size: 18,
      lineHeight: { value: 24, unit: 'PIXELS' },
    })
  })
})
