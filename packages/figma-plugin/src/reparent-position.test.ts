// reparent-position.test.ts — B55: reparent_node keeps the node where it is.
//
// The repro: a node nested at parent-relative [27, 11.5] inside a frame far out
// on the canvas was reparented to the PAGE and landed at [27, 11.5] ABSOLUTE —
// its old relative coordinates read as canvas coordinates, so the node jumped
// on top of other artwork. code.ts already recomputed x/y across the move, but
// it read the new parent's origin off `absoluteTransform`, and a PageNode has
// none — so the whole preservation branch was skipped exactly when un-nesting
// to the page, which is the common case.

import { describe, expect, it } from 'bun:test'
import {
  originOf,
  parentOwnsPlacement,
  reparentPlacement,
} from './reparent-position'

/** A frame-like node with a page-absolute origin. */
const at = (
  x: number,
  y: number,
  over: Record<string, unknown> = {},
) => ({
  type: 'FRAME',
  absoluteTransform: [
    [1, 0, x],
    [0, 1, y],
  ],
  ...over,
})

const page = { type: 'PAGE' }

describe('originOf', () => {
  it('reads the translation out of an absoluteTransform', () => {
    expect(originOf(at(2600, 900))).toEqual([2600, 900])
  })

  it('gives a PAGE the canvas origin — it has no transform of its own', () => {
    expect(originOf(page)).toEqual([0, 0])
  })

  it('answers undefined for a node with neither', () => {
    expect(originOf({ type: 'RECTANGLE' })).toBeUndefined()
  })

  it('answers undefined for a malformed transform rather than guessing', () => {
    expect(
      originOf({
        type: 'FRAME',
        absoluteTransform: [[1, 0]],
      }),
    ).toBeUndefined()
  })
})

describe('parentOwnsPlacement', () => {
  it('is true for every auto-layout mode', () => {
    for (const mode of ['HORIZONTAL', 'VERTICAL', 'GRID']) {
      expect(
        parentOwnsPlacement({ layoutMode: mode }),
      ).toBe(true)
    }
  })

  it('is false for layoutMode NONE', () => {
    expect(
      parentOwnsPlacement({ layoutMode: 'NONE' }),
    ).toBe(false)
  })

  it('is false for a PAGE, which has no layoutMode at all', () => {
    expect(parentOwnsPlacement(page)).toBe(false)
  })
})

describe('reparentPlacement', () => {
  // The B55 repro, exactly: a child sitting at [2627, 11.5] on the canvas
  // (relative [27, 11.5] inside a frame at [2600, 0]) is moved to the PAGE.
  it('keeps the canvas position when un-nesting to the page', () => {
    expect(reparentPlacement([2627, 11.5], page)).toEqual({
      x: 2627,
      y: 11.5,
    })
  })

  it('keeps the canvas position under a non-auto-layout frame', () => {
    expect(
      reparentPlacement(
        [2627, 11.5],
        at(2600, 0, { layoutMode: 'NONE' }),
      ),
    ).toEqual({ x: 27, y: 11.5 })
  })

  // The other direction: an auto-layout parent OWNS child placement, so a
  // re-placement here would fight the re-flow. Nothing to apply.
  it('leaves an auto-layout parent to place the child itself', () => {
    expect(
      reparentPlacement(
        [2627, 11.5],
        at(100, 100, { layoutMode: 'VERTICAL' }),
      ),
    ).toBeUndefined()
  })

  it('leaves a GRID parent to place the child itself', () => {
    expect(
      reparentPlacement(
        [2627, 11.5],
        at(100, 100, { layoutMode: 'GRID' }),
      ),
    ).toBeUndefined()
  })

  it('applies nothing when either origin is unknown', () => {
    expect(
      reparentPlacement(undefined, page),
    ).toBeUndefined()
    expect(
      reparentPlacement([10, 10], { type: 'RECTANGLE' }),
    ).toBeUndefined()
  })
})
