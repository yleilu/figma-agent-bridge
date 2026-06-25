// tokenize.test.ts — the atom splitter: wrapper + value + {…} attrs,
// balanced-paren/bracket aware; rejects unbalanced input.

import { describe, expect, it } from 'bun:test'
import {
  tokenize,
  splitTopLevel,
  parseAttrs,
} from '@figma-agent-bridge/server/grammar/tokenize'
import { parseAtom } from '@figma-agent-bridge/server/grammar'

describe('tokenize: wrapper extraction', () => {
  it('extracts style(Name) and leaves the value', () => {
    const t = tokenize(
      'style(Heading/H1)font(Inter,Bold,32)',
    )
    expect(t.wrapper).toEqual({
      kind: 'style',
      name: 'Heading/H1',
    })
    expect(t.body).toBe('font(Inter,Bold,32)')
  })
  it('extracts var(Name) on a bare literal', () => {
    const t = tokenize('var(radius/medium)8')
    expect(t.wrapper).toEqual({
      kind: 'var',
      name: 'radius/medium',
    })
    expect(t.body).toBe('8')
  })
  it('does NOT treat a head named like solid() as a wrapper', () => {
    const t = tokenize('solid(#FFFFFF)')
    expect(t.wrapper).toBeUndefined()
    expect(t.body).toBe('solid(#FFFFFF)')
  })
})

describe('tokenize: {…} attr channel', () => {
  it('splits a trailing {…} from the value', () => {
    const t = tokenize('#3B82F6{op=0.5}')
    expect(t.body).toBe('#3B82F6')
    expect(t.attrs).toEqual({ op: 0.5 })
  })
  it('handles nested {tf=[...]} arrays in attrs', () => {
    const t = tokenize(
      'radial(#FFF000@0){tf=[1,0,0,0,1,0]}',
    )
    expect(t.body).toBe('radial(#FFF000@0)')
    expect(t.attrs).toEqual({ tf: [1, 0, 0, 0, 1, 0] })
  })
  it('leaves an inner-arg {…} inside the head body', () => {
    // A {…} inside the parens is NOT the trailing channel.
    const t = tokenize('font(Inter,Bold,18,{lh=24})')
    expect(t.body).toBe('font(Inter,Bold,18,{lh=24})')
    expect(t.attrs).toBeUndefined()
  })
})

describe('balance (rejection at the parse layer)', () => {
  it('rejects an unbalanced paren inside a head', () => {
    // tokenize defers head-paren validation to parseAtom (matchClose).
    expect(() =>
      parseAtom('linear(135, #FF0000@0'),
    ).toThrow()
  })
  it('rejects an unbalanced bracket', () => {
    expect(() => parseAtom('[8,8,0,0')).toThrow()
  })
  it('tokenize rejects an empty atom', () => {
    expect(() => tokenize('')).toThrow()
  })
  it('tokenize rejects a wrapper with no value', () => {
    expect(() => tokenize('var(x/y)')).toThrow()
  })
})

describe('splitTopLevel', () => {
  it('splits at top-level commas only', () => {
    expect(splitTopLevel('a,b,c')).toEqual(['a', 'b', 'c'])
  })
  it('ignores commas nested in brackets', () => {
    expect(splitTopLevel('a,[1,2],c')).toEqual([
      'a',
      '[1,2]',
      'c',
    ])
  })
  it('ignores commas nested in parens', () => {
    expect(splitTopLevel('a,f(1,2),c')).toEqual([
      'a',
      'f(1,2)',
      'c',
    ])
  })
  it('trims whitespace around segments', () => {
    expect(splitTopLevel('a, b , c')).toEqual([
      'a',
      'b',
      'c',
    ])
  })
})

describe('parseAttrs', () => {
  it('parses typed values (number/bool/string/array)', () => {
    expect(
      parseAttrs(
        'op=0.5, vis=false, align=INSIDE, dash=[4,4]',
      ),
    ).toEqual({
      op: 0.5,
      vis: false,
      align: 'INSIDE',
      dash: [4, 4],
    })
  })
  it('throws on an attr missing "="', () => {
    expect(() => parseAttrs('opacity')).toThrow()
  })
})
