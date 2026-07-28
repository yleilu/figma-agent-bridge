import { describe, it, expect } from 'bun:test'
import { COMMANDS } from '@figma-agent-bridge/shared'
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

  it('takes pageId — set_current_page names its page there', () => {
    // Without this the agent's own page switch comes back as "the user just
    // switched page", long after the command exited.
    expect(harvestIds({ pageId: '0:1' })).toEqual(['0:1'])
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
  type?: string
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

  it('is EMPTY for a PAGE — a page has no geometry, so a write to it moves nothing it contains', () => {
    // The closure is "the set of nodes whose geometry an agent write can move
    // WITHOUT naming them". A page is not a scene node: it has no size, no
    // position and no layout mode, so appending to it, switching to it or
    // cloning it re-flows nothing. Taking `descendants(page)` literally would
    // put EVERY node on the page into reflow() — the same swallow-every-
    // top-level-frame outcome change-feed.md names as the thing the ancestor
    // rule is deliberately narrower than — and under command-keyed retention
    // that would silence the user's drags and resizes page-wide for minutes.
    const leaf = n('1:3')
    const frame = kids(n('1:1'), leaf)
    const page = kids(
      n('0:1', { type: 'PAGE' }),
      frame,
      n('1:2'),
    )
    expect(reflowClosure(asNode(page))).toEqual([])
  })

  it('is EMPTY for the DOCUMENT — its descendants are the whole file', () => {
    const page = kids(n('0:1', { type: 'PAGE' }), n('1:1'))
    const doc = kids(n('0:0', { type: 'DOCUMENT' }), page)
    expect(reflowClosure(asNode(doc))).toEqual([])
  })

  it('does not re-enumerate an ancestor already expanded in this generation', () => {
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

// ── retention ───────────────────────────────────────────────────────────────
// Membership is asked at EVENT time and answered from what is retained THEN.
// Nothing in that question may refer to elapsed time since the event's own
// command — that property is the whole fix.

type Opts = Parameters<typeof createWriteScope>[0]

const clock = () => {
  const c = { t: 0 }
  return c
}

const makeScope = (
  c: { t: number },
  over: Partial<Opts> = {},
) =>
  createWriteScope({
    resolve: () => Promise.resolve(null),
    now: () => c.t,
    ...over,
  })

describe('createWriteScope retention', () => {
  const dispatch = async (
    s: ReturnType<typeof makeScope>,
    command: string,
    params: unknown,
    result: unknown = null,
  ): Promise<void> => {
    const done = await s.enter(command, params)
    done(result)
  }

  it('a READ-ONLY dispatch harvests nothing, but still refcounts', async () => {
    const c = clock()
    const s = makeScope(c)
    const done = await s.enter(COMMANDS.GET_NODE, {
      nodeId: 'a',
    })
    // Reach is what makes this load-bearing: `search` returns hundreds of
    // ids and an `inspect` of a page root folds that page's whole closure.
    expect([...s.touched()]).toEqual([])
    expect(s.inFlight()).toBe(true)
    done({ id: 'b' })
    expect(s.inFlight()).toBe(false)
    expect([...s.touched()]).toEqual([])
  })

  it('an event-causing dispatch keeps its ids INDEFINITELY after exit', async () => {
    // THE regression this whole change exists for. Under the retired
    // SETTLE_MS window these ids were gone 400 ms after exit, so a
    // documentchange deferred past it reported the agent's own write as the
    // user's — measured at 395/1121/1239/1910/2435/3907 ms, once at 49.2 s.
    const c = clock()
    const s = makeScope(c)
    await dispatch(
      s,
      COMMANDS.UPDATE_NODE,
      { nodeId: 'a' },
      { id: 'b' },
    )
    c.t = 60_000 // 150x the retired SETTLE_MS
    expect([...s.touched()].sort()).toEqual(['a', 'b'])
  })

  it('evicts the oldest generation once RETAINED_COMMANDS newer ones exist', async () => {
    const c = clock()
    const s = makeScope(c, { retainedCommands: 4 })
    await dispatch(s, COMMANDS.UPDATE_NODE, {
      nodeId: 'first',
    })
    for (let i = 0; i < 3; i += 1) {
      await dispatch(s, COMMANDS.UPDATE_NODE, {
        nodeId: `n${i}`,
      })
    }
    expect(s.touched().has('first')).toBe(true)
    await dispatch(s, COMMANDS.UPDATE_NODE, {
      nodeId: 'last',
    })
    expect(s.touched().has('first')).toBe(false)
    expect(s.touched().has('last')).toBe(true)
  })

  it('reads do NOT spend the retention count', async () => {
    const c = clock()
    const s = makeScope(c, { retainedCommands: 4 })
    await dispatch(s, COMMANDS.UPDATE_NODE, {
      nodeId: 'first',
    })
    for (let i = 0; i < 100; i += 1) {
      await dispatch(s, COMMANDS.SEARCH, { ids: [`r${i}`] })
    }
    expect(s.touched().has('first')).toBe(true)
    expect(s.touched().has('r99')).toBe(false)
  })

  it('releases the WHOLE retained set once the agent goes idle', async () => {
    // The ceiling exists for HAND-OVER: an agent that builds a screen and
    // stops must not go on claiming nodes while the user refines them.
    const c = clock()
    const s = makeScope(c, { retentionCeilingMs: 1000 })
    await dispatch(s, COMMANDS.UPDATE_NODE, { nodeId: 'a' })
    c.t = 999
    expect(s.touched().has('a')).toBe(true)
    c.t = 1000
    expect([...s.touched()]).toEqual([])
  })

  it('keys the ceiling on IDLE time, never on a generation AGE', async () => {
    // The test that stops the design collapsing back into a wall-clock
    // window with a bigger constant: an agent round-trips through a model
    // between calls, so under an age-based ceiling a WORKING agent's older
    // generations would expire mid-task and the count bound would never
    // bind at all.
    const c = clock()
    const s = makeScope(c, {
      retentionCeilingMs: 1000,
      retainedCommands: 64,
    })
    await dispatch(s, COMMANDS.UPDATE_NODE, { nodeId: 'a' })
    for (let i = 0; i < 10; i += 1) {
      c.t += 500
      await dispatch(s, COMMANDS.UPDATE_NODE, {
        nodeId: `n${i}`,
      })
    }
    expect(c.t).toBe(5000) // 5x the ceiling has elapsed
    expect(s.touched().has('a')).toBe(true)
  })

  it('never fires the ceiling while a dispatch is in flight', async () => {
    const c = clock()
    const s = makeScope(c, {
      retentionCeilingMs: 1000,
      maxDispatchMs: 100_000,
    })
    await dispatch(s, COMMANDS.UPDATE_NODE, { nodeId: 'a' })
    c.t = 10
    await s.enter(COMMANDS.UPDATE_NODE, { nodeId: 'b' })
    c.t = 5000
    expect([...s.touched()].sort()).toEqual(['a', 'b'])
  })

  it('force-seals a dispatch that never settles, KEEPING its ids', async () => {
    const c = clock()
    const s = makeScope(c, { maxDispatchMs: 1000 })
    const done = await s.enter(COMMANDS.UPDATE_NODE, {
      nodeId: 'a',
    })
    c.t = 999
    expect(s.inFlight()).toBe(true)
    c.t = 1000
    expect(s.inFlight()).toBe(false)
    // Sealed, not dropped: a wedge must degrade to a leak, never to a
    // silently-admitted self-write.
    expect(s.touched().has('a')).toBe(true)
    // A later claim opens a FRESH generation and folds into it.
    s.claim(asNode(n('1:1')))
    expect(s.touched().has('1:1')).toBe(true)
    // The late exit of the force-sealed dispatch must not drive the
    // refcount negative — inFlight() would break for the rest of the
    // session.
    expect(() => done(null)).not.toThrow()
    expect(s.inFlight()).toBe(false)
    const again = await s.enter(COMMANDS.UPDATE_NODE, {
      nodeId: 'z',
    })
    expect(s.inFlight()).toBe(true)
    again(null)
    expect(s.inFlight()).toBe(false)
  })

  it('spends exactly ONE generation on a batch of ten ops', async () => {
    const c = clock()
    const s = makeScope(c, { retainedCommands: 4 })
    const outer = await s.enter(COMMANDS.BATCH, { ops: [] })
    for (let i = 0; i < 10; i += 1) {
      await dispatch(s, COMMANDS.UPDATE_NODE, {
        nodeId: `b${i}`,
      })
    }
    outer(null)
    // RETAINED_COMMANDS - 1 later dispatches: if each inner op had opened
    // its own generation only the last few would survive here.
    for (let i = 0; i < 3; i += 1) {
      await dispatch(s, COMMANDS.UPDATE_NODE, {
        nodeId: `later${i}`,
      })
    }
    for (let i = 0; i < 10; i += 1) {
      expect(s.touched().has(`b${i}`)).toBe(true)
    }
  })

  it('merges overlapping dispatches into the open generation', async () => {
    const c = clock()
    const s = makeScope(c, { retainedCommands: 2 })
    const a = await s.enter(COMMANDS.UPDATE_NODE, {
      nodeId: 'a',
    })
    const b = await s.enter(COMMANDS.UPDATE_NODE, {
      nodeId: 'b',
    })
    a(null)
    expect(s.inFlight()).toBe(true) // sealed only at the SECOND exit
    b(null)
    expect(s.inFlight()).toBe(false)
    await dispatch(s, COMMANDS.UPDATE_NODE, { nodeId: 'c' })
    expect(s.touched().has('a')).toBe(true)
    expect(s.touched().has('b')).toBe(true)
    await dispatch(s, COMMANDS.UPDATE_NODE, { nodeId: 'd' })
    // One generation: the two ids leave TOGETHER, never one without the
    // other.
    expect(s.touched().has('a')).toBe(false)
    expect(s.touched().has('b')).toBe(false)
  })

  it('unions touched over every retained generation and the open one', async () => {
    const c = clock()
    const s = makeScope(c)
    await dispatch(s, COMMANDS.UPDATE_NODE, {
      nodeId: 'g1',
    })
    await dispatch(s, COMMANDS.UPDATE_NODE, {
      nodeId: 'g2',
    })
    await s.enter(COMMANDS.UPDATE_NODE, { nodeId: 'g3' })
    expect([...s.touched()].sort()).toEqual([
      'g1',
      'g2',
      'g3',
    ])
  })

  it('opens a generation for a claim that arrives with none open', () => {
    const c = clock()
    const s = makeScope(c)
    s.claim(asNode(n('1:1')))
    expect(s.touched().has('1:1')).toBe(true)
  })

  it('re-walks a closure PER GENERATION, so evicting the first loses nothing', async () => {
    // H1. If `folded` / `expanded` were module-global, the SECOND dispatch
    // naming 1:1 would skip the walk, and evicting the first generation
    // would silently drop that closure while the id is still touched.
    const c = clock()
    const leaf = n('1:1')
    kids(n('1:9', HUG), leaf, n('1:2'))
    const s = makeScope(c, {
      retainedCommands: 2,
      resolve: id =>
        Promise.resolve(id === '1:1' ? asNode(leaf) : null),
    })
    await dispatch(s, COMMANDS.UPDATE_NODE, {
      nodeId: '1:1',
    })
    await dispatch(s, COMMANDS.UPDATE_NODE, {
      nodeId: '1:1',
    })
    // Evicts the FIRST generation.
    await dispatch(s, COMMANDS.UPDATE_NODE, {
      nodeId: '2:2',
    })
    expect(s.touched().has('1:1')).toBe(true)
    expect([...s.reflow()].sort()).toEqual([
      '1:1',
      '1:2',
      '1:9',
    ])
  })

  it('a page id is TOUCHED without the page being dragged into reflow', async () => {
    // `pageId` is a harvest key (set_current_page's page must reach touched()
    // or the agent's own switch comes back as the user's), but the page's
    // CONTENTS must not ride in with it: a top-level frame the agent never
    // named would then have its cascade props subtracted to empty and the
    // user's drag dropped, for up to RETAINED_COMMANDS dispatches.
    const c = clock()
    const page = kids(
      n('0:1', { type: 'PAGE' }),
      kids(n('1:1'), n('1:3')),
      n('1:2'),
    )
    const s = makeScope(c, {
      resolve: id =>
        Promise.resolve(id === '0:1' ? asNode(page) : null),
    })
    await dispatch(s, COMMANDS.SET_CURRENT_PAGE, {
      pageId: '0:1',
    })
    expect(s.touched().has('0:1')).toBe(true)
    expect([...s.reflow()]).toEqual([])
  })

  it('claim of a cloned PAGE does not drag its contents into reflow', async () => {
    // duplicate_page claims the CLONE, whose descendants are all new nodes.
    // Their creates are kept by the reflow row anyway (create/delete → keep),
    // so the closure buys nothing there and costs the whole page.
    const c = clock()
    const dup = kids(n('0:2', { type: 'PAGE' }), n('2:1'))
    const s = makeScope(c)
    await s.enter(COMMANDS.DUPLICATE_PAGE, {})
    s.claim(asNode(dup))
    expect(s.touched().has('0:2')).toBe(true)
    expect([...s.reflow()]).toEqual([])
  })

  it('a BATCH harvests nothing at its OUTER entry — its ops harvest themselves', async () => {
    // The outer params are {ops:[…]} and the outer return is the per-op
    // results, and `harvestIds` walks both at any depth. Folding them here
    // would put every op's ids into the generation under `batch`'s blanket
    // event-causing classification, so a READ op inside a batch would have
    // exactly the reach the read-only rule exists to refuse.
    const c = clock()
    const s = makeScope(c)
    const outer = await s.enter(COMMANDS.BATCH, {
      ops: [
        {
          op: COMMANDS.INSPECT,
          params: { pageId: '0:1' },
        },
        {
          op: COMMANDS.UPDATE_NODE,
          params: { nodeId: '1:1' },
        },
      ],
    })
    expect([...s.touched()]).toEqual([])
    // The nested enters decide, each under its OWN classification.
    await dispatch(s, COMMANDS.INSPECT, { pageId: '0:1' })
    await dispatch(s, COMMANDS.UPDATE_NODE, {
      nodeId: '1:1',
    })
    expect([...s.touched()]).toEqual(['1:1'])
    outer({
      results: [
        { ok: true, result: { id: '0:1' } },
        { ok: true, result: { id: '1:1' } },
      ],
    })
    expect(s.touched().has('0:1')).toBe(false)
  })

  it('a BATCH still spends exactly one generation with the outer harvest gone', async () => {
    const c = clock()
    const s = makeScope(c, { retainedCommands: 2 })
    const outer = await s.enter(COMMANDS.BATCH, { ops: [] })
    await dispatch(s, COMMANDS.UPDATE_NODE, {
      nodeId: 'b0',
    })
    await dispatch(s, COMMANDS.UPDATE_NODE, {
      nodeId: 'b1',
    })
    outer(null)
    await dispatch(s, COMMANDS.UPDATE_NODE, { nodeId: 'x' })
    expect(s.touched().has('b0')).toBe(true)
    expect(s.touched().has('b1')).toBe(true)
  })

  it('returns a ONE-SHOT disposer', async () => {
    const c = clock()
    const s = makeScope(c)
    const done = await s.enter(COMMANDS.UPDATE_NODE, {
      nodeId: 'a',
    })
    done({ id: 'b' })
    expect(s.touched().has('b')).toBe(true)
    done({ id: 'c' }) // a second call is a no-op
    expect(s.touched().has('c')).toBe(false)
    expect(s.inFlight()).toBe(false)
  })
})

describe('createWriteScope closure capture', () => {
  it('claim folds the node into touched AND its closure into reflow', async () => {
    const leaf = n('1:1')
    kids(n('1:9', HUG), leaf, n('1:2'))
    const s = createWriteScope({
      resolve: () => Promise.resolve(null),
    })
    await s.enter(COMMANDS.UPDATE_NODE, {})
    s.claim(asNode(leaf))
    expect(s.touched().has('1:1')).toBe(true)
    expect([...s.reflow()].sort()).toEqual([
      '1:1',
      '1:2',
      '1:9',
    ])
  })

  it('computes a closure for an id first seen at exit', async () => {
    const c = clock()
    const leaf = n('1:1')
    kids(n('1:9', HUG), leaf, n('1:2'))
    const s = makeScope(c, {
      resolve: id =>
        Promise.resolve(id === '1:1' ? asNode(leaf) : null),
    })
    await s.enter(COMMANDS.UPDATE_NODE, {})
    s.exit({ id: '1:1' })
    await s.enter(COMMANDS.UPDATE_NODE, { nodeId: '1:1' })
    expect([...s.reflow()].sort()).toEqual([
      '1:1',
      '1:2',
      '1:9',
    ])
  })

  it('survives a resolve that rejects', async () => {
    const c = clock()
    const s = makeScope(c, {
      resolve: () => Promise.reject(new Error('boom')),
    })
    const done = await s.enter(COMMANDS.UPDATE_NODE, {
      nodeId: '1:2',
    })
    expect(s.touched().has('1:2')).toBe(true)
    expect(s.reflow().size).toBe(0)
    done(null)
    expect(s.inFlight()).toBe(false)
  })

  // A Figma node REMOVED between `resolve` and the walk throws on every
  // accessor, and the walk reads `.children` / `.parent` on live nodes. Both
  // call sites now sit in the command path — `claim` inside the handlers,
  // `fold` inside `enter` — so an unguarded throw fails the user's command or,
  // worse, rejects `enter` and leaves the dispatch with no command-result at
  // all. Capturing the closure must never break the command it is watching.
  const throwingNode = (id: string): Node =>
    ({
      id,
      get children(): never {
        throw new Error('node removed')
      },
      get parent(): never {
        throw new Error('node removed')
      },
    }) as unknown as Node

  it('claim survives a closure walk that throws', async () => {
    const s = createWriteScope({
      resolve: () => Promise.resolve(null),
    })
    await s.enter(COMMANDS.UPDATE_NODE, {})
    expect(() => s.claim(throwingNode('1:1'))).not.toThrow()
    // The TOUCHED half still lands: it is the stronger suppression, and it
    // costs nothing to record.
    expect(s.touched().has('1:1')).toBe(true)
    expect(s.reflow().size).toBe(0)
  })

  it('enter RESOLVES when the closure walk throws', async () => {
    const c = clock()
    const s = makeScope(c, {
      resolve: id => Promise.resolve(throwingNode(id)),
    })
    const done = await s.enter(COMMANDS.UPDATE_NODE, {
      nodeId: '1:2',
    })
    expect(s.touched().has('1:2')).toBe(true)
    expect(s.reflow().size).toBe(0)
    done(null)
    expect(s.inFlight()).toBe(false)
  })

  it('never hands resolve an id that is not a plain node id', async () => {
    const seen: string[] = []
    const s = createWriteScope({
      resolve: id => {
        seen.push(id)
        return Promise.resolve(null)
      },
    })
    await s.enter(COMMANDS.UPDATE_NODE, {
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
