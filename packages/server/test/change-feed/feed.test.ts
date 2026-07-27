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
