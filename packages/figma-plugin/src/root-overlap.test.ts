// root-overlap.test.ts — I5 (growth half): the write that pushed one page-root
// frame into another.
//
// The live case, 2026-09-01: the operator stated sane positions — a DS section
// at y=1400, the next at y=1900, a 500px budget between them — then appended
// into the first. It HUGS, so it grew to 556 and 56px of it went into its
// neighbour. `warnings: []`. A placement-time checker would have passed that
// write, because at placement time nothing was wrong.

import { describe, expect, it } from 'bun:test'
import {
  boxOf,
  grownIntoNeighbourWarning,
  overlapOf,
  pageRootOf,
  type BoxNode,
} from './root-overlap'

/** A page holding the frames named, each already linked to its parent. */
const page = (...frames: BoxNode[]): BoxNode => {
  const node: BoxNode = {
    type: 'PAGE',
    name: 'Design System',
    children: frames,
  }
  for (const frame of frames) {
    frame.parent = node
  }
  return node
}

const frame = (
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  children: BoxNode[] = [],
): BoxNode => {
  const node: BoxNode = {
    id: 'f:' + name,
    name,
    type: 'FRAME',
    x,
    y,
    width,
    height,
    children,
  }
  for (const child of children) {
    child.parent = node
  }
  return node
}

describe('pageRootOf', () => {
  it('answers the ancestor whose own parent is the PAGE', () => {
    const deep: BoxNode = { name: 'Label', type: 'TEXT' }
    const row = frame('Row', 0, 0, 10, 10, [deep])
    const section = frame('Blocks', 0, 1400, 1200, 500, [
      row,
    ])
    page(section)
    expect(pageRootOf(deep)?.name).toBe('Blocks')
  })

  it('a page root answers itself — an update of it moves the same box', () => {
    const section = frame('Blocks', 0, 1400, 1200, 500)
    page(section)
    expect(pageRootOf(section)?.name).toBe('Blocks')
  })

  it('is undefined for a node that is not on a page', () => {
    expect(pageRootOf({ name: 'Orphan' })).toBeUndefined()
  })

  it('is undefined when an ancestor refuses to be read', () => {
    const dead = new Proxy({} as BoxNode, {
      get: () => {
        throw new Error('does not exist')
      },
      has: () => true,
    })
    expect(pageRootOf({ parent: dead })).toBeUndefined()
  })
})

describe('overlapOf', () => {
  it('measures the intersection', () => {
    expect(
      overlapOf(
        { x: 0, y: 1400, width: 1200, height: 556 },
        { x: 0, y: 1900, width: 1200, height: 400 },
      ),
    ).toEqual({ width: 1200, height: 56 })
  })

  it('a shared EDGE is not an overlap', () => {
    // Two frames laid out side by side touch on purpose, and warning there
    // would fire on the tidiest possible page.
    expect(
      overlapOf(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 100, y: 0, width: 100, height: 100 },
      ),
    ).toBeUndefined()
  })

  it('separated boxes do not overlap', () => {
    expect(
      overlapOf(
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 50, y: 50, width: 10, height: 10 },
      ),
    ).toBeUndefined()
  })
})

describe('grownIntoNeighbourWarning — the live case', () => {
  /** The DS page as it stood, and as it stood after the appends. */
  const dsPage = (grownHeight: number) => {
    const blocks = frame(
      'Blocks',
      0,
      1400,
      1200,
      grownHeight,
    )
    const tables = frame('Tables', 0, 1900, 1200, 400)
    page(blocks, tables)
    return { blocks, tables }
  }

  it('names both frames, the growth and the overlap', () => {
    const before = boxOf(dsPage(500).blocks)
    const { blocks } = dsPage(556)
    const warning = grownIntoNeighbourWarning(
      blocks,
      before,
    )
    expect(warning).toContain('"Blocks"')
    expect(warning).toContain('"Tables"')
    expect(warning).toContain('1200×500')
    expect(warning).toContain('1200×556')
    expect(warning).toContain('1200×56px')
  })

  it('says nothing while the growth stays inside its budget', () => {
    // 1400 + 480 = 1880, and the neighbour starts at 1900. The frame grew and
    // the write is fine, which is the case that must stay quiet.
    const before = boxOf(dsPage(400).blocks)
    const { blocks } = dsPage(480)
    expect(
      grownIntoNeighbourWarning(blocks, before),
    ).toBeUndefined()
  })

  it('fires the moment the growth crosses the budget', () => {
    // 1400 + 500 exactly meets 1900 — a shared edge, not an overlap. One more
    // pixel is the finding.
    const before = boxOf(dsPage(500).blocks)
    const { blocks } = dsPage(501)
    expect(
      grownIntoNeighbourWarning(blocks, before),
    ).toContain('"Tables"')
  })

  it('says nothing when nothing grew', () => {
    // An ordinary edit inside a frame that already sits where it sits.
    const before = boxOf(dsPage(556).blocks)
    const { blocks } = dsPage(556)
    expect(
      grownIntoNeighbourWarning(blocks, before),
    ).toBeUndefined()
  })

  it('does not report an overlap the write did not cause', () => {
    // The pair already overlapped, and this write grew the frame further. That
    // is worth nothing to the caller and would fire on every edit inside a
    // document someone has decided to lay out that way.
    const before = boxOf(dsPage(600).blocks)
    const { blocks } = dsPage(700)
    expect(
      grownIntoNeighbourWarning(blocks, before),
    ).toBeUndefined()
  })

  it('a frame that SHRANK is the same non-event', () => {
    const before = boxOf(dsPage(700).blocks)
    const { blocks } = dsPage(500)
    expect(
      grownIntoNeighbourWarning(blocks, before),
    ).toBeUndefined()
  })

  it('growth on the OTHER axis is caught too', () => {
    const left = frame('Left', 0, 0, 500, 400)
    const right = frame('Right', 600, 0, 400, 400)
    page(left, right)
    const before = boxOf(left)
    left.width = 700
    expect(
      grownIntoNeighbourWarning(left, before),
    ).toContain('"Right"')
  })

  it('aggregates when several neighbours are hit (T4)', () => {
    const grower = frame('Grower', 0, 0, 10, 10)
    const others = [1, 2, 3, 4].map(i =>
      frame('N' + i, i * 100, 0, 50, 50),
    )
    page(grower, ...others)
    const before = boxOf(grower)
    grower.width = 1000
    const warning = grownIntoNeighbourWarning(
      grower,
      before,
    )
    expect(warning).toContain('"N1"')
    expect(warning).toContain('"N3"')
    expect(warning).toContain('and 1 more')
    expect(warning).not.toContain('"N4"')
  })

  it('is undefined for a frame that is not a page root', () => {
    expect(
      grownIntoNeighbourWarning(undefined, undefined),
    ).toBeUndefined()
  })

  it('is undefined when the frame will not state its box', () => {
    expect(
      grownIntoNeighbourWarning({ name: 'Blocks' }, undefined),
    ).toBeUndefined()
  })

  it('a sibling that will not state its box is skipped, not guessed at', () => {
    const grower = frame('Grower', 0, 0, 10, 10)
    const opaque: BoxNode = { name: 'Sticky', type: 'STICKY' }
    page(grower, opaque)
    const before = boxOf(grower)
    grower.width = 1000
    expect(
      grownIntoNeighbourWarning(grower, before),
    ).toBeUndefined()
  })
})
