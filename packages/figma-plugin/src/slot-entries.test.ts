// slot-entries.test.ts — the two shapes a slot entry arrives in (B30).

import { describe, expect, it } from 'bun:test'
import {
  readSlotEntry,
  slotParentRefusal,
} from './slot-entries'

describe('readSlotEntry', () => {
  it('reads a bare name and asks for no spec (back-compat)', () => {
    expect(readSlotEntry('Content')).toEqual({
      name: 'Content',
    })
  })

  it('reads the name off an object entry and keeps the spec', () => {
    const entry = {
      name: 'Content',
      layout: { mode: 'V', spacing: 8 },
      fills: [],
    }
    const read = readSlotEntry(entry)
    expect(read.name).toBe('Content')
    expect(read.spec).toBe(entry)
  })

  it('never stringifies a missing name — an unnamed entry keeps Figma auto-name', () => {
    const read = readSlotEntry({ fills: [] })
    expect(read.name).toBe('')
    expect(read.spec).toEqual({ fills: [] })
  })

  it('treats a non-string name the same way (no [object Object] slot)', () => {
    expect(readSlotEntry({ name: 42 }).name).toBe('')
  })

  it('survives a null entry', () => {
    expect(
      readSlotEntry(null as unknown as string),
    ).toEqual({ name: '' })
  })
})

// ─── slotParentRefusal (I60) ─────────────────────────────────────────────────
//
// `createSlot()` takes no argument and drops its slot at the component's root.
// A real component puts the slot INSIDE something — a card's body, a row's
// trailing cell — so every nested slot cost a second reparent_node call, and
// until it landed the component was laid out wrong.
//
// The slot is already created and named by the time this runs, so a refusal
// never costs it. It stays at the root and the warning says why: a slot parked
// somewhere the caller did not ask for is worse than one still at the root,
// because only the second is where the caller will look for it.
describe('slotParentRefusal', () => {
  const comp = { id: 'C:1' }
  /** A node inside the component, `depth` hops down. */
  const inside = (
    depth: number,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    let node: Record<string, unknown> = comp
    for (let i = 0; i < depth; i += 1) {
      node = {
        id: 'N:' + i,
        type: 'FRAME',
        appendChild: () => {},
        parent: node,
      }
    }
    return { ...node, ...over }
  }

  it('accepts a container inside the component', () => {
    expect(
      slotParentRefusal(inside(1), comp, 'N:0'),
    ).toBeUndefined()
  })

  it('accepts one several levels down', () => {
    expect(
      slotParentRefusal(inside(4), comp, 'N:3'),
    ).toBeUndefined()
  })

  it('accepts the component itself — that is where the slot already is', () => {
    expect(
      slotParentRefusal(
        { ...comp, appendChild: () => {} },
        comp,
        'C:1',
      ),
      // eslint-disable-next-line no-undefined -- reads better than toBeUndefined here
    ).toBe(undefined)
  })

  it('refuses an id that names nothing', () => {
    const why = slotParentRefusal(null, comp, 'N:missing')
    expect(why).toContain('names no node')
    expect(why).toContain('N:missing')
    expect(why).toContain('stays at the component root')
  })

  // The dangerous case: appending here would SUCCEED and quietly move the slot
  // out of the component it belongs to, so it is checked before capability.
  it('refuses a node outside the component, however appendable', () => {
    const stranger = {
      id: 'X:1',
      type: 'FRAME',
      appendChild: () => {},
      parent: { id: 'OTHER', parent: null },
    }
    const why = slotParentRefusal(stranger, comp, 'X:1')
    expect(why).toContain('not inside this component')
  })

  it('refuses a node inside the component that cannot have children', () => {
    const leaf = inside(2, {
      type: 'TEXT',
      appendChild: undefined,
    })
    const why = slotParentRefusal(leaf, comp, 'N:1')
    expect(why).toContain('cannot have children')
    expect(why).toContain('TEXT')
  })

  it('does not hang on a parent cycle', () => {
    const a: Record<string, unknown> = {
      id: 'A',
      appendChild: () => {},
    }
    const b: Record<string, unknown> = {
      id: 'B',
      parent: a,
    }
    a.parent = b
    expect(slotParentRefusal(a, comp, 'A')).toContain(
      'not inside this component',
    )
  })
})
