import { describe, it, expect } from 'bun:test'
import {
  harvestIds,
  createWriteScope,
  reflowClosure,
  MAX_CLOSURE_NODES,
} from './write-scope'

describe('harvestIds', () => {
  it('takes strings under id-ish keys at any depth', () => {
    expect(
      harvestIds({
        nodeId: 'a',
        deep: { parentId: 'b', ids: ['c', 'd'] },
        results: [{ id: 'e' }, { id: 'f' }],
      }).sort(),
    ).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('ignores strings under non-id keys', () => {
    expect(harvestIds({ name: 'x', text: 'y' })).toEqual([])
  })
})

// ── a fake scene graph ──────────────────────────────────────────────────────
// reflowClosure/hugs read only {id, parent, children, layoutMode,
// layoutSizing*, primaryAxis/counterAxisSizingMode}, so object literals
// exercise the real breadth judgement without a Figma runtime.
type Fake = {
  id: string
  parent: Fake | null
  children?: Fake[]
  layoutMode?: string
  layoutSizingHorizontal?: string
  layoutSizingVertical?: string
  primaryAxisSizingMode?: string
  counterAxisSizingMode?: string
}

type Node = Parameters<typeof reflowClosure>[0]

const n = (
  id: string,
  extra: Partial<Fake> = {},
): Fake => ({ id, parent: null, ...extra })

const kids = (p: Fake, ...cs: Fake[]): Fake => {
  p.children = cs
  for (const c of cs) c.parent = p
  return p
}

const asNode = (f: Fake): Node => f as unknown as Node

const HUG: Partial<Fake> = {
  layoutMode: 'VERTICAL',
  layoutSizingHorizontal: 'FIXED',
  layoutSizingVertical: 'HUG',
}

const FIXED: Partial<Fake> = {
  layoutMode: 'VERTICAL',
  layoutSizingHorizontal: 'FIXED',
  layoutSizingVertical: 'FIXED',
}

describe('reflowClosure', () => {
  it('includes every descendant and not the node itself', () => {
    const leaf = n('1:3')
    const mid = kids(n('1:2'), leaf)
    const root = kids(n('1:1'), mid)
    expect(reflowClosure(asNode(root)).sort()).toEqual([
      '1:2',
      '1:3',
    ])
  })

  it('adds nothing above a parent that is not auto-layout', () => {
    const a = n('1:1')
    kids(n('1:9'), a, n('1:2'))
    expect(reflowClosure(asNode(a))).toEqual([])
  })

  it("adds a FIXED auto-layout parent's children — it re-flows them even though it cannot itself grow", () => {
    const a = n('1:1')
    const p = kids(n('1:9', FIXED), a, n('1:2'), n('1:3'))
    kids(n('1:8', HUG), p, n('1:7'))
    const out = reflowClosure(asNode(a))
    expect(out.sort()).toEqual(['1:1', '1:2', '1:3'])
  })

  it('stops the upward walk at that FIXED parent — nothing above it moves', () => {
    const a = n('1:1')
    const p = kids(n('1:9', FIXED), a, n('1:2'))
    kids(n('1:8', HUG), p, n('1:7'))
    const out = new Set(reflowClosure(asNode(a)))
    expect(out.has('1:9')).toBe(false)
    expect(out.has('1:8')).toBe(false)
    expect(out.has('1:7')).toBe(false)
  })

  it('walks a hugging chain three deep, adding each level and its children', () => {
    const leaf = n('1:1')
    const p = kids(n('1:2', HUG), leaf, n('1:3'))
    const g = kids(n('1:4', HUG), p, n('1:5'))
    kids(n('1:6', HUG), g, n('1:7'))
    expect(reflowClosure(asNode(leaf)).sort()).toEqual([
      '1:1',
      '1:2',
      '1:3',
      '1:4',
      '1:5',
      '1:6',
      '1:7',
    ])
  })

  it('reads HUG on a GRID frame, where primaryAxisSizingMode does not apply', () => {
    const a = n('1:1')
    const p = kids(
      n('1:9', {
        layoutMode: 'GRID',
        layoutSizingVertical: 'HUG',
      }),
      a,
      n('1:2'),
    )
    kids(n('1:8', HUG), p, n('1:7'))
    const out = new Set(reflowClosure(asNode(a)))
    expect(out.has('1:9')).toBe(true)
    expect(out.has('1:8')).toBe(true) // the walk continued past the GRID
    expect(out.has('1:7')).toBe(true)
  })

  it('falls back to the axis sizing modes when layoutSizing* is absent', () => {
    const a = n('1:1')
    kids(
      n('1:9', {
        layoutMode: 'VERTICAL',
        primaryAxisSizingMode: 'AUTO',
        counterAxisSizingMode: 'FIXED',
      }),
      a,
      n('1:2'),
    )
    expect(reflowClosure(asNode(a)).sort()).toEqual([
      '1:1',
      '1:2',
      '1:9',
    ])
  })

  it('truncates at exactly MAX_CLOSURE_NODES', () => {
    const many = Array.from(
      { length: MAX_CLOSURE_NODES + 10 },
      (_, i) => n(`1:${i}`),
    )
    const p = kids(n('9:9'), ...many)
    expect(reflowClosure(asNode(p)).length).toBe(
      MAX_CLOSURE_NODES,
    )
  })

  it('does not re-enumerate an ancestor already expanded in this window', () => {
    let reads = 0
    const a = n('1:1')
    const b = n('1:2')
    const p = n('1:9', FIXED)
    Object.defineProperty(p, 'children', {
      get() {
        reads += 1
        return [a, b]
      },
    })
    a.parent = p
    b.parent = p
    const expanded = new Set<string>()
    reflowClosure(asNode(a), expanded)
    const second = reflowClosure(asNode(b), expanded)
    expect(reads).toBe(1)
    expect(second).toEqual([])
  })
})

describe('createWriteScope window', () => {
  it('stays open for settleMs after the outermost exit', () => {
    let t = 0
    const s = createWriteScope({
      settleMs: 100,
      resolve: () => Promise.resolve(null),
      now: () => t,
    })
    expect(s.isOpen()).toBe(false)
    void s.enter({ nodeId: 'n1' })
    expect(s.isOpen()).toBe(true)
    s.exit({ id: 'n1' })
    t = 99
    expect(s.isOpen()).toBe(true)
    t = 100
    expect(s.isOpen()).toBe(false)
  })

  it('is refcounted: a nested batch never closes mid-run', () => {
    let t = 0
    const s = createWriteScope({
      settleMs: 100,
      resolve: () => Promise.resolve(null),
      now: () => t,
    })
    void s.enter({ ops: [] })
    void s.enter({ nodeId: 'a' })
    s.exit({})
    t = 500
    expect(s.isOpen()).toBe(true) // outer still open
    s.exit({})
    expect(s.isOpen()).toBe(true) // settle window
    t = 601
    expect(s.isOpen()).toBe(false)
  })

  it('accumulates touched ids across a batch and resets on reopen', async () => {
    let t = 0
    const s = createWriteScope({
      settleMs: 10,
      resolve: () => Promise.resolve(null),
      now: () => t,
    })
    await s.enter({ nodeId: 'a' })
    await s.enter({ nodeId: 'b' })
    s.exit({})
    s.exit({ id: 'c' })
    expect([...s.touched()].sort()).toEqual(['a', 'b', 'c'])
    t = 100
    await s.enter({ nodeId: 'z' })
    expect([...s.touched()]).toEqual(['z'])
  })

  it('returns a one-shot disposer that closes the window', async () => {
    let t = 0
    const s = createWriteScope({
      settleMs: 100,
      resolve: () => Promise.resolve(null),
      now: () => t,
    })
    const done = await s.enter({ nodeId: 'a' })
    done({ id: 'b' })
    expect(s.touched().has('b')).toBe(true)
    done({ id: 'c' }) // a second call is a no-op
    expect(s.touched().has('c')).toBe(false)
    t = 99
    expect(s.isOpen()).toBe(true)
    t = 100
    expect(s.isOpen()).toBe(false)
  })

  it('self-heals when a command enters and never exits', async () => {
    let t = 0
    const s = createWriteScope({
      settleMs: 100,
      maxOpenMs: 1000,
      resolve: () => Promise.resolve(null),
      now: () => t,
    })
    await s.enter({ nodeId: 'a' })
    t = 999
    expect(s.isOpen()).toBe(true)
    t = 1000
    expect(s.isOpen()).toBe(false)
    await s.enter({ nodeId: 'b' })
    expect([...s.touched()]).toEqual(['b'])
  })
})

describe('createWriteScope closure capture', () => {
  it('claim folds the node into touched AND its closure into reflow', async () => {
    const leaf = n('1:1')
    kids(n('1:9', HUG), leaf, n('1:2'))
    const s = createWriteScope({
      settleMs: 10,
      resolve: () => Promise.resolve(null),
    })
    await s.enter({})
    s.claim(asNode(leaf))
    expect(s.touched().has('1:1')).toBe(true)
    expect([...s.reflow()].sort()).toEqual([
      '1:1',
      '1:2',
      '1:9',
    ])
  })

  it('computes a closure for an id first seen at exit', async () => {
    let t = 0
    const leaf = n('1:1')
    kids(n('1:9', HUG), leaf, n('1:2'))
    const s = createWriteScope({
      settleMs: 1000,
      resolve: id =>
        Promise.resolve(id === '1:1' ? asNode(leaf) : null),
      now: () => t,
    })
    await s.enter({})
    s.exit({ id: '1:1' })
    await s.enter({ nodeId: '1:1' })
    expect([...s.reflow()].sort()).toEqual([
      '1:1',
      '1:2',
      '1:9',
    ])
  })

  it('survives a resolve that rejects, without wedging the window', async () => {
    let t = 0
    const s = createWriteScope({
      settleMs: 10,
      resolve: () => Promise.reject(new Error('boom')),
      now: () => t,
    })
    await s.enter({ nodeId: '1:2' })
    expect(s.touched().has('1:2')).toBe(true)
    expect(s.reflow().size).toBe(0)
    s.exit({})
    t = 10
    expect(s.isOpen()).toBe(false)
  })

  it('never hands resolve an id that is not a plain node id', async () => {
    const seen: string[] = []
    const s = createWriteScope({
      settleMs: 10,
      resolve: id => {
        seen.push(id)
        return Promise.resolve(null)
      },
    })
    await s.enter({
      parentId: 'I1:2;3:4', // compound instance child — HANGS the real API
      ids: ['S:5', 'VariableID:6:7'],
      nodeId: '1:2',
    })
    expect(seen).toEqual(['1:2'])
    // …but every one of them is still TOUCHED.
    expect([...s.touched()].sort()).toEqual([
      '1:2',
      'I1:2;3:4',
      'S:5',
      'VariableID:6:7',
    ])
  })
})
