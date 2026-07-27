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
import { createCountMirror } from '@figma-agent-bridge/server/change-feed/count-mirror'

// The composition index.ts performs: the feed's onChange drives the mirror,
// the count is DERIVED from the map sizes, and `drain` is immediate BY REASON.
// The debounce is set absurdly high so anything that is not immediate stays
// off disk for the whole test.
let dir: string
let prevDir: string | undefined
beforeEach(async () => {
  // Restored in afterEach: process.env outlives this file's module registry.
  prevDir = process.env.FIGMA_BRIDGE_CHANGES_DIR
  dir = await mkdtemp(join(tmpdir(), 'cfw-'))
  process.env.FIGMA_BRIDGE_CHANGES_DIR = dir
})
afterEach(async () => {
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

const wire = (): ChangeFeed => {
  const mirror = createCountMirror({
    writer: 'srv-w',
    debounceMs: 5000,
    sessionId: () => 'sid',
  })
  return new ChangeFeed((buffer, reason) => {
    void mirror.write(
      buffer.fileKey,
      buffer.nodes.size + buffer.styles.size,
      buffer.state,
      // The SAME predicate index.ts passes — shared, not restated, so this
      // test binds the production decision rather than a copy of it.
      { immediate: isImmediateWrite(reason) },
    )
  })
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
})
