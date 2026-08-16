import { describe, expect, it } from 'bun:test'
import type {
  NodeSpec,
  IdStub,
} from '@figma-agent-bridge/shared/node-spec'
import {
  truncateTree,
  DEFAULT_BUDGET,
} from '../truncate-tree'

// Helper builder
const mk = (
  id: string,
  type: string,
  children?: NodeSpec[],
): NodeSpec => ({
  type,
  name: id,
  id,
  size: [100, 100],
  ...(children !== undefined ? { children } : {}),
})

const isStub = (n: unknown): n is IdStub =>
  typeof (n as IdStub).childCount === 'number'

describe('truncateTree', () => {
  // The receipt names SUBTREES that were cut (tool-surface.md), so a collapsed
  // LEAF earns no entry: it is in the view, and drilling into it yields no
  // further level. B51 caught the over-report from the other side — a depth-1
  // frame read listed every leaf sublayer it had already inlined.
  it('depth=0: children collapse to stubs; only the ones hiding a subtree are receipted', () => {
    const root = mk('root', 'FRAME', [
      mk('c1', 'FRAME', [mk('gc1', 'TEXT')]),
      mk('c2', 'TEXT'),
    ])
    const { view, truncated } = truncateTree(root, {
      depth: 0,
    })
    const spec = view as NodeSpec
    expect(spec.id).toBe('root')
    expect(spec.children).toHaveLength(2)
    // All children are stubs
    for (const child of spec.children!) {
      expect(isStub(child)).toBe(true)
    }
    // …but only c1 cut a subtree; c2 is a leaf and lost nothing.
    expect(truncated).toHaveLength(1)
    expect(truncated[0].id).toBe('c1')
    expect(truncated[0].childCount).toBe(1)
  })

  it('depth=1: root + first level full, grandchildren stubbed', () => {
    const gc1 = mk('gc1', 'FRAME', [mk('ggc1', 'TEXT')])
    const gc2 = mk('gc2', 'FRAME', [mk('ggc2', 'TEXT')])
    const c1 = mk('c1', 'FRAME', [gc1, gc2])
    const c2 = mk('c2', 'RECTANGLE')
    const root = mk('root', 'FRAME', [c1, c2])
    const { view, truncated } = truncateTree(root, {
      depth: 1,
    })
    const spec = view as NodeSpec
    expect(spec.id).toBe('root')
    expect(spec.children).toHaveLength(2)
    // c1 is a full spec (depth 1 allowed)
    const child1 = spec.children![0] as NodeSpec
    expect(isStub(child1)).toBe(false)
    expect(child1.id).toBe('c1')
    // grandchildren are stubs
    expect(child1.children).toHaveLength(2)
    for (const gc of child1.children!) {
      expect(isStub(gc)).toBe(true)
    }
    // c2 has no children so not in receipt
    const child2 = spec.children![1] as NodeSpec
    expect(isStub(child2)).toBe(false)
    expect(child2.id).toBe('c2')
    // Receipt: only the 2 grandchildren were stubbed
    expect(truncated).toHaveLength(2)
    const ids = truncated.map(r => r.id)
    expect(ids).toContain('gc1')
    expect(ids).toContain('gc2')
  })

  it('depth=-1: returns complete tree, empty receipt', () => {
    const root = mk('root', 'FRAME', [
      mk('c1', 'RECTANGLE', [mk('gc1', 'TEXT')]),
    ])
    const { view, truncated } = truncateTree(root, {
      depth: -1,
    })
    const spec = view as NodeSpec
    expect(spec.id).toBe('root')
    const c1 = spec.children![0] as NodeSpec
    expect(isStub(c1)).toBe(false)
    expect(c1.id).toBe('c1')
    const gc1 = c1.children![0] as NodeSpec
    expect(isStub(gc1)).toBe(false)
    expect(gc1.id).toBe('gc1')
    expect(truncated).toHaveLength(0)
  })

  it('no depth + no budget → treated as depth=0', () => {
    const root = mk('root', 'FRAME', [
      mk('c1', 'FRAME', [mk('gc1', 'TEXT')]),
    ])
    const { view, truncated } = truncateTree(root, {})
    const spec = view as NodeSpec
    expect(spec.children).toHaveLength(1)
    expect(isStub(spec.children![0])).toBe(true)
    expect(truncated).toHaveLength(1)
  })

  // B51 — the receipt over-reported: a leaf collapsed at the boundary is in
  // the view AND was named as lost. `truncated` names REAL loss only.
  it('receipt: names the cut subtrees, and only those', () => {
    // c1 has 3 children, c2 has 0 children
    const c1 = mk('c1', 'FRAME', [
      mk('gc1', 'RECTANGLE'),
      mk('gc2', 'TEXT'),
      mk('gc3', 'RECTANGLE'),
    ])
    const c2 = mk('c2', 'RECTANGLE')
    const root = mk('root', 'FRAME', [c1, c2])
    const { view, truncated } = truncateTree(root, {
      depth: 0,
    })
    // Both c1 and c2 are stubbed — the view is unchanged by this rule.
    const spec = view as NodeSpec
    expect(spec.children).toHaveLength(2)
    // Only c1 cut a subtree.
    expect(truncated).toHaveLength(1)
    expect(truncated[0].id).toBe('c1')
    expect(truncated[0].childCount).toBe(3)
  })

  it('receipt invariant: sum of stub childCount = direct children hidden at cut boundaries', () => {
    // Uniform tree: root -> [c1(2 children), c2(3 children)]
    const c1 = mk('c1', 'FRAME', [
      mk('gc1', 'RECTANGLE'),
      mk('gc2', 'TEXT'),
    ])
    const c2 = mk('c2', 'FRAME', [
      mk('gc3', 'RECTANGLE'),
      mk('gc4', 'TEXT'),
      mk('gc5', 'RECTANGLE'),
    ])
    const root = mk('root', 'FRAME', [c1, c2])
    const { truncated } = truncateTree(root, { depth: 0 })
    // c1 and c2 are both stubbed; total direct children hidden = 2+3 = 5
    const sum = truncated.reduce(
      (acc, r) => acc + r.childCount,
      0,
    )
    expect(sum).toBe(5)
  })

  it('small tree fully within depth: empty receipt', () => {
    const root = mk('root', 'FRAME', [
      mk('c1', 'RECTANGLE'),
    ])
    const { truncated } = truncateTree(root, { depth: 2 })
    // depth 2 includes root+children+grandchildren; tree only 2 levels deep
    expect(truncated).toHaveLength(0)
  })

  it('budget given: delegates to fillToBudget (overflow stubbed + receipt)', () => {
    const children = Array.from({ length: 20 }, (_, i) =>
      mk(`c${i}`, 'RECTANGLE'),
    )
    const root = mk('root', 'FRAME', children)
    const { truncated } = truncateTree(root, { budget: 20 })
    // Very tight budget must stub some children
    expect(truncated.length).toBeGreaterThan(0)
  })

  // B51 — a stub that reaches this pass was drawn by the READER, from a
  // boundary the PLUGIN drew (a page read at depth 0 does not serialize its
  // children's subtrees). This is the FIRST pass over the tree and the budget
  // pass after it never records a stub it was handed, so nothing else can
  // record this cut: `truncated: []` claimed a completeness the read did not
  // have, on exactly the page-rooted read the bug was found on.
  it('records a plugin-drawn boundary — nothing else has', () => {
    const drawnBoundary: IdStub = {
      id: 'page-child',
      name: 'Screen',
      type: 'FRAME',
      size: [100, 100],
      childCount: 5,
    }
    const leafBoundary: IdStub = {
      id: 'page-leaf',
      name: 'Divider',
      type: 'RECTANGLE',
      size: [100, 1],
      childCount: 0,
    }
    const root: NodeSpec = {
      type: 'PAGE',
      id: 'page',
      name: 'Page 1',
      children: [
        mk('real', 'FRAME', [mk('kid', 'TEXT')]),
        drawnBoundary,
        leafBoundary,
      ],
    }
    const { truncated } = truncateTree(root, { depth: 0 })
    const ids = truncated.map(r => r.id)
    expect(ids).toContain('page-child')
    expect(ids).toContain('real')
    // …and the boundary that hides nothing is still not a loss.
    expect(ids).not.toContain('page-leaf')
    expect(
      truncated.find(r => r.id === 'page-child')
        ?.childCount,
    ).toBe(5)
  })
})

// ─── the budget is always on (tool-surface.md:155, D4) ────────────────────────
//
// Omitting `budget` selects DEFAULT_BUDGET; it is not a request for an
// unbounded read. Depth chooses WHERE truncation lands, the budget decides
// WHETHER it happens — so no combination of arguments returns everything.
describe('truncateTree — always-on budget', () => {
  // A tree far larger than DEFAULT_BUDGET at depth 1.
  const wide = (n: number): NodeSpec =>
    mk(
      'root',
      'FRAME',
      Array.from({ length: n }, (_, i) =>
        mk('child-with-a-long-name-' + i, 'RECTANGLE'),
      ),
    )

  it('caps an explicit depth at the default budget', () => {
    const { view, truncated } = truncateTree(wide(4000), {
      depth: 1,
    })
    expect(truncated.length).toBeGreaterThan(0)
    expect(
      JSON.stringify(view).length / 4,
    ).toBeLessThanOrEqual(DEFAULT_BUDGET)
  })

  it('caps depth=-1 at the default budget', () => {
    const { view, truncated } = truncateTree(wide(4000), {
      depth: -1,
    })
    expect(truncated.length).toBeGreaterThan(0)
    expect(
      JSON.stringify(view).length / 4,
    ).toBeLessThanOrEqual(DEFAULT_BUDGET)
  })

  it('an explicit budget still wins over the default', () => {
    const { view } = truncateTree(wide(4000), {
      budget: 500,
    })
    expect(
      JSON.stringify(view).length / 4,
    ).toBeLessThanOrEqual(500)
  })

  it('leaves a small tree whole at depth=-1', () => {
    const root = mk('root', 'FRAME', [
      mk('c1', 'RECTANGLE'),
      mk('c2', 'TEXT'),
    ])
    expect(
      truncateTree(root, { depth: -1 }).truncated,
    ).toEqual([])
  })

  // C1 — every node the budget DROPPED is named, whatever its childCount.
  //
  // The depth pass collapses 1000 leaves to stubs and records none of them
  // (nothing was cut — they are all in the view). The budget pass then keeps
  // 803 and drops 197. Those 197 are gone from the response, and `inspect`
  // answers `{view, truncated}` with no count on the parent and no `truncated`
  // boolean — so an unnamed drop hands the agent a short list it reads as
  // complete. The receipt is the ONLY signal there is.
  it('names every child the budget dropped, leaves or not', () => {
    const leaves = Array.from({ length: 1000 }, (_, i) =>
      mk('leaf-' + i, 'RECTANGLE'),
    )
    const { view, truncated } = truncateTree(
      mk('root', 'FRAME', leaves),
      {},
    )
    const kept = (view as NodeSpec).children ?? []
    // The split is fixture-specific (it tracks how many bytes one stub costs);
    // the PARTITION below is the invariant. Before the fix this read answered
    // 772 children and `truncated: []`.
    expect(kept).toHaveLength(772)
    expect(truncated).toHaveLength(228)
    // Every dropped id is named, and no returned id is.
    const keptIds = new Set(kept.map(c => (c as IdStub).id))
    for (const entry of truncated) {
      expect(keptIds.has(entry.id)).toBe(false)
    }
    expect(
      new Set([...keptIds, ...truncated.map(e => e.id)])
        .size,
    ).toBe(1000)
  })
})
