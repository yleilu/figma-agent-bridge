// write-sugar.test.ts — the write parser accepts forms the view never
// emits (rgb()/rgba(), solid(), image(url), inner-arg {…}); the renderer
// normalizes them to the canonical (lossy) view face. var() resolves to its
// literal — the binding rides on bindings[].

import { describe, expect, it } from 'bun:test'
import {
  parseAtom,
  renderAtom,
  atomToPaint,
} from '@figma-agent-bridge/server/grammar'

const normalize = (s: string): string =>
  renderAtom(parseAtom(s))

describe('solid() sugar normalizes to bare hex', () => {
  it('solid(#3B82F6) -> #3B82F6', () => {
    expect(normalize('solid(#3B82F6)')).toBe('#3B82F6')
  })
  it('solid(#FFFFFF) -> #FFFFFF', () => {
    expect(normalize('solid(#FFFFFF)')).toBe('#FFFFFF')
  })
})

describe('rgb()/rgba() sugar normalizes to hex', () => {
  it('rgb(0,0,0) -> #000000', () => {
    expect(normalize('rgb(0,0,0)')).toBe('#000000')
  })
  it('rgb(59,130,246) -> #3B82F6', () => {
    expect(normalize('rgb(59,130,246)')).toBe('#3B82F6')
  })
  it('rgba(59,130,246,0.5) -> #3B82F680', () => {
    expect(normalize('rgba(59,130,246,0.5)')).toBe(
      '#3B82F680',
    )
  })
  it('solid(rgb(0,0,0)) -> #000000', () => {
    expect(normalize('solid(rgb(0,0,0))')).toBe('#000000')
  })
})

describe('rgb()/rgba() produce the same paint as hex', () => {
  it('rgba(59,130,246,0.5) === #3B82F680 as a paint', () => {
    expect(atomToPaint('rgba(59,130,246,0.5)')).toEqual(
      atomToPaint('#3B82F680'),
    )
  })
  it('rgb(255,0,0) === #FF0000 as a paint', () => {
    expect(atomToPaint('rgb(255,0,0)')).toEqual(
      atomToPaint('#FF0000'),
    )
  })
})

describe('image(url) is write-only sugar', () => {
  it('parses a url into a write-only imageUrl (hash null)', () => {
    const p = atomToPaint('image(https://x.com/a.png)')
    if (p.type !== 'IMAGE') {
      throw new Error('expected image')
    }
    expect(p.imageUrl).toBe('https://x.com/a.png')
    expect(p.imageHash).toBeNull()
  })
  it('a bare token is treated as a hash, not a url', () => {
    const p = atomToPaint('image(HASH)')
    if (p.type !== 'IMAGE') {
      throw new Error('expected image')
    }
    expect(p.imageHash).toBe('HASH')
    expect(p.imageUrl).toBeUndefined()
  })
})

describe('inner-arg {…} normalizes to the trailing channel', () => {
  it('font(Inter,SemiBold,18,{lh=24,ls=0.5}) -> trailing', () => {
    expect(
      normalize('font(Inter,SemiBold,18,{lh=24,ls=0.5})'),
    ).toBe('font(Inter,SemiBold,18){lh=24, ls=0.5}')
  })
  it('stroke(2,{align=INSIDE}) -> trailing', () => {
    expect(normalize('stroke(2,{align=INSIDE})')).toBe(
      'stroke(2){align=INSIDE}',
    )
  })
  it('inner and trailing both supplied merge (trailing wins)', () => {
    // Same key in both -> trailing overrides inner.
    expect(
      normalize('font(Inter,Bold,16,{lh=20}){lh=24}'),
    ).toBe('font(Inter,Bold,16){lh=24}')
  })
})

describe('whitespace tolerance on parse', () => {
  it('spaces after commas in a non-gradient head parse the same', () => {
    expect(normalize('shadow(0, 4, 8, #00000040)')).toBe(
      'shadow(0,4,8,#00000040)',
    )
  })
  it('no-space gradient still parses, renders canonical spacing', () => {
    expect(
      normalize('linear(135,#FF0000@0,#0000FF@100)'),
    ).toBe('linear(135, #FF0000@0, #0000FF@100)')
  })
})

describe('var() resolves to its literal — the binding rides on bindings[]', () => {
  it('atomToPaint drops the var() wrapper to the resolved literal', () => {
    expect(atomToPaint('var(color/blue)#3B82F6')).toEqual(
      atomToPaint('#3B82F6'),
    )
  })
})
