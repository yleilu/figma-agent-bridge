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
  it('depth=0: root returned with children collapsed to stubs', () => {
    const root = mk('root', 'FRAME', [
      mk('c1', 'RECTANGLE'),
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
    // Receipt records both stubs
    expect(truncated).toHaveLength(2)
    const ids = truncated.map(r => r.id)
    expect(ids).toContain('c1')
    expect(ids).toContain('c2')
  })

  it('depth=1: root + first level full, grandchildren stubbed', () => {
    const gc1 = mk('gc1', 'RECTANGLE')
    const gc2 = mk('gc2', 'TEXT')
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
      mk('c1', 'RECTANGLE'),
    ])
    const { view, truncated } = truncateTree(root, {})
    const spec = view as NodeSpec
    expect(spec.children).toHaveLength(1)
    expect(isStub(spec.children![0])).toBe(true)
    expect(truncated).toHaveLength(1)
  })

  it('receipt: names exactly the cut nodes with correct childCount', () => {
    // c1 has 3 children, c2 has 0 children
    const c1 = mk('c1', 'FRAME', [
      mk('gc1', 'RECTANGLE'),
      mk('gc2', 'TEXT'),
      mk('gc3', 'RECTANGLE'),
    ])
    const c2 = mk('c2', 'RECTANGLE')
    const root = mk('root', 'FRAME', [c1, c2])
    const { truncated } = truncateTree(root, { depth: 0 })
    // Both c1 and c2 are stubbed
    expect(truncated).toHaveLength(2)
    const c1Entry = truncated.find(r => r.id === 'c1')
    const c2Entry = truncated.find(r => r.id === 'c2')
    expect(c1Entry).toBeDefined()
    expect(c1Entry!.childCount).toBe(3)
    expect(c2Entry).toBeDefined()
    expect(c2Entry!.childCount).toBe(0)
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

  it('existing IdStub children are not re-added to receipt', () => {
    // Simulate a partial tree where c2 is already a stub (pre-collapsed)
    const alreadyStub: IdStub = {
      id: 'pre-stub',
      name: 'pre-stub',
      type: 'RECTANGLE',
      size: [100, 100],
      childCount: 5,
    }
    const root: NodeSpec = {
      type: 'FRAME',
      id: 'root',
      name: 'root',
      size: [100, 100],
      children: [mk('real', 'RECTANGLE'), alreadyStub],
    }
    const { truncated } = truncateTree(root, { depth: 0 })
    // 'real' gets stubbed by depth cut, 'pre-stub' was already a stub
    const ids = truncated.map(r => r.id)
    // pre-stub should NOT appear in receipt (it was already cut)
    expect(ids).not.toContain('pre-stub')
    // 'real' should appear
    expect(ids).toContain('real')
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
})
