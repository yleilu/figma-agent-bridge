// round-trip.test.ts — the central test surface (T8).
//
// renderAtom(parseAtom(s)) === s for EVERY variant + {…} key in the
// expression-formats.md atom-reference table. The table below IS that
// table, transcribed. Canonical view spacing (deterministic): gradient
// heads use ", " between args; all other heads use ","; {…} keys are
// ", "-separated. This makes the worked example round-trip exactly.

import { describe, expect, it } from 'bun:test'
import {
  parseAtom,
  renderAtom,
} from '@figma-agent-bridge/server/grammar'

const roundTrip = (s: string): string =>
  renderAtom(parseAtom(s))

// --- the atom-reference table (canonical view forms) ---
const TABLE: { group: string; atom: string }[] = [
  // Paints — solid (bare hex is canonical)
  { group: 'solid', atom: '#3B82F6' },
  { group: 'solid', atom: '#3B82F680' },
  // Paints — gradients (linear angle first; ", " separated)
  {
    group: 'linear',
    atom: 'linear(135, #FF0000@0, #00FF00@50, #0000FF@100)',
  },
  {
    group: 'radial',
    atom: 'radial(#FFFFFF@0, #00000000@100)',
  },
  {
    group: 'angular',
    atom: 'angular(#FF0000@0, #00FF00@33, #0000FF@66)',
  },
  {
    group: 'diamond',
    atom: 'diamond(#FF0000@0, #0000FF@100)',
  },
  // Paints — image / video / pattern
  { group: 'image', atom: 'image(HASH)' },
  { group: 'video', atom: 'video(HASH)' },
  { group: 'pattern', atom: 'pattern(componentId)' },
  // Paint {…} keys
  { group: 'paint op', atom: '#3B82F6{op=0.5}' },
  { group: 'paint blend', atom: '#3B82F6{blend=MULTIPLY}' },
  { group: 'paint vis', atom: '#3B82F6{vis=false}' },
  {
    group: 'gradient op',
    atom: 'linear(135, #3B82F6@0, #1D4ED8@100){op=0.08}',
  },
  {
    group: 'gradient tf',
    atom: 'radial(#FFFFFF@0, #000000@100){tf=[1,0,0,0,1,0]}',
  },
  // Image {…} keys
  { group: 'image scale', atom: 'image(HASH){scale=CROP}' },
  { group: 'image rot', atom: 'image(HASH){rot=90}' },
  { group: 'image tile', atom: 'image(HASH){tile=0.5}' },
  {
    group: 'image filter',
    atom: 'image(HASH){scale=FILL, rot=180}',
  },
  // Effects
  { group: 'shadow', atom: 'shadow(0,4,8,#00000040)' },
  {
    group: 'inner-shadow',
    atom: 'inner-shadow(0,2,4,#00000020)',
  },
  { group: 'blur', atom: 'blur(10)' },
  { group: 'bg-blur', atom: 'bg-blur(20)' },
  // Effect {…} keys
  {
    group: 'shadow spread',
    atom: 'shadow(0,4,12,#0000001A){spread=0}',
  },
  {
    group: 'shadow behind',
    atom: 'shadow(0,4,8,#00000040){behind=true}',
  },
  {
    group: 'shadow vis',
    atom: 'shadow(0,4,8,#00000040){vis=false}',
  },
  {
    group: 'shadow blend',
    atom: 'shadow(0,4,8,#00000040){blend=MULTIPLY}',
  },
  // Typography
  { group: 'font', atom: 'font(Inter,SemiBold,18)' },
  {
    group: 'font lh ls',
    atom: 'font(Inter,SemiBold,18){lh=24, ls=0.5}',
  },
  {
    group: 'font lh percent',
    atom: 'font(Inter,Regular,16){lh=150%}',
  },
  // Stroke geometry
  { group: 'stroke', atom: 'stroke(2)' },
  {
    group: 'stroke full',
    atom: 'stroke(2){align=INSIDE, cap=ROUND, join=MITER, miter=4, dash=[4,4]}',
  },
  { group: 'stroke per-side', atom: 'stroke([2,0,2,0])' },
  // Geometry literals & tuples
  { group: 'radius uniform', atom: '8' },
  { group: 'radius per-corner', atom: '[8,8,0,0]' },
  { group: 'sizing', atom: '[FILL,HUG]' },
  { group: 'constraints', atom: '[MIN,STRETCH]' },
  // Scalars & enums
  { group: 'scalar opacity', atom: '0.5' },
  { group: 'scalar rotation', atom: '45' },
  { group: 'enum blendMode', atom: 'MULTIPLY' },
  { group: 'bool', atom: 'true' },
  // Layout grids
  {
    group: 'grid columns',
    atom: 'columns(12,32,auto){align=STRETCH, offset=16, color=#FF000010}',
  },
  // Wrappers — style() / var() on any atom
  {
    group: 'style font',
    atom: 'style(Heading/H1)font(Inter,Bold,32)',
  },
  {
    group: 'style font lh',
    atom: 'style(Heading/H3)font(Inter,SemiBold,18){lh=24}',
  },
  { group: 'var radius', atom: 'var(radius/medium)8' },
  { group: 'var scalar', atom: 'var(token/x)0.5' },
  { group: 'var color', atom: 'var(color/blue)#3B82F6' },
  // I59 — a gradient's colours are per STOP, and so are its tokens. The
  // atom-level wrapper cannot say this: one wrapper on `linear(...)` claims a
  // single variable owns both ends of a two-colour banner.
  {
    group: 'var gradient stop',
    atom: 'linear(135, var(brand/violet)#7C3AED@0, var(brand/cyan)#22D3EE@100)',
  },
  {
    group: 'var gradient stop, one bound one not',
    atom: 'linear(90, var(brand/violet)#7C3AED@0, #FFFFFF@100)',
  },
  {
    group: 'var gradient stop on a radial',
    atom: 'radial(var(surface/glow)#FFFFFF@0, #00000000@100)',
  },
]

describe('round-trip: renderAtom(parseAtom(s)) === s', () => {
  for (const { group, atom } of TABLE) {
    it(`${group}: ${atom}`, () => {
      expect(roundTrip(atom)).toBe(atom)
    })
  }
})

describe('gradient angle + stop positions (hard requirement)', () => {
  it('positive linear angle round-trips', () => {
    const s = 'linear(135, #FF0000@0, #0000FF@100)'
    expect(roundTrip(s)).toBe(s)
  })

  it('negative linear angle round-trips', () => {
    const s = 'linear(-45, #FF0000@0, #0000FF@100)'
    expect(roundTrip(s)).toBe(s)
  })

  it('angle 0 round-trips', () => {
    const s = 'linear(0, #FF0000@0, #0000FF@100)'
    expect(roundTrip(s)).toBe(s)
  })

  it('non-zero stop percents preserved', () => {
    const s =
      'linear(90, #FF0000@0, #00FF00@33, #0000FF@66, #FFFFFF@100)'
    const ast = parseAtom(s)
    if (ast.kind !== 'head') {
      throw new Error('expected head')
    }
    const stops = ast.args.filter(a => a.kind === 'stop')
    expect(stops).toHaveLength(4)
    expect(roundTrip(s)).toBe(s)
  })
})

describe('worked-example node leaves all round-trip', () => {
  // Every atom leaf from the expression-formats.md worked example.
  const leaves = [
    'solid(#FFFFFF)', // note: write-sugar -> normalizes (see write-sugar test)
    'linear(135, #3B82F6@0, #1D4ED8@100){op=0.08}',
    'stroke(1){align=INSIDE}',
    '#E5E7EB',
    'shadow(0,4,12,#0000001A){spread=0}',
    '12',
    'style(Heading/H3)font(Inter,SemiBold,18){lh=24}',
    '#111827',
    'font(Inter,Regular,13)',
    '#6B7280',
  ]
  // solid(#FFFFFF) is write-sugar; the rest are canonical view forms.
  for (const leaf of leaves.slice(1)) {
    it(`leaf round-trips: ${leaf}`, () => {
      expect(roundTrip(leaf)).toBe(leaf)
    })
  }
})
