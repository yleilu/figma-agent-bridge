// variable-shadowing.test.ts — B66: a variable name is scoped to its
// collection, this surface binds by name, and neither half used to say so.

import { describe, expect, it } from 'bun:test'
import {
  bindMismatchWarning,
  createShadowWarning,
  holdsValue,
  otherCollectionsHolding,
  statedFromPaint,
  statedFromScalar,
  type StatedValue,
} from './variable-shadowing'

const CYAN: StatedValue = {
  kind: 'color',
  rgba: [0.133, 0.827, 0.933, 1],
}

describe('holdsValue', () => {
  it('matches a colour the variable holds in one of its modes', () => {
    expect(
      holdsValue(
        {
          valuesByMode: {
            light: { r: 1, g: 0, b: 0, a: 1 },
            dark: { r: 0.133, g: 0.827, b: 0.933, a: 1 },
          },
        },
        CYAN,
      ),
    ).toBe('match')
  })

  it('reports a colour no mode holds', () => {
    expect(
      holdsValue(
        {
          valuesByMode: {
            light: { r: 1, g: 0, b: 0, a: 1 },
          },
        },
        CYAN,
      ),
    ).toBe('differs')
  })

  it('absorbs 8-bit rounding — a hex round trip is not a mismatch', () => {
    // #22D3EE is 34/255, 211/255, 238/255. The atom states the rounded hex and
    // Figma stores the float, so an exact compare would accuse every faithful
    // write.
    expect(
      holdsValue(
        {
          valuesByMode: {
            m: {
              r: 34 / 255,
              g: 211 / 255,
              b: 238 / 255,
              a: 1,
            },
          },
        },
        CYAN,
      ),
    ).toBe('match')
  })

  it('counts alpha — the same rgb at another opacity is a different value', () => {
    expect(
      holdsValue(
        {
          valuesByMode: {
            m: { r: 0.133, g: 0.827, b: 0.933, a: 0.2 },
          },
        },
        CYAN,
      ),
    ).toBe('differs')
  })

  it('says UNKNOWN for an alias mode — no evidence is not evidence of a mismatch', () => {
    expect(
      holdsValue(
        {
          valuesByMode: {
            m: {
              type: 'VARIABLE_ALIAS',
              id: 'VariableID:9',
            },
          },
        },
        CYAN,
      ),
    ).toBe('unknown')
  })

  it('says UNKNOWN for a variable this runtime does not expose values for', () => {
    expect(holdsValue({}, CYAN)).toBe('unknown')
    expect(holdsValue({ valuesByMode: {} }, CYAN)).toBe(
      'unknown',
    )
  })

  it('compares a number the same way', () => {
    const eight: StatedValue = { kind: 'number', value: 8 }
    expect(
      holdsValue({ valuesByMode: { m: 8 } }, eight),
    ).toBe('match')
    expect(
      holdsValue({ valuesByMode: { m: 16 } }, eight),
    ).toBe('differs')
    expect(
      holdsValue({ valuesByMode: { m: 'eight' } }, eight),
    ).toBe('unknown')
  })
})

describe('statedFromPaint / statedFromScalar', () => {
  it('reads a SOLID paint as its rgba, opacity included', () => {
    expect(
      statedFromPaint({
        type: 'SOLID',
        color: { r: 0.133, g: 0.827, b: 0.933 },
        opacity: 0.2,
      }),
    ).toEqual({
      kind: 'color',
      rgba: [0.133, 0.827, 0.933, 0.2],
    })
  })

  it('defaults a paint with no opacity to fully opaque', () => {
    expect(
      statedFromPaint({
        type: 'SOLID',
        color: { r: 0, g: 0, b: 0 },
      }),
    ).toEqual({ kind: 'color', rgba: [0, 0, 0, 1] })
  })

  it('has nothing to say about a gradient or a missing paint', () => {
    expect(
      statedFromPaint({ type: 'GRADIENT_LINEAR' }),
    ).toBeUndefined()
    expect(statedFromPaint(undefined)).toBeUndefined()
  })

  it('reads a scalar field only when it is a number', () => {
    expect(statedFromScalar(8)).toEqual({
      kind: 'number',
      value: 8,
    })
    expect(statedFromScalar('8')).toBeUndefined()
  })
})

describe('otherCollectionsHolding', () => {
  const variables = [
    {
      name: 'brand/primary',
      variableCollectionId: 'VC:1',
    },
    {
      name: 'brand/primary',
      variableCollectionId: 'VC:2',
    },
    { name: 'space/8', variableCollectionId: 'VC:2' },
  ]
  const names = { 'VC:1': 'Brand', 'VC:2': 'Legacy' }

  it('names every OTHER collection holding the name', () => {
    expect(
      otherCollectionsHolding(
        'brand/primary',
        variables,
        names,
        'VC:1',
      ),
    ).toEqual(['Legacy'])
  })

  it('names them all when nothing is excluded', () => {
    expect(
      otherCollectionsHolding(
        'brand/primary',
        variables,
        names,
      ),
    ).toEqual(['Brand', 'Legacy'])
  })

  it('is empty for a name only one collection holds', () => {
    expect(
      otherCollectionsHolding(
        'space/8',
        variables,
        names,
        'VC:2',
      ),
    ).toEqual([])
  })

  it('falls back to the id for a collection it cannot name', () => {
    expect(
      otherCollectionsHolding(
        'brand/primary',
        variables,
        {},
        'VC:1',
      ),
    ).toEqual(['VC:2'])
  })
})

describe('the two warnings', () => {
  it('the create warning names both collections and the remedy', () => {
    const message = createShadowWarning(
      'brand/primary',
      'Brand',
      ['Legacy'],
    )
    expect(message).toContain('"brand/primary"')
    expect(message).toContain('"Brand"')
    expect(message).toContain('"Legacy"')
    expect(message).toContain('bind_variable')
  })

  it('the bind warning names the shadow when there is one', () => {
    const message = bindMismatchWarning('brand/primary', [
      'Legacy',
    ])
    expect(message).toContain('var(brand/primary)')
    expect(message).toContain('"Legacy"')
    expect(message).toContain('bind_variable')
  })

  it('the bind warning still reports a mismatch with no shadow to blame', () => {
    const message = bindMismatchWarning('brand/primary', [])
    expect(message).toContain('The binding wins')
    expect(message).not.toContain('also defined in')
  })
})
