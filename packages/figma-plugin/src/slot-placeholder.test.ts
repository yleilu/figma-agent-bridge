// slot-placeholder.test.ts — B92: an empty SLOT must not dictate its master's
// resting size.
//
// THE FAKE MODELS FIGMA'S SETTER, and it has to. `layoutSizingVertical = 'HUG'`
// is not a field write: Figma RESIZES the node on assignment, to its content —
// and an empty slot has no content, so it collapses. A plain-object fake would
// store the string and leave `height` at 100, which is exactly the reading that
// hid this bug: the sizing looked set and the box never moved.
//
// THE LIVE MEASUREMENT (2026-09-02b, re-measured 2026-09-03). `createSlot()`
// births a slot 100×100 FIXED. Across 26 empty slots on one dashboard EVERY ONE
// read 100px tall — never a floor value — and the consequences were both real:
// 14 `Chart card` headers inflated ~72px on delivered screens, and the `Top bar`
// COMPONENT master (1200×64) carried its empty `Trailing` slot at
// `pos [1076,-18.5] size [100,100]`, overflowing its own FIXED-64 box by 18.5px
// top and bottom. The next round measured 22 of 26 slots at the placeholder,
// SIX masters overflowing their own box, and 16 more whose published resting
// height read exactly 100 — a tool artifact reported as those masters' geometry.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  SLOT_PLACEHOLDER_BOX,
  emptySlotSizing,
  placeholderHugMessage,
} from './slot-placeholder'

/**
 * A SLOT as `createSlot()` hands it over: 100×100, FIXED on both axes, and
 * with setters that resize the way Figma's do.
 *
 * `content` is what the slot holds. HUG collapses to it, which is the whole
 * behaviour under test — an empty slot hugs to nothing.
 */
const figmaSlot = (content: [number, number] = [0, 0]) => {
  const node = {
    type: 'SLOT',
    name: 'Trailing',
    width: SLOT_PLACEHOLDER_BOX[0],
    height: SLOT_PLACEHOLDER_BOX[1],
    layoutMode: 'VERTICAL',
    hStored: 'FIXED',
    vStored: 'FIXED',
  }
  Object.defineProperty(node, 'layoutSizingHorizontal', {
    configurable: true,
    enumerable: true,
    get: () => node.hStored,
    set: (v: string) => {
      node.hStored = v
      if (v === 'HUG') node.width = content[0]
    },
  })
  Object.defineProperty(node, 'layoutSizingVertical', {
    configurable: true,
    enumerable: true,
    get: () => node.vStored,
    set: (v: string) => {
      node.vStored = v
      if (v === 'HUG') node.height = content[1]
    },
  })
  return node
}

describe('B92 — what an unstated slot asks for', () => {
  it('hugs when the entry states neither a size nor a sizing', () => {
    expect(emptySlotSizing({ name: 'Trailing' })).toEqual([
      'HUG',
      'HUG',
    ])
  })

  it('hugs a BARE NAME too — one entry cannot mean two things by how it is spelled', () => {
    expect(emptySlotSizing(undefined)).toEqual([
      'HUG',
      'HUG',
    ])
  })

  it('leaves a STATED size alone — the author asked for a box and gets one', () => {
    expect(
      emptySlotSizing({ name: 'Body', size: [240, 56] }),
    ).toBeUndefined()
  })

  it('leaves a STATED sizing alone, FILL included', () => {
    expect(
      emptySlotSizing({
        name: 'Body',
        sizing: ['FILL', 'HUG'],
      }),
    ).toBeUndefined()
    expect(
      emptySlotSizing({
        name: 'Body',
        sizing: ['FIXED', 'FIXED'],
      }),
    ).toBeUndefined()
  })
})

describe("B92 — what it does to Figma's own placeholder", () => {
  it('collapses the 100×100 birth box of an EMPTY slot', () => {
    const slot = figmaSlot()
    expect(slot.height).toBe(100)
    const sizing = emptySlotSizing({ name: 'Trailing' })
    const [h, v] = sizing as ['HUG', 'HUG']
    slot.layoutSizingHorizontal = h
    slot.layoutSizingVertical = v
    // The 18.5px that pushed `Top bar` out of its own FIXED-64 box is gone,
    // and so is the ~72px band above 14 chart-card headers.
    expect(slot.height).toBe(0)
    expect(slot.width).toBe(0)
  })

  it('still grows to the content a FILLED slot holds — hug is not zero', () => {
    const slot = figmaSlot([98, 20])
    slot.layoutSizingHorizontal = 'HUG'
    slot.layoutSizingVertical = 'HUG'
    // The same slot measured 98×20 in every instance on the live artifact.
    expect([slot.width, slot.height]).toEqual([98, 20])
  })
})

describe('B92 — what the reply says', () => {
  it('declares the choice ONCE, naming every slot it applied to (T4)', () => {
    const message = placeholderHugMessage([
      'Trailing',
      'Menu',
      'Body',
    ])
    expect(message).toContain('Trailing, Menu, Body')
    expect(message).toContain('100')
    expect(message).toContain('size')
    // One line, not one per slot.
    expect(message.split('\n')).toHaveLength(1)
  })
})

// `code.ts` cannot be imported outside Figma, so the call site is checked by
// source scan — the shape `apply-wiring.test.ts` established, with its own
// liveness assertion so an empty scan cannot look like a pass.
describe('B92 — update_component actually applies it', () => {
  const src = readFileSync(
    join(import.meta.dir, 'code.ts'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('read the file (liveness)', () => {
    expect(src).toContain('compWithSlot.createSlot')
  })

  it('asks the decider, and declares it once on the reply', () => {
    expect(src).toContain('emptySlotSizing(')
    expect(src).toContain('placeholderHugMessage(')
  })
})
