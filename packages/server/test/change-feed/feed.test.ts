import { describe, it, expect } from 'bun:test'
import { ChangeFeed } from '@figma-agent-bridge/server/change-feed/feed'

const push = (
  changes: unknown[],
  over: Record<string, unknown> = {},
) => ({
  changes,
  indexStale: false,
  at: 1,
  ...over,
})

describe('ChangeFeed baseline lifecycle', () => {
  it('opens EMPTY with no_baseline and seeds the epoch', () => {
    const f = new ChangeFeed()
    f.openBaseline('fk', 'e1')
    expect(f.drain('fk', 100)).toEqual({
      changes: [],
      truncated: false,
      state: 'no_baseline',
    })
  })

  it('clears to ok only on a drain that empties AND is anchored', () => {
    const f = new ChangeFeed()
    f.openBaseline('fk', 'e1')
    f.drain('fk', 100) // no_baseline
    expect(f.drain('fk', 100)?.state).toBe('ok')
  })

  it('NEVER reports ok while the epoch is null, however many drains', () => {
    const f = new ChangeFeed()
    f.openBaseline('fk', null)
    f.drain('fk', 100)
    expect(f.drain('fk', 100)?.state).toBe('no_baseline')
  })

  it('re-opening a baseline PRESERVES the buffer and its state', () => {
    const f = new ChangeFeed()
    f.openBaseline('fk', 'e1')
    f.ingest('fk', push([{ op: 'create', id: 'n1' }]), {
      epoch: 'e1',
      seq: 0,
    })
    f.markGap('fk')
    f.openBaseline('fk', 'e1')
    const out = f.drain('fk', 100)
    expect(out?.state).toBe('gap')
    expect(out?.changes).toHaveLength(1)
  })

  // The LATE-JOINER half of the reconnect arm. The in-band half (a push whose
  // meta.epoch differs) cannot fire here: the server was not in the channel to
  // receive the new connection's opening flush, and if the user then stops
  // editing NO push ever arrives — leaving `{0, ok}` on disk over edits the
  // server provably never saw.
  it('a re-join under a DIFFERENT registry epoch arms gap', () => {
    const reasons: string[] = []
    const f = new ChangeFeed((_b, reason) => {
      reasons.push(reason)
    })
    f.openBaseline('fk', 'e1')
    f.markAllGap() // the server socket dropped
    f.drain('fk', 100) // the agent drains while disconnected…
    expect(f.drain('fk', 100)?.state).toBe('ok') // …clearing to ok
    reasons.length = 0

    f.openBaseline('fk', 'e2') // re-join; the plugin restarted meanwhile
    expect(reasons).toEqual(['arm'])
    expect(f.drain('fk', 100)?.state).toBe('gap')
  })

  it('SEEDS an epoch onto a null-epoch buffer without arming', () => {
    const reasons: string[] = []
    const f = new ChangeFeed((_b, reason) => {
      reasons.push(reason)
    })
    f.openBaseline('fk', null)
    reasons.length = 0
    // Nothing to lose: the buffer never claimed a connection, so learning one
    // is not a hole — it is the anchor it was missing.
    f.openBaseline('fk', 'e1')
    expect(reasons).toEqual([])
    f.drain('fk', 100)
    expect(f.drain('fk', 100)?.state).toBe('ok')
  })

  it('a re-join with NO registry epoch leaves the buffer alone', () => {
    const f = new ChangeFeed()
    f.openBaseline('fk', 'e1')
    f.drain('fk', 100)
    f.openBaseline('fk', null)
    expect(f.drain('fk', 100)?.state).toBe('ok')
  })
})

describe('ChangeFeed gap arms', () => {
  it('a CHANGED epoch is a reconnect → gap', () => {
    const f = new ChangeFeed()
    f.openBaseline('fk', 'e1')
    f.drain('fk', 100)
    f.ingest('fk', push([]), { epoch: 'e2', seq: 0 })
    expect(f.drain('fk', 100)?.state).toBe('gap')
  })

  it('a seq GAP on the same epoch → gap', () => {
    const f = new ChangeFeed()
    f.openBaseline('fk', 'e1')
    f.ingest('fk', push([]), { epoch: 'e1', seq: 0 })
    f.drain('fk', 100)
    f.ingest('fk', push([{ op: 'update', id: 'n1' }]), {
      epoch: 'e1',
      seq: 3,
    })
    expect(f.drain('fk', 100)?.state).toBe('gap')
  })

  it('CONTIGUOUS seq does NOT arm gap', () => {
    const f = new ChangeFeed()
    f.openBaseline('fk', 'e1')
    f.ingest('fk', push([]), { epoch: 'e1', seq: 0 })
    f.ingest('fk', push([]), { epoch: 'e1', seq: 1 })
    f.drain('fk', 100)
    expect(f.drain('fk', 100)?.state).toBe('ok')
  })

  it('params.overflow → gap', () => {
    const f = new ChangeFeed()
    f.openBaseline('fk', 'e1')
    f.ingest('fk', push([], { overflow: true }), {
      epoch: 'e1',
      seq: 0,
    })
    expect(f.drain('fk', 100)?.state).toBe('gap')
  })

  // The relay forwards `params` as a FREE record and validates only `meta`, so
  // a non-conforming plugin build reaches this unvalidated. A synchronous throw
  // here escapes the socket message handler entirely (the dispatch evaluates
  // the handler INSIDE Promise.resolve(...), so no .catch sees it).
  it('a frame with NO changes array arms gap instead of throwing', () => {
    const f = new ChangeFeed()
    f.openBaseline('fk', 'e1')
    f.drain('fk', 100)
    expect(f.drain('fk', 100)?.state).toBe('ok')
    expect(() => {
      f.ingest(
        'fk',
        { indexStale: false, at: 0 } as never,
        { epoch: 'e1', seq: 1 },
      )
    }).not.toThrow()
    // Evidence of loss, never a no-op: a frame the server cannot parse says
    // records were carried in a shape it could not read.
    expect(f.drain('fk', 100)?.state).toBe('gap')
  })

  it('a malformed RECORD is skipped and arms gap, keeping its neighbours', () => {
    const f = new ChangeFeed()
    f.openBaseline('fk', 'e1')
    f.ingest(
      'fk',
      push([null, { op: 'create', id: 'n1' }, 'nope']),
      { epoch: 'e1', seq: 0 },
    )
    const out = f.drain('fk', 100)
    expect(out?.state).toBe('gap')
    expect(out?.changes.map(c => c.id)).toEqual(['n1'])
  })

  it('markAllGap arms EVERY open buffer (socket close)', () => {
    const f = new ChangeFeed()
    f.openBaseline('a', 'e')
    f.openBaseline('b', 'e')
    f.drain('a', 100)
    f.drain('b', 100)
    f.markAllGap()
    expect(f.drain('a', 100)?.state).toBe('gap')
    expect(f.drain('b', 100)?.state).toBe('gap')
  })

  it('BUFFER_CAP eviction arms gap', () => {
    const f = new ChangeFeed(() => undefined, 2)
    f.openBaseline('fk', 'e1')
    f.ingest(
      'fk',
      push([
        { op: 'create', id: 'n1' },
        { op: 'create', id: 'n2' },
        { op: 'create', id: 'n3' },
      ]),
      { epoch: 'e1', seq: 0 },
    )
    const out = f.drain('fk', 100)
    expect(out?.state).toBe('gap')
    expect(out?.changes.map(c => c.id)).toEqual([
      'n2',
      'n3',
    ])
  })
})

describe('ChangeFeed drain', () => {
  it('counts DISTINCT things, not actions; slots never count', () => {
    const f = new ChangeFeed()
    f.openBaseline('fk', 'e1')
    f.ingest(
      'fk',
      push([
        { op: 'update', id: 'n1', props: ['x'] },
        { op: 'update', id: 'n1', props: ['y'] },
        { op: 'page', id: 'p1' },
        { op: 'select', ids: ['n1'] },
      ]),
      { epoch: 'e1', seq: 0 },
    )
    expect(f.pendingCount('fk')).toBe(1)
  })

  it('removes EXACTLY what it returned and truncates in order', () => {
    const f = new ChangeFeed()
    f.openBaseline('fk', 'e1')
    f.ingest(
      'fk',
      push([
        { op: 'create', id: 'n1' },
        { op: 'create', id: 'n2' },
        { op: 'style_create', id: 'S:1' },
        { op: 'select', ids: [] },
      ]),
      { epoch: 'e1', seq: 0 },
    )
    const first = f.drain('fk', 2)
    expect(first?.truncated).toBe(true)
    expect(first?.changes.map(c => c.id)).toEqual([
      'n1',
      'n2',
    ])
    const second = f.drain('fk', 100)
    expect(second?.truncated).toBe(false)
    expect(second?.changes.map(c => c.op)).toEqual([
      'style_create',
      'select',
    ])
  })

  it('a truncated drain can NEVER downgrade gap to ok', () => {
    const f = new ChangeFeed()
    f.openBaseline('fk', 'e1')
    f.ingest(
      'fk',
      push(
        [
          { op: 'create', id: 'n1' },
          { op: 'create', id: 'n2' },
        ],
        { overflow: true },
      ),
      { epoch: 'e1', seq: 0 },
    )
    expect(f.drain('fk', 1)?.state).toBe('gap')
    expect(f.drain('fk', 1)?.state).toBe('gap')
    expect(f.drain('fk', 1)?.state).toBe('ok')
  })

  it('returns null for a fileKey with NO buffer, and creates none', () => {
    const f = new ChangeFeed()
    expect(f.drain('nope', 100)).toBe(null)
    expect(f.has('nope')).toBe(false)
  })
})

// ── Runs, subtraction and shadows ───────────────────────────────────────────
// A frame carrying `writers[]` and per-record masks, ingested by a server whose
// own writer is named in it. The masks are SYNTHETIC here — the plugin does not
// emit them until the wire cut — which is exactly what lets the buffer's half be
// tested ahead of it.

const asA = (over: Record<string, unknown> = {}) =>
  new ChangeFeed(() => undefined, 2000, {
    writer: () => 'A',
    ...over,
  })

const A = 1
const B = 2
const WRITERS = ['A', 'B']

const feedFrom = (
  f: ChangeFeed,
  changes: unknown[],
  seq = 0,
) => {
  f.ingest(
    'fk',
    push(changes, { writers: WRITERS }) as never,
    { epoch: 'e1', seq },
  )
}

describe('ChangeFeed subtraction at ingest', () => {
  it('THE WORKED FAILURE: A writes x, B overwrites it', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      {
        op: 'update',
        id: 'n1',
        props: ['x'],
        set: { x: 10 },
        by: A,
      },
    ])
    // A's own write is not a pending change to A.
    expect(f.pendingCount('fk')).toBe(0)
    feedFrom(
      f,
      [
        {
          op: 'update',
          id: 'n1',
          props: ['x'],
          set: { x: 20 },
          by: B,
        },
      ],
      1,
    )
    expect(f.pendingCount('fk')).toBe(1)
    expect(f.drain('fk', 100)?.changes).toEqual([
      {
        id: 'n1',
        op: 'update',
        props: ['x'],
        set: { x: 20 },
        src: 'agent',
        mine: ['x'],
      },
    ])
  })

  it('THE MIRROR: a foreign change on a property this session did NOT write', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      {
        op: 'update',
        id: 'n1',
        props: ['x'],
        set: { x: 10 },
        by: A,
      },
      {
        op: 'update',
        id: 'n1',
        props: ['y'],
        set: { y: 5 },
        by: B,
      },
    ])
    const [rec] = f.drain('fk', 100)?.changes ?? []
    expect(rec?.props).toEqual(['y'])
    expect(rec?.set).toEqual({ y: 5 })
    // `x` is absent from props, from set AND from the narrowed `mine`.
    expect(rec?.mine).toBeUndefined()
  })

  it('a session sees NONE of its own work, however much of it there is', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(
      f,
      Array.from({ length: 50 }, (_, i) => ({
        op: 'create',
        id: `n${i}`,
        by: A,
      })),
    )
    expect(f.pendingCount('fk')).toBe(0)
    expect(f.drain('fk', 100)?.changes).toEqual([])
    expect(f.drain('fk', 100)?.state).toBe('ok')
  })

  it('a shadow is invisible to pendingCount, to changes[] and to `state`', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      { op: 'update', id: 'n1', props: ['x'], by: A },
      { op: 'update', id: 'n2', props: ['y'] },
    ])
    expect(f.pendingCount('fk')).toBe(1)
    const out = f.drain('fk', 100)
    expect(out?.changes.map(c => c.id)).toEqual(['n2'])
    // The shadow SURVIVED the drain and did not hold the state open.
    expect(out?.state).toBe('no_baseline')
    expect(f.drain('fk', 100)?.state).toBe('ok')
    expect(f.pendingCount('fk')).toBe(0)
    // …and it still answers a later foreign change on the same id.
    feedFrom(
      f,
      [
        {
          op: 'update',
          id: 'n1',
          props: ['x'],
          set: { x: 3 },
          by: B,
        },
      ],
      1,
    )
    expect(f.drain('fk', 100)?.changes[0]?.mine).toEqual([
      'x',
    ])
  })

  it('THE CASCADE CELL: a user rename survives an agent cascade on the same record', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      {
        op: 'update',
        id: 'n1',
        props: ['name', 'y'],
        set: { name: 'Renamed', y: 40 },
        rf: A,
      },
    ])
    // In the RUNS view the subtracted name is visible as this session's own.
    expect(f.drain('fk', 100, 'runs')?.changes).toEqual([
      {
        id: 'n1',
        mine: ['y'],
        runs: [
          {
            op: 'update',
            props: ['name'],
            set: { name: 'Renamed' },
          },
          { src: 'self', mine: ['y'] },
        ],
      },
    ])
  })

  it('…and the FOLDED view narrows `y` away — the record does not report on it', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      {
        op: 'update',
        id: 'n1',
        props: ['name', 'y'],
        set: { name: 'Renamed', y: 40 },
        rf: A,
      },
    ])
    expect(f.drain('fk', 100)?.changes).toEqual([
      {
        id: 'n1',
        op: 'update',
        props: ['name'],
        set: { name: 'Renamed' },
      },
    ])
  })

  it('ANOTHER WRITER in `by` keeps the record whole, cascade bit or not', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      {
        op: 'update',
        id: 'n1',
        props: ['x', 'y'],
        set: { x: 1, y: 2 },
        by: B,
        rf: A,
      },
    ])
    const [rec] = f.drain('fk', 100)?.changes ?? []
    expect(rec?.props).toEqual(['x', 'y'])
    expect(rec?.src).toBe('agent')
  })

  it('create → delete NEVER cancels across a writer change', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      { op: 'create', id: 'n1', by: A, type: 'FRAME' },
      { op: 'delete', id: 'n1', by: B, type: 'FRAME' },
    ])
    expect(f.drain('fk', 100)?.changes).toEqual([
      {
        id: 'n1',
        type: 'FRAME',
        op: 'delete',
        src: 'agent',
        mine: ['create'],
      },
    ])
  })

  it('…and the MIRROR is silence: this session deleted what another created', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      { op: 'create', id: 'n1', by: B },
      { op: 'delete', id: 'n1', by: A },
    ])
    expect(f.pendingCount('fk')).toBe(0)
    expect(f.drain('fk', 100)?.changes).toEqual([])
  })

  // An update naming NO property is not a change this feed can represent: the
  // folded drain returns nothing for it and deletes the entry, while
  // `pendingCount` had already counted it. Over-reporting is the accepted fail
  // direction, but a count that cannot be reconciled with the drain it points
  // at is avoidable — and the spec's reconciliation promise (`total` after a
  // drain equals the block's `pending_edits`) should hold by construction.
  it('an update naming NO properties never enters the buffer', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      { op: 'update', id: 'n1', props: [] },
      { op: 'style_update', id: 'S:k,1:8', props: [] },
      { op: 'update', id: 'n2', props: ['x'] },
    ])
    expect(f.pendingCount('fk')).toBe(1)
    const out = f.drain('fk', 100)
    expect(out?.changes.map(c => c.id)).toEqual(['n2'])
    expect(f.pendingCount('fk')).toBe(0)
  })

  it('the PAGE slot rides membership; the SELECT slot rides nothing', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      { op: 'page', id: 'p1', name: 'Mine', by: A },
      { op: 'select', ids: ['n1'] },
    ])
    const { changes = [] } = f.drain('fk', 100) ?? {}
    expect(changes.map(c => c.op)).toEqual(['select'])
    feedFrom(
      f,
      [{ op: 'page', id: 'p2', name: 'Theirs', by: B }],
      1,
    )
    expect(f.drain('fk', 100)?.changes).toEqual([
      { op: 'page', id: 'p2', name: 'Theirs' },
    ])
  })

  it('a server whose writer the table does not name subtracts NOTHING', () => {
    const f = new ChangeFeed(() => undefined, 2000, {
      writer: () => 'C',
    })
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      { op: 'update', id: 'n1', props: ['x'], by: A },
      {
        op: 'update',
        id: 'n2',
        props: ['y'],
        by: B,
        rf: A,
      },
    ])
    expect(f.pendingCount('fk')).toBe(2)
  })

  it('detail:"runs" shows the alternation the folded view collapses', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      {
        op: 'update',
        id: 'n1',
        props: ['x'],
        set: { x: 10 },
        by: A,
      },
      {
        op: 'update',
        id: 'n1',
        props: ['x'],
        set: { x: 20 },
        by: B,
      },
      {
        op: 'update',
        id: 'n1',
        props: ['y'],
        set: { y: 30 },
        by: A,
      },
      {
        op: 'update',
        id: 'n1',
        props: ['y'],
        set: { y: 40 },
        by: B,
      },
    ])
    const out = f.drain('fk', 100, 'runs')
    // Without the self runs this would look, in runs mode, exactly like a node
    // one other party edited alone.
    expect(out?.changes[0]?.runs).toEqual([
      { src: 'self', mine: ['x'] },
      {
        op: 'update',
        props: ['x'],
        set: { x: 20 },
        src: 'agent',
      },
      { src: 'self', mine: ['y'] },
      {
        op: 'update',
        props: ['y'],
        set: { y: 40 },
        src: 'agent',
      },
    ])
    // Node and style entries carry `runs[]` INSTEAD of the folded four.
    expect(out?.changes[0]?.op).toBeUndefined()
    expect(out?.changes[0]?.props).toBeUndefined()
    expect(out?.changes[0]?.set).toBeUndefined()
    expect(out?.changes[0]?.src).toBeUndefined()
  })

  it('an alternation this session ENDS collapses to a shadow, and the count falls', () => {
    // A x=10 → B x=20 → A x=30. B's value is dead: this session's own write is
    // current on the only property the entry holds, so there is no change
    // relative to it and `pendingCount` must fall to 0 — a count that stayed
    // positive over an entry a drain would report as nothing carries no signal.
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      { op: 'update', id: 'n1', props: ['x'], by: A },
      {
        op: 'update',
        id: 'n1',
        props: ['x'],
        set: { x: 20 },
        by: B,
      },
    ])
    expect(f.pendingCount('fk')).toBe(1)
    feedFrom(
      f,
      [{ op: 'update', id: 'n1', props: ['x'], by: A }],
      1,
    )
    expect(f.pendingCount('fk')).toBe(0)
    expect(f.drain('fk', 100)?.changes).toEqual([])
    // …and the shadow still answers the NEXT foreign write.
    feedFrom(
      f,
      [
        {
          op: 'update',
          id: 'n1',
          props: ['x'],
          set: { x: 40 },
          by: B,
        },
      ],
      2,
    )
    expect(f.drain('fk', 100)?.changes).toEqual([
      {
        id: 'n1',
        op: 'update',
        props: ['x'],
        set: { x: 40 },
        src: 'agent',
        mine: ['x'],
      },
    ])
  })

  it('the CONTEXT SLOTS ignore `detail` and keep `op` in both modes', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [{ op: 'select', ids: ['n1'], count: 3 }])
    expect(f.drain('fk', 100, 'runs')?.changes).toEqual([
      { op: 'select', ids: ['n1'], count: 3 },
    ])
  })
})

describe('ChangeFeed BUFFER_CAP degrades in three stages', () => {
  it('stage 1 releases SHADOWS and arms NOTHING', () => {
    // Cap 3. Two shadows (1 run + 1 for `mine` each) plus one real entry.
    const f = new ChangeFeed(() => undefined, 3, {
      writer: () => 'A',
    })
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      { op: 'update', id: 's1', props: ['x'], by: A },
      { op: 'update', id: 's2', props: ['x'], by: A },
      { op: 'update', id: 'n1', props: ['y'] },
    ])
    // A lost shadow costs an EXPLANATION, never a change.
    expect(f.drain('fk', 100)?.state).toBe('no_baseline')
    expect(f.pendingCount('fk')).toBe(0)
  })

  it('stage 2 MERGES adjacent foreign runs and arms NOTHING', () => {
    const f = new ChangeFeed(() => undefined, 2, {
      writer: () => 'A',
    })
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      { op: 'update', id: 'n1', props: ['a'] },
      { op: 'update', id: 'n1', props: ['b'], by: B },
      { op: 'update', id: 'n1', props: ['c'] },
    ])
    const out = f.drain('fk', 100, 'runs')
    // Order lost, no change lost: `a`, `b` and `c` all survive.
    expect(out?.state).toBe('no_baseline')
    expect(
      out?.changes[0]?.runs?.flatMap(r =>
        'props' in r ? (r.props ?? []) : [],
      ),
    ).toEqual(['a', 'b', 'c'])
    expect(
      out?.changes[0]?.runs?.some(
        r => 'merged' in r && r.merged === true,
      ),
    ).toBe(true)
  })

  // change-feed.md orders stage 3 "once no entry has two adjacent foreign runs
  // left". The busiest entry is not necessarily a MERGEABLE one — self runs
  // between its foreign runs leave it no adjacent pair — and giving up on it
  // spends a change (and arms `gap`, obliging every reader a full re-read)
  // while order was still there to spend.
  it('stage 2 tries EVERY candidate before stage 3 spends a change', () => {
    const f = new ChangeFeed(() => undefined, 5, {
      writer: () => 'A',
    })
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      // n1: foreign / self / foreign / self — four runs, NO adjacent pair.
      { op: 'update', id: 'n1', props: ['x'], by: B },
      { op: 'update', id: 'n1', props: ['y'], by: A },
      { op: 'update', id: 'n1', props: ['z'], by: B },
      { op: 'update', id: 'n1', props: ['w'], by: A },
      // n2: two adjacent foreign runs — the pair stage 2 exists to spend.
      { op: 'update', id: 'n2', props: ['a'], by: B },
      { op: 'update', id: 'n2', props: ['b'] },
    ])
    const out = f.drain('fk', 100, 'runs')
    expect(out?.state).toBe('no_baseline') // never `gap`
    // Both ids survive, and n1 keeps all four of its runs.
    expect(out?.changes.map(c => c.id)).toEqual([
      'n1',
      'n2',
    ])
    expect(out?.changes[0]?.runs).toHaveLength(4)
    // n2's pair merged: order lost, no change lost.
    expect(
      out?.changes[1]?.runs?.flatMap(r =>
        'props' in r ? (r.props ?? []) : [],
      ),
    ).toEqual(['a', 'b'])
  })

  it('stage 3 evicts the OLDEST DISTINCT ID and arms gap', () => {
    const f = new ChangeFeed(() => undefined, 2, {
      writer: () => 'A',
    })
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      { op: 'create', id: 'n1' },
      { op: 'create', id: 'n2' },
      { op: 'create', id: 'n3' },
    ])
    const out = f.drain('fk', 100)
    expect(out?.state).toBe('gap')
    expect(out?.changes.map(c => c.id)).toEqual([
      'n2',
      'n3',
    ])
  })

  it('`merged` is ABSENT while the caps are not in play', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      { op: 'update', id: 'n1', props: ['a'] },
      { op: 'update', id: 'n1', props: ['b'], by: B },
    ])
    const runs = f.drain('fk', 100, 'runs')?.changes[0]
      ?.runs
    expect(
      runs?.every(r => !('merged' in r && r.merged)),
    ).toBe(true)
  })

  it('RUNS_PER_ID_CAP merges rather than letting one id grow without limit', () => {
    const f = new ChangeFeed(() => undefined, 2000, {
      writer: () => 'A',
      runsPerId: 2,
    })
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      { op: 'update', id: 'n1', props: ['a'] },
      { op: 'update', id: 'n1', props: ['b'], by: B },
      { op: 'update', id: 'n1', props: ['c'] },
      { op: 'update', id: 'n1', props: ['d'], by: B },
    ])
    const out = f.drain('fk', 100, 'runs')
    expect(out?.changes[0]?.runs).toHaveLength(2)
    expect(out?.state).toBe('no_baseline') // never `gap`
  })
})

describe('ChangeFeed entry identity across a run boundary', () => {
  // change-feed.md: "`name`, `type`, `pg` and `fr` on a merge take the LATEST
  // DEFINED value; a `delete` clears `name` and leaves `pg` / `fr` at whatever
  // an earlier run established, since a delete can never locate itself." A new
  // run is a merge of the arriving record onto what the entry already holds —
  // the rule cannot lapse at the boundary, or a delete could never be located
  // at all and the truncation map would degrade on exactly the multi-writer
  // flood it exists to answer.
  it('a DELETE after an earlier run keeps the locator the earlier run established', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      {
        op: 'update',
        id: 'n1',
        type: 'FRAME',
        name: 'Card',
        props: ['x'],
        pg: 'p1',
        fr: 'f1',
      },
      // A delete NEVER carries pg/fr — a RemovedNode exposes no parent — and
      // it opens a new run (no `by`, so its key differs from B's).
      { op: 'delete', id: 'n1', type: 'FRAME', by: B },
    ])
    expect(f.drain('fk', 100)?.changes).toEqual([
      {
        id: 'n1',
        type: 'FRAME',
        op: 'delete',
        pg: 'p1',
        fr: 'f1',
      },
    ])
  })

  it('a NAMELESS foreign update does not wipe the type/name/locator an earlier run set', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      {
        op: 'update',
        id: 'n1',
        type: 'FRAME',
        name: 'Card',
        props: ['x'],
        pg: 'p1',
        fr: 'f1',
      },
      { op: 'update', id: 'n1', props: ['y'], by: B },
    ])
    expect(f.drain('fk', 100)?.changes).toEqual([
      {
        id: 'n1',
        type: 'FRAME',
        name: 'Card',
        pg: 'p1',
        fr: 'f1',
        op: 'update',
        props: ['x', 'y'],
      },
    ])
  })

  it('a delete that is the id`s FIRST appearance stays unlocated', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [{ op: 'delete', id: 'n9', type: 'FRAME' }])
    expect(f.drain('fk', 100)?.changes).toEqual([
      { id: 'n9', type: 'FRAME', op: 'delete' },
    ])
  })

  it('an inherited locator BUCKETS in the truncation receipt instead of falling to `other`', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      { op: 'create', id: 'n0', pg: 'p1', fr: 'f1' },
      {
        op: 'update',
        id: 'n1',
        props: ['x'],
        pg: 'p1',
        fr: 'f1',
      },
      { op: 'delete', id: 'n1', by: B },
    ])
    const r = f.drain('fk', 1)?.remaining
    expect(r?.total).toBe(1)
    expect(r?.other).toBe(0)
    expect(r?.frames).toEqual([
      { fr: 'f1', pg: 'p1', n: 1 },
    ])
  })
})

describe('ChangeFeed truncation receipt', () => {
  it('`remaining` reconciles and is ABSENT when not truncated', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      { op: 'create', id: 'n0', fr: 'f1', pg: 'p1' },
      { op: 'create', id: 'n1', fr: 'f1', pg: 'p1' },
      {
        op: 'update',
        id: 'f1',
        name: 'Header',
        props: ['name'],
        fr: 'f1',
        pg: 'p1',
      },
      { op: 'create', id: 'n3', fr: 'f2', pg: 'p1' },
      // A delete is NEVER located — a RemovedNode has no parent.
      { op: 'delete', id: 'n4' },
    ])
    const first = f.drain('fk', 1)
    expect(first?.truncated).toBe(true)
    const r = first?.remaining
    expect(r?.total).toBe(4)
    expect(r?.total).toBe(f.pendingCount('fk'))
    expect(
      (r?.frames ?? []).reduce((s, x) => s + x.n, 0) +
        (r?.other ?? 0),
    ).toBe(r?.total)
    expect(r?.frames[0]).toEqual({
      fr: 'f1',
      pg: 'p1',
      name: 'Header',
      n: 2,
    })
    expect(r?.other).toBe(1) // the unlocatable delete
    expect(f.drain('fk', 100)?.remaining).toBeUndefined()
  })
})

describe('ChangeFeed drain budgets', () => {
  it('`limit` counts ENTRIES in BOTH detail modes', () => {
    const build = () => {
      const f = asA()
      f.openBaseline('fk', 'e1')
      feedFrom(f, [
        { op: 'update', id: 'n1', props: ['x'], by: B },
        { op: 'update', id: 'n1', props: ['y'] },
        { op: 'update', id: 'n2', props: ['x'], by: B },
      ])
      return f
    }
    // n1 holds TWO runs; a runs-mode entry is the larger one, but the bound
    // stays comparable because it counts ids either way.
    expect(
      build()
        .drain('fk', 1)
        ?.changes.map(c => c.id),
    ).toEqual(['n1'])
    expect(
      build()
        .drain('fk', 1, 'runs')
        ?.changes.map(c => c.id),
    ).toEqual(['n1'])
  })

  it('DRAIN_VALUE_BUDGET degrades to NAMES-ONLY and never drops an entry', () => {
    // A budget that dropped entries would trade a reported CHANGE for a
    // reported VALUE, which is the wrong way round.
    const big = 'v'.repeat(200)
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(
      f,
      Array.from({ length: 200 }, (_, i) => ({
        op: 'update',
        id: `n${i}`,
        props: ['name'],
        set: { name: big },
      })),
    )
    const out = f.drain('fk', 200)
    // Every entry is still reported…
    expect(out?.changes).toHaveLength(200)
    expect(
      out?.changes.every(c => (c.props ?? []).length === 1),
    ).toBe(true)
    // …but the response's byte budget cut the values on the tail.
    const withValues = (out?.changes ?? []).filter(
      c => c.set !== undefined,
    )
    expect(withValues.length).toBeGreaterThan(0)
    expect(withValues.length).toBeLessThan(200)
  })

  it('spends the value budget in ASCENDING size, so the CHEAPEST entries keep theirs', () => {
    const f = asA()
    f.openBaseline('fk', 'e1')
    feedFrom(f, [
      {
        op: 'update',
        id: 'cheap',
        props: ['x'],
        set: { x: 1 },
      },
      {
        op: 'update',
        id: 'dear',
        props: ['name'],
        set: { name: 'n'.repeat(200) },
      },
    ])
    // Both fit here; what the ordering guarantees is that under pressure the
    // cheap one is never the casualty. Assert the render order is unaffected
    // by the allocation order — `changes` keeps its stated order, so `limit`
    // and truncation are untouched.
    expect(
      f.drain('fk', 100)?.changes.map(c => c.id),
    ).toEqual(['cheap', 'dear'])
  })
})
