import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ChangeFeed,
  isImmediateWrite,
} from '@figma-agent-bridge/server/change-feed/feed'
import {
  createCountMirror,
  type CountMirror,
} from '@figma-agent-bridge/server/change-feed/count-mirror'

// The composition index.ts performs: the feed's onChange drives the mirror,
// the count is DERIVED from the map sizes, and `drain` is immediate BY REASON.
// The debounce is set absurdly high so anything that is not immediate stays
// off disk for the whole test.
let dir: string
let prevDir: string | undefined
// The mirrors this test stood up, and every write it set going. `write` is
// fire-and-forget in production and the wiring below keeps it that way, but
// `resolveChangesDir()` is read INSIDE the write: a write still in flight when
// the env is restored lands in the user's REAL state directory, next to the
// files the presence hook reads. So teardown stops the timers and waits for
// the chain BEFORE it restores the env or removes the directory.
let mirrors: CountMirror[] = []
let inflight: Promise<unknown>[] = []
beforeEach(async () => {
  // Restored in afterEach: process.env outlives this file's module registry.
  prevDir = process.env.FIGMA_BRIDGE_CHANGES_DIR
  dir = await mkdtemp(join(tmpdir(), 'cfw-'))
  process.env.FIGMA_BRIDGE_CHANGES_DIR = dir
  mirrors = []
  inflight = []
})
afterEach(async () => {
  // shutdown() FIRST: it clears the pending debounce timers, so nothing new
  // can be enqueued while we drain what already is.
  for (const m of mirrors) {
    m.shutdown()
  }
  await Promise.allSettled(inflight)
  if (prevDir === undefined) {
    delete process.env.FIGMA_BRIDGE_CHANGES_DIR
  } else {
    process.env.FIGMA_BRIDGE_CHANGES_DIR = prevDir
  }
  await rm(dir, { recursive: true, force: true })
})

const read = async () =>
  JSON.parse(
    await readFile(join(dir, 'fk', 'sid.json'), 'utf8'),
  )

const wire = (writer = 'sid'): ChangeFeed => {
  const mirror = createCountMirror({
    writer: 'srv-w',
    debounceMs: 5000,
    sessionId: () => 'sid',
  })
  // The count source is `feed.pendingCount`, NOT the map sizes: `pending_edits`
  // means "distinct things changed OUTSIDE this session", so shadow entries and
  // the context slots must stay out of the number.
  mirrors.push(mirror)
  const feed: ChangeFeed = new ChangeFeed(
    (buffer, reason) => {
      // Fire-and-forget, exactly as index.ts does — the promise is only
      // RECORDED so teardown can wait for it.
      inflight.push(
        mirror.write(
          buffer.fileKey,
          feed.pendingCount(buffer.fileKey),
          buffer.state,
          // The SAME predicate index.ts passes — shared, not restated, so
          // this test binds the production decision rather than a copy of it.
          { immediate: isImmediateWrite(reason) },
        ),
      )
    },
    undefined,
    { writer: () => writer },
  )
  return feed
}

describe('feed → count mirror wiring', () => {
  it('mirrors the baseline state alongside the count, never the count alone', async () => {
    const feed = wire()
    feed.openBaseline('fk', 'e1')
    await Bun.sleep(10)
    // A broken baseline that mirrored `0` with no state would read as
    // "safe to act" in the presence block — the defect this field exists for.
    expect(await read()).toMatchObject({
      pendingCount: 0,
      state: 'no_baseline',
    })

    feed.markGap('fk')
    await Bun.sleep(10)
    expect(await read()).toMatchObject({
      pendingCount: 0,
      state: 'gap',
    })
  })

  it('counts DISTINCT changed things and never the context slots', async () => {
    const feed = wire()
    feed.openBaseline('fk', 'e1')
    feed.ingest(
      'fk',
      {
        changes: [
          { op: 'select', ids: ['n1'] },
          { op: 'page', id: 'p1', name: 'Icons' },
        ],
        indexStale: false,
        at: 1,
      },
      { epoch: 'e1', seq: 1 },
    )
    await Bun.sleep(10)
    expect((await read()).pendingCount).toBe(0)

    feed.ingest(
      'fk',
      {
        changes: [
          { op: 'update', id: 'n1', props: ['x'] },
          { op: 'update', id: 'n1', props: ['y'] },
          { op: 'style_update', id: 'S:1', props: ['p'] },
        ],
        indexStale: false,
        at: 2,
      },
      { epoch: 'e1', seq: 2 },
    )
    await Bun.sleep(10)
    // Two distinct things (one node collapsed from two records, one style).
    expect((await read()).pendingCount).toBe(2)
  })

  it('writes a server-side ARM immediately, for every affected file', async () => {
    // change-feed.md's trigger table makes the disconnect arm immediate
    // UNCONDITIONALLY. An arm on a buffer that is ALREADY gap with a positive
    // count matches none of the mirror's conditions (count defined, state
    // unchanged, non-zero, no leading edge), so without the REASON it would be
    // trailing-debounced — and would push any pending timer out further still.
    const feed = wire()
    feed.openBaseline('fk', 'e1')
    feed.ingest(
      'fk',
      {
        changes: [
          { op: 'update', id: 'n1', props: ['x'] },
          { op: 'update', id: 'n2', props: ['x'] },
        ],
        indexStale: false,
        at: 1,
        overflow: true,
      },
      { epoch: 'e1', seq: 1 },
    )
    await Bun.sleep(10)
    expect(await read()).toMatchObject({
      pendingCount: 2,
      state: 'gap',
    })

    // Already gap, still positive: only the REASON keeps this off the 5 s
    // debounce.
    feed.ingest(
      'fk',
      {
        changes: [{ op: 'update', id: 'n3', props: ['x'] }],
        indexStale: false,
        at: 2,
      },
      { epoch: 'e1', seq: 2 },
    )
    feed.markAllGap()
    await Bun.sleep(10)
    expect((await read()).pendingCount).toBe(3)
  })

  it('writes a TRUNCATED drain immediately, past the debounce', async () => {
    const feed = wire()
    feed.openBaseline('fk', 'e1')
    feed.ingest(
      'fk',
      {
        changes: [
          { op: 'update', id: 'n1', props: ['x'] },
          { op: 'update', id: 'n2', props: ['x'] },
        ],
        indexStale: false,
        at: 1,
      },
      { epoch: 'e1', seq: 1 },
    )
    await Bun.sleep(10)
    expect((await read()).pendingCount).toBe(2)

    // positive → positive with the state unchanged: only the `drain` REASON
    // keeps this off the 5 s debounce. An agent draining in a loop would
    // otherwise read a stale-high count next turn.
    const first = feed.drain('fk', 1)
    expect(first?.truncated).toBe(true)
    await Bun.sleep(10)
    expect((await read()).pendingCount).toBe(1)

    feed.drain('fk', 100)
    await Bun.sleep(10)
    expect(await read()).toMatchObject({
      pendingCount: 0,
      state: 'ok',
    })
  })

  it('a buffer holding only SHADOWS mirrors 0, and a drain leaves them behind', async () => {
    const feed = wire('A')
    feed.openBaseline('fk', 'e1')
    feed.ingest(
      'fk',
      {
        changes: [
          { op: 'update', id: 'n1', props: ['x'], by: 1 },
          { op: 'create', id: 'n2', by: 1 },
        ],
        writers: ['A'],
        indexStale: false,
        at: 1,
      } as never,
      { epoch: 'e1', seq: 1 },
    )
    await Bun.sleep(10)
    // The session's own build is not a pending edit TO IT.
    expect(await read()).toMatchObject({
      pendingCount: 0,
      state: 'no_baseline',
    })

    feed.ingest(
      'fk',
      {
        changes: [
          { op: 'update', id: 'n1', props: ['name'] },
        ],
        writers: ['A'],
        indexStale: false,
        at: 2,
      } as never,
      { epoch: 'e1', seq: 2 },
    )
    await Bun.sleep(10)
    expect((await read()).pendingCount).toBe(1)

    // The drain leaves the shadows behind, and they hold nothing open.
    feed.drain('fk', 100)
    await Bun.sleep(10)
    expect(await read()).toMatchObject({
      pendingCount: 0,
      state: 'ok',
    })
  })
})
