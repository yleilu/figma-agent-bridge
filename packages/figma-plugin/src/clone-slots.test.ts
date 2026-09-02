// clone-slots.test.ts — B88, the clone that lost its slot content.
//
// The live construction (2026-09-02): a component with a `Body` SLOT → an
// INSTANCE of it → a tree built INTO the slot → `clone_node`. The clone shows
// no slot content, and a depth-2 read of it answers
// `PLUGIN_ERROR: cannot read property 'indexOf' of undefined`.
//
// MODELED, NOT OBSERVED here: that Figma drops the content. Nothing headless
// can make `instance.clone()` behave; the fixture stands the OUTCOME up (a
// clone whose slot is empty beside a source whose slot is full) so the repair
// can be held to the two rules that matter — fill only what is actually
// missing, and never pair two trees that disagree about their shape.

import { describe, expect, it } from 'bun:test'
import {
  nodeAt,
  slotContentClonedMessage,
  slotContentNotClonedMessage,
  slotFillPlan,
} from './clone-slots'
import type { LiveNode } from './canonical-ids'

const node = (
  type: string,
  name: string,
  children: LiveNode[] = [],
): LiveNode => ({ type, name, children })

/** `Chart card` INSTANCE → `Body` SLOT → a table the operator built into it. */
const filled = (): LiveNode =>
  node('INSTANCE', 'Chart card', [
    node('FRAME', 'Header'),
    node('SLOT', 'Body', [
      node('FRAME', 'Table', [node('TEXT', 'Amount')]),
    ]),
  ])

/** The same card as Figma clones it: the slot came over EMPTY. */
const clonedEmpty = (): LiveNode =>
  node('INSTANCE', 'Chart card', [
    node('FRAME', 'Header'),
    node('SLOT', 'Body'),
  ])

describe('slotFillPlan — the difference, never a copy', () => {
  it('names the slot the clone is short and the source nodes for it', () => {
    const plan = slotFillPlan(filled(), clonedEmpty())
    expect(plan).toHaveLength(1)
    expect(plan[0].path).toEqual([1])
    expect(plan[0].missing).toHaveLength(1)
    expect(plan[0].missing[0].name).toBe('Table')
  })

  it('is a NO-OP on a runtime that carried the content itself', () => {
    // The only safe shape for a repair aimed at a runtime behaviour: where
    // Figma behaves, nothing is appended and nothing is said.
    expect(slotFillPlan(filled(), filled())).toEqual([])
  })

  it('says nothing about a slot that is empty on BOTH sides', () => {
    const empty = node('INSTANCE', 'Chart card', [
      node('SLOT', 'Body'),
    ])
    expect(slotFillPlan(empty, empty)).toEqual([])
  })

  it('leaves a slot holding MORE than the source alone', () => {
    // The master's own default content plus something. Which entry is which is
    // not knowable from a count, and appending on a guess puts a node in the
    // wrong place.
    const plan = slotFillPlan(clonedEmpty(), filled())
    expect(plan).toEqual([])
  })

  it('does not descend past a slot it is already filling', () => {
    // A nested slot inside slot content rides with its own outermost ancestor
    // — the same reasoning slot-content.ts applies to the delete side.
    const src = node('INSTANCE', 'Card', [
      node('SLOT', 'Body', [
        node('INSTANCE', 'Row', [
          node('SLOT', 'Trailing', [node('TEXT', 'x')]),
        ]),
      ]),
    ])
    const dst = node('INSTANCE', 'Card', [
      node('SLOT', 'Body'),
    ])
    const plan = slotFillPlan(src, dst)
    expect(plan).toHaveLength(1)
    expect(plan[0].path).toEqual([0])
  })

  it('refuses to pair two trees that disagree about their shape', () => {
    const src = node('INSTANCE', 'Card', [
      node('FRAME', 'Header'),
      node('SLOT', 'Body', [node('TEXT', 'x')]),
    ])
    const dst = node('INSTANCE', 'Card', [
      node('SLOT', 'Body'),
    ])
    expect(slotFillPlan(src, dst)).toEqual([])
  })

  it('survives a handle that will not say what it is', () => {
    const hostile: LiveNode = { name: 'ghost' }
    Object.defineProperty(hostile, 'type', {
      get() {
        throw new Error('The node does not exist')
      },
    })
    const src = node('INSTANCE', 'Card', [hostile])
    const dst = node('INSTANCE', 'Card', [
      node('SLOT', 'Body'),
    ])
    expect(() => slotFillPlan(src, dst)).not.toThrow()
  })
})

describe('nodeAt — the slot the plan points at', () => {
  it('walks a child-index path', () => {
    expect(nodeAt(filled(), [1])?.name).toBe('Body')
    expect(nodeAt(filled(), [1, 0, 0])?.name).toBe('Amount')
  })

  it('answers undefined when the path falls off the tree', () => {
    expect(nodeAt(filled(), [9])).toBeUndefined()
    expect(nodeAt(filled(), [0, 0])).toBeUndefined()
  })
})

describe('the two sentences', () => {
  it('the repair names the count and the new ids', () => {
    expect(slotContentClonedMessage(3)).toContain('3')
    expect(slotContentClonedMessage(3)).toContain('NEW ids')
  })

  it('the shortfall names the empty slot and the way through', () => {
    const message = slotContentNotClonedMessage(2)
    expect(message).toContain('EMPTY slot')
    expect(message).toContain('create_tree')
  })
})
