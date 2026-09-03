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
import {
  applyStatedPosition,
  restoreAbsolutePositions,
} from './absolute-position'

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

// ─── B87, THE SECOND DOOR (reopened 2026-09-03) ────────────────────────────
//
// Same shape, different tool. The naive operator hit it through `update_node`
// on an ABSOLUTE child of an auto-layout parent: writing `position:[0,0]` read
// back **[0,-40]**, and writing `[0,40]` read back **[0,0]** — a constant
// offset of exactly ONE NODE HEIGHT, deterministic, with `warnings: []`. It
// cost a real chart defect (the treasury `Month ticks` row) and the operator
// had to write every ABSOLUTE child with a compensating height offset for the
// rest of the build.
//
// THE FAKE MODELS THE SETTER. `y` is not a stored field here any more than
// `vectorPaths` is (B79): Figma re-maps the assignment through the child's own
// constraint against a box the write itself moved, so what comes back out is
// not what went in. A plain-object fake stores 0 and reads 0, and the defect
// is invisible — which is precisely why it survived the create-door fix.

/**
 * A node whose `y` setter re-maps by one node height, the way the live one did.
 *
 * `drift` is applied on ASSIGNMENT and measured relatively, so a second write
 * that compensates for it lands: `write(40)` → reads 0, which is the live
 * observation the operator worked around by hand.
 */
const remappingChild = (
  drift: number,
  // Where the node stands BEFORE the patch. The live one stood at -40: the
  // operator was correcting a row that had already been re-mapped once.
  start = -40,
  id = '581:9001',
): Record<string, unknown> & { writes: number } => {
  const node = {
    id,
    name: 'Month ticks',
    height: 40,
    stored: start,
    writes: 0,
    x: 0,
  }
  Object.defineProperty(node, 'y', {
    configurable: true,
    enumerable: true,
    get: () => node.stored,
    set: (v: number) => {
      node.writes += 1
      node.stored = v + drift
    },
  })
  return node as never
}

describe('B87 second door — a stated position lands or says why', () => {
  it('reproduces the live re-map: writing 0 reads back -40', () => {
    const node = remappingChild(-40)
    ;(node as unknown as { y: number }).y = 0
    expect((node as unknown as { y: number }).y).toBe(-40)
  })

  it('compensates for the re-map, so the read-back IS the stated value', () => {
    const node = remappingChild(-40)
    const warnings: string[] = []
    applyStatedPosition(node, [0, 0], warnings)
    expect((node as unknown as { y: number }).y).toBe(0)
    // Landed as stated, so nothing was lost and nothing is said.
    expect(warnings).toEqual([])
  })

  it('writes nothing at all when the node already reads the stated value', () => {
    // Assignment is where this campaign's surprises live (B68, B79, B69).
    const node = remappingChild(-40, 12)
    applyStatedPosition(node, [0, 12])
    expect(node.writes).toBe(0)
  })

  it('takes at most one corrective write — never a chase', () => {
    const node = remappingChild(-40)
    applyStatedPosition(node, [0, 0])
    expect(node.writes).toBe(2)
  })

  it('NAMES a position it could not land, instead of returning silence', () => {
    // A node that answers the same y whatever is written to it: the second
    // write proves the first was not a measurable drift but a refusal.
    const node: Record<string, unknown> = {
      id: '581:9002',
      name: 'Pinned',
      x: 0,
    }
    Object.defineProperty(node, 'y', {
      get: () => -40,
      set: () => {},
    })
    const warnings: string[] = []
    applyStatedPosition(node, [0, 0], warnings)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('581:9002')
    expect(warnings[0]).toContain('[0, 0]')
    expect(warnings[0]).toContain('[0, -40]')
  })

  it('names a REFUSAL in Figma’s own words rather than throwing', () => {
    const node: Record<string, unknown> = {
      id: '581:9003',
      x: 0,
    }
    Object.defineProperty(node, 'y', {
      get: () => 0,
      set: () => {
        throw new Error('in set_y: The node does not exist')
      },
    })
    const warnings: string[] = []
    expect(() =>
      applyStatedPosition(node, [0, 10], warnings),
    ).not.toThrow()
    expect(warnings[0]).toContain('does not exist')
  })

  it('is not a request at all when no position was stated', () => {
    const node = remappingChild(-40)
    applyStatedPosition(node, undefined)
    applyStatedPosition(node, [0])
    applyStatedPosition(node, ['x', 'y'])
    expect(node.writes).toBe(0)
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

describe('update_node wiring (B87 second door)', () => {
  const source = readFileSync(
    join(import.meta.dir, 'code.ts'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('read the file (liveness)', () => {
    expect(source).toContain('case COMMANDS.UPDATE_NODE:')
  })

  it('proves the stated position AFTER everything that can move the node', () => {
    const update = source.indexOf(
      'case COMMANDS.UPDATE_NODE:',
    )
    const arm = source.slice(
      update,
      source.indexOf('case COMMANDS.BIND_VARIABLE:'),
    )
    const prove = arm.indexOf('applyStatedPosition(')
    expect(prove).toBeGreaterThan(-1)
    // The size write and the bindings both move a box, so a position proved
    // before them is proved against a node that is about to move again.
    expect(prove).toBeGreaterThan(
      arm.indexOf('applySizeVerified('),
    )
    expect(prove).toBeGreaterThan(
      arm.indexOf('applyWrapperBindings('),
    )
  })
})
