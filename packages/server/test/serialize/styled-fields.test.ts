// styled-fields.test.ts — a styled field is a reference, not a list (B47).
//
// The SHAPE half of the contract: which of the two write forms a value is, the
// legacy sugar that still reads as a reference, and the two mixes a slot cannot
// hold (rules 1 and 2). Rules 3 and 4 need the file's own styles and are tested
// in style-refs.test.ts.

import { describe, expect, it } from 'bun:test'
import {
  canonicalAtom,
  mixedStyleMessage,
  readStyledField,
  readStyledFields,
} from '@figma-agent-bridge/server/serialize/styled-fields'
import { specToFigma } from '@figma-agent-bridge/server/serialize/node-spec-writer'

const BLUR = 'bg-blur(24)'
const SHADOW = 'shadow(0,8,24,#00000066)'

// The canonical teaching message, spelled out once here so a change to it has
// to be a deliberate edit of the contract rather than a silent drift.
const EFFECTS_MESSAGE =
  'a style owns the whole effects list — use a style containing every effect ' +
  'you want, or write them all as literals (a style cannot be combined with ' +
  'literal siblings)'

describe('rejections — rule 1: a style beside literal siblings', () => {
  it('rejects the style-first order with the teaching message', () => {
    expect(() =>
      readStyledField('effects', [
        `style(AB/Blur)${BLUR}`,
        SHADOW,
      ]),
    ).toThrow(EFFECTS_MESSAGE)
  })

  it('rejects the literal-first order identically — neither order is the loophole', () => {
    expect(() =>
      readStyledField('effects', [
        SHADOW,
        `style(AB/Blur)${BLUR}`,
      ]),
    ).toThrow(EFFECTS_MESSAGE)
  })

  it('rejects the bare reference beside a literal', () => {
    expect(() =>
      readStyledField('effects', [
        'style(AB/Blur)',
        SHADOW,
      ]),
    ).toThrow(EFFECTS_MESSAGE)
  })

  it('rejects the read form beside a literal', () => {
    expect(() =>
      readStyledField('effects', [
        `style(AB/Blur)[${BLUR}]`,
        SHADOW,
      ]),
    ).toThrow(EFFECTS_MESSAGE)
  })

  it('names the field the write used — fills', () => {
    expect(() =>
      readStyledField('fills', [
        'style(Glass/Fill)#141B2E99',
        '#FFFFFF20',
      ]),
    ).toThrow(mixedStyleMessage('fills'))
    expect(mixedStyleMessage('fills')).toContain(
      'the whole fills list',
    )
    expect(mixedStyleMessage('fills')).toContain(
      'every fill you want',
    )
  })

  it('names the field the write used — strokes', () => {
    expect(() =>
      readStyledField('strokes', [
        'style(Border/Default)#000000',
        '#FFFFFF',
      ]),
    ).toThrow(mixedStyleMessage('strokes'))
  })

  it('names the field the write used — grids', () => {
    expect(() =>
      readStyledField('grids', [
        'style(Layout/12col)columns(12,0,24)',
        'grid(8)',
      ]),
    ).toThrow(mixedStyleMessage('grids'))
  })

  it('reaches the agent through the write face as INVALID_PARAM', () => {
    try {
      specToFigma({
        effects: [`style(AB/Blur)${BLUR}`, SHADOW],
      })
      throw new Error('expected the write to be rejected')
    } catch (err) {
      expect((err as { code?: string }).code).toBe(
        'INVALID_PARAM',
      )
      expect((err as Error).message).toBe(EFFECTS_MESSAGE)
    }
  })

  it('rejects BEFORE any atom is converted — a rejected write did nothing', () => {
    // The literal here is unparseable: if the converter ran first, the failure
    // would be its error, not the contract's.
    expect(() =>
      specToFigma({
        effects: ['style(AB/Blur)', 'not-an-effect(('],
      }),
    ).toThrow(EFFECTS_MESSAGE)
  })
})

describe('rejections — rule 2: two DIFFERENT style names in one field', () => {
  it('rejects two different style names in one field', () => {
    expect(() =>
      readStyledField('effects', [
        `style(AB/Blur)${BLUR}`,
        `style(AB/Lift)${SHADOW}`,
      ]),
    ).toThrow(EFFECTS_MESSAGE)
  })

  it('rejects them in the other order too — neither is the loophole', () => {
    expect(() =>
      readStyledField('effects', [
        `style(AB/Lift)${SHADOW}`,
        `style(AB/Blur)${BLUR}`,
      ]),
    ).toThrow(EFFECTS_MESSAGE)
  })

  it('rejects a third name among same-name entries', () => {
    expect(() =>
      readStyledField('fills', [
        'style(A)#FF0000',
        'style(A)#00FF00',
        'style(B)#0000FF',
      ]),
    ).toThrow(mixedStyleMessage('fills'))
  })

  it('rejects two styles even when a literal rides along too', () => {
    expect(() =>
      readStyledField('fills', [
        'style(A)#FF0000',
        'style(B)#00FF00',
        '#0000FF',
      ]),
    ).toThrow(mixedStyleMessage('fills'))
  })

  it('rejects the CROSS-FIELD spelling: fills and text.color are ONE slot', () => {
    expect(() =>
      readStyledFields({
        fills: 'style(Glass/Fill)[#141B2E99]',
        text: {
          content: 'Hi',
          color: 'style(Brand/Primary)#3B82F6',
        },
      }),
    ).toThrow(mixedStyleMessage('fills'))
  })

  it('accepts the same style named on both — one slot, one owner', () => {
    expect(() =>
      readStyledFields({
        fills: 'style(Brand/Primary)[#3B82F6]',
        text: {
          content: 'Hi',
          color: 'style(Brand/Primary)#3B82F6',
        },
      }),
    ).not.toThrow()
  })

  it('leaves the scalar text.font slot alone — a text style is not an array field', () => {
    expect(() =>
      readStyledFields({
        text: {
          content: 'Hi',
          font: 'style(Heading/H1)font(Inter,Bold,32)',
          color: 'style(Brand/Primary)#3B82F6',
        },
      }),
    ).not.toThrow()
  })
})

describe('the legal forms', () => {
  it('the scalar reference, bare', () => {
    expect(
      readStyledField('effects', 'style(AB/Blur)'),
    ).toEqual({
      kind: 'reference',
      name: 'AB/Blur',
      rideAlong: [],
    })
  })

  it('the scalar reference with its resolved list — what a read emits', () => {
    expect(
      readStyledField(
        'effects',
        `style(AB/Blur)[${BLUR}, ${SHADOW}]`,
      ),
    ).toEqual({
      kind: 'reference',
      name: 'AB/Blur',
      rideAlong: [BLUR, SHADOW],
    })
  })

  it('the legacy lone-atom sugar — a one-entry array whose entry is a style', () => {
    expect(
      readStyledField('effects', [`style(AB/Blur)${BLUR}`]),
    ).toEqual({
      kind: 'reference',
      name: 'AB/Blur',
      rideAlong: [BLUR],
    })
  })

  it('the legacy bare style in a one-entry array', () => {
    expect(
      readStyledField('effects', ['style(AB/Blur)']),
    ).toEqual({
      kind: 'reference',
      name: 'AB/Blur',
      rideAlong: [],
    })
  })

  it('the read form array-wrapped out of habit', () => {
    expect(
      readStyledField('effects', [
        `style(AB/Blur)[${BLUR}]`,
      ]),
    ).toEqual({
      kind: 'reference',
      name: 'AB/Blur',
      rideAlong: [BLUR],
    })
  })

  // The 0.4.0 reader wrapped EVERY entry of a multi-value style, so this is the
  // shape the bridge itself used to emit. N copies of one name state ONE owner,
  // which is exactly what the slot has room for — so it normalises to the
  // reference, entries riding in order.
  it('the MULTI-ENTRY legacy read form — every entry wrapped by the same style', () => {
    expect(
      readStyledField('effects', [
        `style(AB/Blur)${BLUR}`,
        `style(AB/Blur)${SHADOW}`,
      ]),
    ).toEqual({
      kind: 'reference',
      name: 'AB/Blur',
      rideAlong: [BLUR, SHADOW],
    })
  })

  it('the multi-entry form on fills, three entries, order preserved', () => {
    expect(
      readStyledField('fills', [
        'style(Glass/Fill)#FF00AA',
        'style(Glass/Fill)#00000080',
        'style(Glass/Fill)#FFFFFF20',
      ]),
    ).toEqual({
      kind: 'reference',
      name: 'Glass/Fill',
      rideAlong: ['#FF00AA', '#00000080', '#FFFFFF20'],
    })
  })

  // REGRESSION: this input used to be rejected, and with a message that
  // misdiagnosed it — there are no literal siblings to combine with, and
  // "use a style containing every fill you want" is advice the write already
  // followed. It must not come back.
  it('the legacy multi-entry read-back no longer produces the literal-siblings message', () => {
    const legacy = [
      'style(Glass/Fill)#FF00AA',
      'style(Glass/Fill)#00000080',
    ]
    expect(() =>
      readStyledField('fills', legacy),
    ).not.toThrow()
    expect(() =>
      specToFigma({ fills: legacy }),
    ).not.toThrow(mixedStyleMessage('fills'))
    // …and it writes NO literals: the style owns the field, as the reference
    // form always has.
    expect('fills' in specToFigma({ fills: legacy })).toBe(
      false,
    )
    expect(specToFigma({ fills: legacy }).bindings).toEqual(
      [
        {
          kind: 'style',
          name: 'Glass/Fill',
          field: 'fill',
          owns: true,
          rideAlong: ['#FF00AA', '#00000080'],
        },
      ],
    )
  })

  it('a multi-entry form whose entries are all BARE references is one reference', () => {
    expect(
      readStyledField('effects', [
        'style(AB/Blur)',
        'style(AB/Blur)',
      ]),
    ).toEqual({
      kind: 'reference',
      name: 'AB/Blur',
      rideAlong: [],
    })
  })

  it('rule 1 still bites: same-name entries plus ONE literal is a mix', () => {
    expect(() =>
      readStyledField('fills', [
        'style(Glass/Fill)#FF00AA',
        'style(Glass/Fill)#00000080',
        '#FFFFFF',
      ]),
    ).toThrow(mixedStyleMessage('fills'))
  })

  it('a literal array is a list of literals, untouched', () => {
    expect(
      readStyledField('effects', [BLUR, SHADOW]),
    ).toEqual({
      kind: 'literals',
      atoms: [BLUR, SHADOW],
    })
  })

  it('a var() wrapper inside a literal array is entry-level and changes nothing', () => {
    expect(
      readStyledField('fills', [
        'var(surface/2)#141B2E',
        '#FFFFFF20',
      ]),
    ).toEqual({
      kind: 'literals',
      atoms: ['var(surface/2)#141B2E', '#FFFFFF20'],
    })
  })

  it('the empty array stays the empty array — "deliberately unpainted"', () => {
    expect(readStyledField('fills', [])).toEqual({
      kind: 'literals',
      atoms: [],
    })
    expect(specToFigma({ fills: [] }).fills).toEqual([])
  })

  it('a scalar that names no style is one literal atom', () => {
    expect(readStyledField('fills', '#FF0000')).toEqual({
      kind: 'literals',
      atoms: ['#FF0000'],
    })
  })

  it('a style NAME containing brackets survives the split', () => {
    expect(
      readStyledField(
        'fills',
        'style(Brand (2024)/Primary)[#FF0000]',
      ),
    ).toEqual({
      kind: 'reference',
      name: 'Brand (2024)/Primary',
      rideAlong: ['#FF0000'],
    })
  })
})

describe('canonical atoms — the differ comparison basis', () => {
  it('two spellings of one paint compare equal', () => {
    expect(canonicalAtom('fill', 'rgba(255,0,0,1)')).toBe(
      canonicalAtom('fill', '#FF0000'),
    )
  })

  it('an effect round-trips to its canonical rendering', () => {
    expect(canonicalAtom('effect', 'bg-blur(24)')).toBe(
      'bg-blur(24)',
    )
  })

  it('an atom the grammar cannot read is compared as written, never invented', () => {
    expect(canonicalAtom('effect', 'not-an-effect')).toBe(
      'not-an-effect',
    )
  })
})
