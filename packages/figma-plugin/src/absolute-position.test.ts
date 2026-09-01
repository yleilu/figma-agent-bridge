// absolute-position.test.ts — B87: an ABSOLUTE child lands where the spec said.
//
// THE LIVE FAILURE (2026-09-01, one `create_tree`): an H auto-layout COMPONENT
// `sizing:['HUG','HUG']` holding a 2×20 accent bar at
// `layoutPositioning:'ABSOLUTE'`, `position:[0,10]`, `constraints:['MIN',
// 'CENTER']`. Expected local [0,10]; read back **[0,-20]**, rendered above the
// row and outside its parent, with `warnings: []`.
//
// The fake reproduces Figma's arithmetic rather than asserting the number: the
// parent is born 100 tall, the child is placed against THAT box, the parent
// then hugs to 40, and the child's own CENTER constraint preserves its offset
// from the centre — which is correct behaviour applied to a box the caller
// never saw. The tree path defers a parent's HUG until its children are in
// place (B60), which is what makes the provisional box exist at all.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { restoreAbsolutePositions } from './absolute-position'

/**
 * A child that re-anchors when its parent's height changes, the way a CENTER
 * vertical constraint does.
 */
const centeredChild = (
  id: string,
  height: number,
): Record<string, unknown> & { reanchor: () => void } => {
  const node = {
    id,
    x: 0,
    y: 0,
    height,
    /** Distance from the parent's centre to this child's centre. */
    offsetFromCentre: 0,
    parentHeight: 0,
    reanchor(): void {
      node.y =
        node.parentHeight / 2 -
        node.offsetFromCentre -
        node.height / 2
    },
  }
  return node as never
}

/** Place the child in a parent of `height`, then hug the parent to `hugged`. */
const buildAndHug = (
  y: number,
  height: number,
  bornHeight: number,
  hugged: number,
) => {
  const child = centeredChild('570:1', height) as never as {
    id: string
    x: number
    y: number
    height: number
    offsetFromCentre: number
    parentHeight: number
    reanchor: () => void
  }
  child.parentHeight = bornHeight
  child.y = y
  child.offsetFromCentre =
    bornHeight / 2 - (child.y + child.height / 2)
  // The deferred resize.
  child.parentHeight = hugged
  child.reanchor()
  return child
}

describe('B87 — the parent hugs after the child is placed', () => {
  it('reproduces the live re-map, to the pixel', () => {
    const bar = buildAndHug(10, 20, 100, 40)
    expect(bar.y).toBe(-20)
  })

  it('puts the stated position back', () => {
    const bar = buildAndHug(10, 20, 100, 40)
    const moved = restoreAbsolutePositions([
      {
        node: bar as unknown as Record<string, unknown>,
        spec: {
          layoutPositioning: 'ABSOLUTE',
          position: [0, 10],
          constraints: ['MIN', 'CENTER'],
        },
      },
    ])
    expect(bar.y).toBe(10)
    expect(bar.x).toBe(0)
    expect(moved).toEqual(['570:1'])
  })
})

describe('restoreAbsolutePositions', () => {
  it('leaves a flow child alone', () => {
    const child = { id: '1:1', x: 5, y: 5 }
    expect(
      restoreAbsolutePositions([
        { node: child, spec: { position: [0, 10] } },
      ]),
    ).toEqual([])
    expect(child.y).toBe(5)
  })

  it('leaves an ABSOLUTE child that stated no position alone', () => {
    const child = { id: '1:1', x: 5, y: 5 }
    expect(
      restoreAbsolutePositions([
        {
          node: child,
          spec: { layoutPositioning: 'ABSOLUTE' },
        },
      ]),
    ).toEqual([])
    expect(child.y).toBe(5)
  })

  it('does not re-assign a child that never drifted', () => {
    // Assignment is where this campaign's surprises live — B68's opacity reset
    // on the paints setter, B79's path-rebase walk, B69's FIXED freeze — so a
    // node already at the stated value is not written to at all.
    let writes = 0
    const child = {
      id: '1:1',
      x: 0,
      get y(): number {
        return 10
      },
      set y(_v: number) {
        writes += 1
      },
    }
    expect(
      restoreAbsolutePositions([
        {
          node: child as unknown as Record<string, unknown>,
          spec: {
            layoutPositioning: 'ABSOLUTE',
            position: [0, 10],
          },
        },
      ]),
    ).toEqual([])
    expect(writes).toBe(0)
  })

  it('names a refusal instead of losing the tree over it', () => {
    const child: Record<string, unknown> = { id: '1:1', x: 0 }
    Object.defineProperty(child, 'y', {
      get: () => 0,
      set: () => {
        throw new Error('in set_y: The node does not exist')
      },
    })
    const warnings: string[] = []
    restoreAbsolutePositions(
      [
        {
          node: child,
          spec: {
            layoutPositioning: 'ABSOLUTE',
            position: [0, 10],
          },
        },
      ],
      warnings,
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('1:1')
    expect(warnings[0]).toContain('[0, 10]')
  })
})

// `code.ts` cannot be imported outside Figma — the house source-scan pattern.
describe('create_tree wiring', () => {
  const source =
    // eslint-disable-next-line n/no-sync -- test-only source scan
    readFileSync(join(import.meta.dir, 'code.ts'), 'utf8')

  it('restores AFTER the deferred resize, not before', () => {
    const restore = source.indexOf(
      'restoreAbsolutePositions(absoluteChildren',
    )
    const resize = source.indexOf(
      'applySizing(node as FrameNode, spec.sizing, warnings)\n    // B69',
    )
    expect(restore).toBeGreaterThan(-1)
    expect(resize).toBeGreaterThan(-1)
    // Order is the entire fix: run it first and the hug re-maps the child
    // straight back out of the parent.
    expect(restore).toBeGreaterThan(resize)
  })
})
