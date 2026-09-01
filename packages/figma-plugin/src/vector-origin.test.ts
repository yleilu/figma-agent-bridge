// vector-origin.test.ts — B79: the stated position translates the frame the
// path data already established, it does not replace it.
//
// THE FAKE MODELS THE SETTER, and it has to. Assigning `vectorPaths` is not a
// field write: Figma rebases the data into the node's own box, resizes the node
// to the path bounds, and WALKS the node by the path minimum. That was proven
// live on 2026-08-30 with the b79 discriminator — a create stating no position
// at all, with data `M 60 76 … L 700 185 Z`, landed the node at [60,16], which
// is exactly the path's own minimum, with the ink where the data said.
//
// A plain-object fake cannot catch this defect, because the defect IS the side
// effect of an assignment. It is the fourth Figma assignment-time surprise of
// this campaign (B68 paint opacity, GRID re-init, count writes), and each one
// needed an accessor fake to be seen at all.

import { describe, expect, it } from 'bun:test'
import {
  assignVectorPaths,
  originOf,
  positionOverOffset,
  type PathTarget,
} from './vector-origin'

/** Every number in an SVG path string, as alternating x/y pairs. */
const pointsIn = (data: string): [number, number][] => {
  const nums = (data.match(/-?\d+(?:\.\d+)?/g) ?? []).map(
    Number,
  )
  const out: [number, number][] = []
  for (let i = 0; i + 1 < nums.length; i += 2) {
    out.push([nums[i], nums[i + 1]])
  }
  return out
}

/**
 * A node whose `vectorPaths` setter behaves the way Figma's does.
 *
 * `refuses` models the other live behaviour on the same setter: data Figma
 * cannot convert throws, the node keeps its old geometry, and nothing moved.
 */
const figmaVector = (
  at: [number, number] = [0, 0],
  refuses = false,
): PathTarget & {
  width: number
  height: number
  stored: unknown
} => {
  const node = {
    x: at[0],
    y: at[1],
    width: 0,
    height: 0,
    stored: undefined as unknown,
  }
  Object.defineProperty(node, 'vectorPaths', {
    configurable: true,
    enumerable: true,
    get: () => node.stored,
    set: (paths: { data: string }[]) => {
      if (refuses) {
        throw new Error(
          'in set_vectorPaths: Failed to convert path. Invalid command at H',
        )
      }
      const points = paths.flatMap(p => pointsIn(p.data))
      const xs = points.map(p => p[0])
      const ys = points.map(p => p[1])
      const minX = Math.min(...xs)
      const minY = Math.min(...ys)
      // 1. the data is REBASED into the node's own box …
      node.stored = paths.map(p => ({
        ...p,
        data: p.data.replace(/-?\d+(?:\.\d+)?/g, () => ''),
        rebasedFrom: [minX, minY],
      }))
      // 2. … the node is RESIZED to the path bounds …
      node.width = Math.max(...xs) - minX
      node.height = Math.max(...ys) - minY
      // 3. … and the node WALKS by the path minimum, so the ink stays where
      //      the data put it. This is the step the tool was overwriting.
      node.x += minX
      node.y += minY
    },
  })
  return node as PathTarget & {
    width: number
    height: number
    stored: unknown
  }
}

/** The 2026-08-30 Overview chart's own fill path, in plot coordinates. */
const CHART = [
  {
    windingRule: 'NONZERO',
    data: 'M 60 76 L 380 40 L 700 16 L 700 185 L 60 185 Z',
  },
]

describe('originOf', () => {
  it('reads a node origin', () => {
    expect(originOf({ x: 4, y: 8 })).toEqual([4, 8])
  })

  it('is undefined when the node will not answer', () => {
    expect(originOf({})).toBeUndefined()
  })

  it('is undefined for a handle that throws — never a fabricated [0,0]', () => {
    const dead = new Proxy({} as PathTarget, {
      get: () => {
        throw new Error('does not exist')
      },
      has: () => true,
    })
    expect(originOf(dead)).toBeUndefined()
  })
})

describe('assignVectorPaths — what Figma moved the node by', () => {
  it('reports the walk as the offset', () => {
    const node = figmaVector()
    const { applied, offset } = assignVectorPaths(
      node,
      CHART,
    )
    expect(applied).toBe(true)
    // The path minimum, and the node is now standing on it.
    expect(offset).toEqual([60, 16])
    expect([node.x, node.y]).toEqual([60, 16])
  })

  it('is [0,0] for 0-based data — nothing else may move', () => {
    const node = figmaVector()
    const { offset } = assignVectorPaths(node, [
      { windingRule: 'NONZERO', data: 'M 0 0 L 24 24 Z' },
    ])
    expect(offset).toEqual([0, 0])
  })

  it('measures the walk RELATIVE to where the node already stands', () => {
    // The update case. The setter adds the path minimum to the CURRENT
    // position, so a node already placed at [100,200] walks to [160,216] —
    // and the offset is still the 60/16 the caller has to be compensated for,
    // not the absolute 160/216.
    const node = figmaVector([100, 200])
    const { offset } = assignVectorPaths(node, CHART)
    expect(offset).toEqual([60, 16])
    expect([node.x, node.y]).toEqual([160, 216])
  })

  it('a refused assignment applies nothing and reports Figma’s own words', () => {
    const node = figmaVector([5, 5], true)
    const warnings: string[] = []
    const { applied, offset } = assignVectorPaths(
      node,
      CHART,
      warnings,
    )
    expect(applied).toBe(false)
    expect(offset).toEqual([0, 0])
    expect([node.x, node.y]).toEqual([5, 5])
    expect(warnings[0]).toContain(
      'vectorPaths rejected by Figma',
    )
    expect(warnings[0]).toContain('Invalid command at H')
  })

  it('sends Figma only the two keys its shape has', () => {
    const node = figmaVector()
    assignVectorPaths(node, [
      {
        windingRule: 'NONZERO',
        data: 'M 0 0 L 8 8 Z',
        corners: { 0: 4 },
      } as unknown as { windingRule: unknown; data: string },
    ])
    const sent = (
      node.stored as Record<string, unknown>[]
    )[0]
    expect(sent).not.toHaveProperty('corners')
  })
})

describe('positionOverOffset — the coordinate contract', () => {
  // The live case, whole: the operator wrote the chart in plot coordinates and
  // stated position [0,0]. The tool then wrote x=0,y=0 AFTER the walk, so
  // every coordinate shifted by (−60,−16) and the fill baseline floated 16px
  // above the zero axis. warnings: [].
  it('a stated [0,0] over a walked node keeps the ink where the data said', () => {
    expect(positionOverOffset([0, 0], [60, 16])).toEqual([
      60, 16,
    ])
  })

  it('a stated position translates that frame', () => {
    expect(positionOverOffset([10, 10], [60, 16])).toEqual([
      70, 26,
    ])
  })

  it('0-based data is untouched — offset 0, position as written', () => {
    expect(positionOverOffset([120, 40], [0, 0])).toEqual([
      120, 40,
    ])
  })

  it('no stated position leaves Figma’s walk alone', () => {
    // This is the behaviour the discriminator proved correct: with no position
    // at all the ink already lands where the data said.
    expect(
      positionOverOffset(undefined, [60, 16]),
    ).toBeUndefined()
  })

  it('the S48 icon glyph lands centred, not in the corner', () => {
    // Every glyph was authored `M 4 4 … L 20 20` — 16×16 ink centred in the
    // 24-box with the 2px rim — plus position [0,0]. The clobber dragged all of
    // them to the box corner, off-centre by (−4,−4), through 36 nav instances,
    // every button and every chip.
    expect(positionOverOffset([0, 0], [4, 4])).toEqual([
      4, 4,
    ])
  })

  it('a malformed position is left exactly as it came', () => {
    // Not this function's refusal to make: the write face already validates
    // the shape, and inventing a number here would hide the bad input.
    expect(positionOverOffset('nope', [60, 16])).toBe(
      undefined,
    )
    expect(positionOverOffset([1], [60, 16])).toBeUndefined()
  })
})
