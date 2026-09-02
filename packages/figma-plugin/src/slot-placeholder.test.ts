// slot-placeholder.test.ts — B92: an empty SLOT must not dictate its master's
// resting size.
//
// THE FIRST FAKE WAS WRONG, AND THE LIVE RUN CAUGHT IT. It modelled HUG as
// "collapse to the content", so an empty slot went to zero and the test passed
// while the tool changed nothing. Figma's actual rule, measured on the hot
// build (2026-09-03): **HUG on an EMPTY auto-layout frame keeps the box it
// already has.** There is no content to hug to, so the current size stands.
// `update_component({slots:[{name:'Trailing'}]})` on a V master 240 wide left
// `Trailing` at `sizing HUG,HUG` and `size [100,100]`, and the master still
// grew 120 → 188.
//
// THE PROVEN REMEDY, run by hand on the same master: write `size [0.01,0.01]`
// FIRST — which pins the slot FIXED and takes the master to 88.01 — and write
// `sizing HUG,HUG` SECOND, where it wins over the pin. After a 120×32 filler
// was appended the slot read `[120,32] HUG,HUG` and the master read 120. So
// ORDER IS THE FIX: a tiny resting box, then the hug.
//
// THE LIVE MEASUREMENT THIS EXISTS FOR (2026-09-02b, re-measured 2026-09-03).
// `createSlot()` births a slot 100×100 FIXED. Across 26 empty slots on one
// dashboard EVERY ONE read 100px tall — never a floor value — and the
// consequences were both real: 14 `Chart card` headers inflated ~72px on
// delivered screens, and the `Top bar` COMPONENT master (1200×64) carried its
// empty `Trailing` slot at `pos [1076,-18.5] size [100,100]`, overflowing its
// own FIXED-64 box by 18.5px top and bottom. The next round measured 22 of 26
// slots at the placeholder, SIX masters overflowing their own box, and 16 more
// whose published resting height read exactly 100 — a tool artifact reported as
// those masters' geometry.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  SLOT_PLACEHOLDER_BOX,
  SLOT_RESTING_BOX,
  emptySlotPlan,
  placeholderHugMessage,
} from './slot-placeholder'

/**
 * A SLOT as `createSlot()` hands it over: 100×100, FIXED on both axes, with
 * setters that behave the way Figma's do.
 *
 *   `resize(w,h)`            pins the axis FIXED, the way Figma's does.
 *   `layoutSizing* = 'HUG'`  hugs the CONTENT — and an EMPTY frame has none,
 *                            so it keeps the box it already has. That is the
 *                            rule the first fake got backwards.
 *
 * `fill` appends content, so the same node can be measured empty and filled.
 */
const figmaSlot = () => {
  const node = {
    type: 'SLOT',
    name: 'Trailing',
    width: SLOT_PLACEHOLDER_BOX[0],
    height: SLOT_PLACEHOLDER_BOX[1],
    layoutMode: 'VERTICAL',
    hStored: 'FIXED',
    vStored: 'FIXED',
    /** The content box, or undefined while the slot is empty. */
    content: undefined as [number, number] | undefined,
    resize(w: number, h: number) {
      node.width = w
      node.height = h
      // Figma pins the axis it was told to size.
      node.hStored = 'FIXED'
      node.vStored = 'FIXED'
    },
    fill(box: [number, number]) {
      node.content = box
      // A hugging axis re-measures the moment content arrives.
      if (node.hStored === 'HUG') node.width = box[0]
      if (node.vStored === 'HUG') node.height = box[1]
    },
  }
  Object.defineProperty(node, 'layoutSizingHorizontal', {
    configurable: true,
    enumerable: true,
    get: () => node.hStored,
    set: (v: string) => {
      node.hStored = v
      // EMPTY: nothing to hug to, so the box stands. This is Figma's rule and
      // it is why HUG alone changed nothing on the live master.
      if (v === 'HUG' && node.content !== undefined) {
        node.width = node.content[0]
      }
    },
  })
  Object.defineProperty(node, 'layoutSizingVertical', {
    configurable: true,
    enumerable: true,
    get: () => node.vStored,
    set: (v: string) => {
      node.vStored = v
      if (v === 'HUG' && node.content !== undefined) {
        node.height = node.content[1]
      }
    },
  })
  return node
}

describe('B92 — the rule the first fix got wrong', () => {
  it('HUG ALONE changes nothing on an empty slot — the live-wrong behaviour', () => {
    const slot = figmaSlot()
    slot.layoutSizingHorizontal = 'HUG'
    slot.layoutSizingVertical = 'HUG'
    expect(slot.layoutSizingVertical).toBe('HUG')
    // sizing says HUG and the box never moved: exactly what the hot build read
    // back, and what let the master grow 120 → 188 anyway.
    expect([slot.width, slot.height]).toEqual([100, 100])
  })
})

describe('B92 — what an unstated slot asks for', () => {
  it('plans a tiny resting box AND a hug, in that order', () => {
    expect(emptySlotPlan({ name: 'Trailing' })).toEqual({
      size: SLOT_RESTING_BOX,
      sizing: ['HUG', 'HUG'],
    })
  })

  it('plans the same for a BARE NAME — one entry cannot mean two things', () => {
    expect(emptySlotPlan(undefined)).toEqual({
      size: SLOT_RESTING_BOX,
      sizing: ['HUG', 'HUG'],
    })
  })

  it('leaves a STATED size alone — the author asked for a box and gets one', () => {
    expect(
      emptySlotPlan({ name: 'Body', size: [240, 56] }),
    ).toBeUndefined()
  })

  it('leaves a STATED sizing alone, FILL included', () => {
    expect(
      emptySlotPlan({
        name: 'Body',
        sizing: ['FILL', 'HUG'],
      }),
    ).toBeUndefined()
    expect(
      emptySlotPlan({
        name: 'Body',
        sizing: ['FIXED', 'FIXED'],
      }),
    ).toBeUndefined()
  })
})

describe('B92 — the plan against Figma’s own placeholder', () => {
  it('SIZE FIRST then HUG takes the empty slot off its 100×100 box', () => {
    const slot = figmaSlot()
    const plan = emptySlotPlan({ name: 'Trailing' })
    const { size, sizing } = plan as {
      size: [number, number]
      sizing: ['HUG', 'HUG']
    }
    slot.resize(size[0], size[1])
    slot.layoutSizingHorizontal = sizing[0]
    slot.layoutSizingVertical = sizing[1]
    // The 18.5px that pushed `Top bar` out of its own FIXED-64 box, and the
    // ~72px band above 14 chart-card headers, are both gone.
    expect([slot.width, slot.height]).toEqual([0.01, 0.01])
    expect(slot.layoutSizingVertical).toBe('HUG')
  })

  it('HUG BEFORE SIZE does not work — the order IS the fix', () => {
    const slot = figmaSlot()
    slot.layoutSizingHorizontal = 'HUG'
    slot.layoutSizingVertical = 'HUG'
    slot.resize(0.01, 0.01)
    // resize pins FIXED, so a hug written first is simply lost.
    expect(slot.layoutSizingVertical).toBe('FIXED')
  })

  it('still grows to its content once the slot is filled', () => {
    const slot = figmaSlot()
    slot.resize(...SLOT_RESTING_BOX)
    slot.layoutSizingHorizontal = 'HUG'
    slot.layoutSizingVertical = 'HUG'
    slot.fill([120, 32])
    // The hand-run measurement on the live master, to the pixel.
    expect([slot.width, slot.height]).toEqual([120, 32])
    expect(slot.layoutSizingVertical).toBe('HUG')
  })
})

describe('B92 — what the reply says', () => {
  it('says what was DONE, once, naming every slot (T4)', () => {
    const message = placeholderHugMessage([
      'Trailing',
      'Menu',
      'Body',
    ])
    expect(message).toContain('Trailing, Menu, Body')
    expect(message).toContain('0.01')
    expect(message).toContain('hug once filled')
    expect(message).toContain('100')
    expect(message.split('\n')).toHaveLength(1)
  })
})

// `code.ts` cannot be imported outside Figma, so the call site is checked by
// source scan — the shape `apply-wiring.test.ts` established, with its own
// liveness assertion so an empty scan cannot look like a pass.
describe('B92 — update_component applies the plan IN ORDER', () => {
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
    expect(src).toContain('emptySlotPlan(')
    expect(src).toContain('placeholderHugMessage(')
  })

  it('writes the resting SIZE before the SIZING', () => {
    const arm = src.slice(src.indexOf('emptySlotPlan('))
    const theSize = arm.indexOf('slotPlan.size')
    const theSizing = arm.indexOf('slotPlan.sizing')
    expect(theSize).toBeGreaterThan(-1)
    // HUG written first is lost to the resize that pins FIXED.
    expect(theSizing).toBeGreaterThan(theSize)
  })
})
