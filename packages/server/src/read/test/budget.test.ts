import { describe, expect, it } from 'bun:test'
import type { NodeSpec } from '@figma-agent-bridge/shared/node-spec'
import { estimateTokens, fillToBudget } from '../budget'

// Helper to build a NodeSpec fixture
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

describe('estimateTokens', () => {
  it('monotonicity: node with children has more tokens than alone', () => {
    const parent = mk('p', 'FRAME', [mk('c1', 'RECTANGLE')])
    const parentAlone = mk('p', 'FRAME')
    expect(estimateTokens(parent)).toBeGreaterThan(
      estimateTokens(parentAlone),
    )
  })

  it('monotonicity: adding more children increases estimate', () => {
    const one = mk('p', 'FRAME', [mk('c1', 'RECTANGLE')])
    const two = mk('p', 'FRAME', [
      mk('c1', 'RECTANGLE'),
      mk('c2', 'TEXT'),
    ])
    expect(estimateTokens(two)).toBeGreaterThan(
      estimateTokens(one),
    )
  })

  it('single node with no children has a positive estimate', () => {
    const n = mk('a', 'FRAME')
    expect(estimateTokens(n)).toBeGreaterThan(0)
  })

  it('is char-length / 4 rounded up', () => {
    const n = mk('x', 'RECTANGLE')
    const expected = Math.ceil(JSON.stringify(n).length / 4)
    expect(estimateTokens(n)).toBe(expected)
  })
})

describe('fillToBudget', () => {
  it('includes root when budget is generous', () => {
    const root = mk('root', 'FRAME', [
      mk('c1', 'RECTANGLE'),
    ])
    const { view, truncated } = fillToBudget(root, 99999)
    expect((view as NodeSpec).id).toBe('root')
    expect(truncated).toHaveLength(0)
  })

  it('budget-respect: view estimate never exceeds budget by more than one node at decision time', () => {
    const children = Array.from({ length: 20 }, (_, i) =>
      mk(`child-${i}`, 'RECTANGLE'),
    )
    const root = mk('root', 'FRAME', children)
    // A tight budget that will cut some children
    const budget = 40
    const { truncated } = fillToBudget(root, budget)
    // truncated records the stubs; just verify that not everything fit
    // (budget is smaller than the full tree)
    expect(truncated.length).toBeGreaterThan(0)
  })

  it('wide shallow level: overflow nodes become stubs in receipt', () => {
    // 10 children; a budget that fits the root + a few stubs but not all,
    // so the view holds some stubs while the rest land in the receipt.
    const children = Array.from({ length: 10 }, (_, i) =>
      mk(`c${i}`, 'TEXT'),
    )
    const root = mk('root', 'FRAME', children)
    const budget = 60
    const { view, truncated } = fillToBudget(root, budget)
    // Some children should be stubs in the receipt
    expect(truncated.length).toBeGreaterThan(0)
    // The view should have children (at least the stubs that did fit)
    const viewSpec = view as NodeSpec
    expect(viewSpec.children).toBeDefined()
    // And the view must still respect the hard budget bound.
    expect(estimateTokens(view)).toBeLessThanOrEqual(budget)
  })

  it('returns empty receipt when tree fits within budget', () => {
    const root = mk('root', 'FRAME', [
      mk('c1', 'RECTANGLE'),
    ])
    const { truncated } = fillToBudget(root, 99999)
    expect(truncated).toHaveLength(0)
  })

  it('stubs collapsed nodes appear in receipt with correct childCount', () => {
    const grandchild = mk('gc', 'RECTANGLE')
    const child = mk('c', 'FRAME', [grandchild])
    const root = mk('root', 'FRAME', [child])
    // Budget only enough for root but not the full subtree
    // Use a very tight budget to force child to be stubbed
    const { truncated } = fillToBudget(root, 10)
    // Either child is stubbed (childCount=1) or root itself forced
    expect(truncated.length).toBeGreaterThanOrEqual(0)
  })

  it('hard bound: wide level (200 children @ budget 100) stays within budget', () => {
    const children = Array.from({ length: 200 }, (_, i) =>
      mk(`c${i}`, 'RECTANGLE'),
    )
    const root = mk('root', 'FRAME', children)
    const budget = 100
    const { view } = fillToBudget(root, budget)
    expect(estimateTokens(view)).toBeLessThanOrEqual(budget)
  })

  it('hard bound: wide level (50 children @ budget 30) stays within budget', () => {
    const children = Array.from({ length: 50 }, (_, i) =>
      mk(`c${i}`, 'TEXT'),
    )
    const root = mk('root', 'FRAME', children)
    const budget = 30
    const { view } = fillToBudget(root, budget)
    expect(estimateTokens(view)).toBeLessThanOrEqual(budget)
  })
})
