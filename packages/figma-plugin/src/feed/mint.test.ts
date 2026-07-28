import { describe, it, expect } from 'bun:test'
import { mintFrame } from './mint'
import { createAccumulator } from './accumulator'
import { createSelfWriteAttributor } from './self-write-attributor'
import { createWriteScope } from './write-scope'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { AttributedRecord } from '@figma-agent-bridge/shared/change-feed'

const W = (...names: string[]): ReadonlySet<string> =>
  new Set(names)

describe('mintFrame', () => {
  it('omits `writers` entirely when no record is attributed', () => {
    const out = mintFrame([
      { op: 'update', id: 'n1', props: ['x'] },
    ])
    expect(out.writers).toBeUndefined()
    expect(out.changes).toEqual([
      { op: 'update', id: 'n1', props: ['x'] },
    ])
  })

  it('mints one table per frame and indexes both masks into it', () => {
    const out = mintFrame([
      { op: 'update', id: 'n1', props: ['x'], by: W('A') },
      { op: 'update', id: 'n2', props: ['y'], rf: W('B') },
      {
        op: 'update',
        id: 'n3',
        props: ['z'],
        by: W('B'),
        rf: W('A', 'B'),
      },
    ])
    expect(out.writers).toEqual(['A', 'B'])
    expect(out.changes.map(c => [c.by, c.rf])).toEqual([
      [1, undefined],
      [undefined, 2],
      [2, 3],
    ])
  })

  it('the table order is FIRST APPEARANCE, so a batch mints deterministically', () => {
    const records: AttributedRecord[] = [
      { op: 'update', id: 'n1', by: W('Z') },
      { op: 'update', id: 'n2', by: W('A') },
    ]
    expect(mintFrame(records).writers).toEqual(['Z', 'A'])
    expect(mintFrame(records).writers).toEqual(['Z', 'A'])
  })

  it('a writer past WRITERS_CAP wins NO BIT — over-report, never a wrong drop', () => {
    const out = mintFrame(
      [
        { op: 'update', id: 'n1', by: W('A') },
        { op: 'update', id: 'n2', by: W('B') },
        { op: 'update', id: 'n3', by: W('C') },
      ],
      2,
    )
    expect(out.writers).toEqual(['A', 'B'])
    // C's record goes out UNATTRIBUTED: kept by everyone including C itself.
    expect(out.changes[2]?.by).toBeUndefined()
  })

  it('drops the name sets from the wire record', () => {
    const [rec] = mintFrame([
      { op: 'update', id: 'n1', by: W('A'), rf: W('A') },
    ]).changes
    expect(typeof rec?.by).toBe('number')
    expect(typeof rec?.rf).toBe('number')
    expect(rec).toEqual({
      op: 'update',
      id: 'n1',
      by: 1,
      rf: 1,
    })
  })
})

// ── the plugin-side pipeline, end to end ────────────────────────────────────
// attributor → accumulator → mint. This is the half of the wire cut that lands
// in the plugin, and it is the half that goes GREEN AND WRONG on its own: the
// plugin stops dropping self-writes here, and only the server's subtraction
// makes that correct again.
describe('attributor → accumulator → mint', () => {
  const propChange = (
    id: string,
    properties: string[],
    node: Record<string, unknown> = {},
  ) => ({
    type: 'PROPERTY_CHANGE',
    node: { id, type: 'FRAME', name: 'Card', ...node },
    properties,
  })

  const pipeline = () => {
    const scope = createWriteScope({
      resolve: () => Promise.resolve(null),
    })
    const attributor = createSelfWriteAttributor(scope)
    const accum = createAccumulator(500)
    return { scope, attributor, accum }
  }

  const feed = (
    attributor: ReturnType<typeof pipeline>['attributor'],
    accum: ReturnType<typeof pipeline>['accum'],
    change: unknown,
  ) => {
    const rec = attributor.admit(change)
    if (rec !== null) accum.add(rec)
  }

  it('two writers on ONE id produce two records, in run order, each naming ONE writer', async () => {
    const { scope, attributor, accum } = pipeline()

    const a = await scope.enter('A', COMMANDS.UPDATE_NODE, {
      nodeId: '1:1',
    })
    a(null)
    feed(
      attributor,
      accum,
      propChange('1:1', ['x'], { x: 10 }),
    )

    const b = await scope.enter('B', COMMANDS.UPDATE_NODE, {
      nodeId: '1:1',
    })
    b(null)
    feed(
      attributor,
      accum,
      propChange('1:1', ['x'], { x: 20 }),
    )

    const minted = mintFrame(accum.drain().changes)
    expect(minted.writers).toEqual(['A', 'B'])
    expect(minted.changes).toHaveLength(2)
    // The run BOUNDARY is authoritative at source: the server can only fold
    // what the frame carries, so a boundary lost here cannot be recovered.
    expect(minted.changes[0]?.set).toEqual({ x: 10 })
    expect(minted.changes[0]?.by).toBe(1)
    // THE SUPERSESSION BUG, at the pipeline level and in the shape the live
    // wire produced it: `by: 3` — binary 11, BOTH bits. B's write is the only
    // cause of that change, but a union over retained generations claimed both
    // writers, and at ingest each consumer discards records bearing its own
    // bit — so A subtracted, B subtracted, and NOBODY saw it. `by` is
    // "who caused THIS change", so it names B and B alone; A keeps the record
    // and learns from `mine` that its own x = 10 landed and was superseded.
    expect(minted.changes[1]?.set).toEqual({ x: 20 })
    expect(minted.changes[1]?.by).toBe(2)
  })

  // THE RESIDUAL the narrowing does not reach, pinned so it is a chosen
  // outcome rather than an untested one. Attribution is asked at EVENT time,
  // and the runtime chooses when an event is delivered: if A's documentchange
  // is STILL UNDELIVERED when B touches the same id, A's own change is stamped
  // with B too, because by then B is genuinely the latest toucher of that id.
  //
  // The degradation is strictly milder than the union it replaces — the union
  // gave A nothing at all, this gives A the record without the annotation —
  // and it is not fixable from the ingest side, because the frame that reaches
  // the server never names A. Fixing it plugin-side would mean stamping at
  // COMMAND time instead of event time, which is the one thing this design
  // cannot do: the plugin does not know which properties a command changed
  // until the runtime tells it.
  it('a write DELIVERED LATE, after a peer touched the same id, is attributed to the peer', async () => {
    const { scope, attributor, accum } = pipeline()

    const a = await scope.enter('A', COMMANDS.UPDATE_NODE, {
      nodeId: '1:1',
    })
    a(null)
    const b = await scope.enter('B', COMMANDS.UPDATE_NODE, {
      nodeId: '1:1',
    })
    b(null)

    // Only NOW does the runtime deliver the batch — A's change and B's, in
    // order, both after B's touch.
    feed(
      attributor,
      accum,
      propChange('1:1', ['x'], { x: 10 }),
    )
    feed(
      attributor,
      accum,
      propChange('1:1', ['x'], { x: 20 }),
    )

    const minted = mintFrame(accum.drain().changes)
    // A wins no bit and is not even in the frame's TABLE: nothing on the wire
    // says A wrote here, so the server cannot supply A's `mine` from it.
    expect(minted.writers).toEqual(['B'])
    // And the loss is sharper than a missing annotation. Both records now name
    // ONE writer on one id, so the accumulator sees no run boundary between
    // them and folds them: A's write does not merely lose its label, it stops
    // existing as a run. What A receives is a single foreign record carrying
    // B's final value — true about the document, silent about A's own write.
    expect(minted.changes).toHaveLength(1)
    expect(minted.changes[0]?.by).toBe(1)
    expect(minted.changes[0]?.set).toEqual({ x: 20 })
  })

  it('a writer past the cap merges into the adjacent EMPTY-key run — over-report AND mislabel', async () => {
    // The spec's stated residual, both halves. A record with no bit carries the
    // EMPTY writer key, which is the USER's, so that session's work merges into
    // an adjacent user run instead of opening its own: a run boundary is lost
    // and `src` will read as the user rather than as an agent.
    const { scope, attributor, accum } = pipeline()

    // A user edit first, then a capped-out writer's edit on the same id.
    feed(
      attributor,
      accum,
      propChange('1:1', ['x'], { x: 1 }),
    )
    const b = await scope.enter('B', COMMANDS.UPDATE_NODE, {
      nodeId: '1:1',
    })
    b(null)
    feed(
      attributor,
      accum,
      propChange('1:1', ['y'], { y: 2 }),
    )

    // Two runs at source — the boundary IS carried…
    const drained = accum.drain().changes
    expect(drained).toHaveLength(2)
    // …but a table with no room for B strips its mask, so the SERVER will
    // resolve both to the empty key and merge them.
    const minted = mintFrame(drained, 0)
    expect(minted.writers).toBeUndefined()
    expect(
      minted.changes.every(c => c.by === undefined),
    ).toBe(true)
  })

  it('an unattributed record carries no mask and is kept by every consumer', () => {
    const { attributor, accum } = pipeline()
    feed(attributor, accum, propChange('1:1', ['x']))
    const minted = mintFrame(accum.drain().changes)
    expect(minted.writers).toBeUndefined()
    expect(minted.changes[0]?.by).toBeUndefined()
    expect(minted.changes[0]?.rf).toBeUndefined()
  })

  it('a session sees its OWN writes cross the wire — the cost the design pays deliberately', async () => {
    // A file only the agent writes to still emits a frame every flush window.
    // An eliding design emits nothing there. The plugin CANNOT know who is
    // listening: the relay announces no membership, and a session that has
    // only ever drained has issued no command the plugin could have seen.
    const { scope, attributor, accum } = pipeline()
    const done = await scope.enter(
      'A',
      COMMANDS.UPDATE_NODE,
      { nodeId: '1:1' },
    )
    done(null)
    feed(
      attributor,
      accum,
      propChange('1:1', ['x'], { x: 1 }),
    )
    const minted = mintFrame(accum.drain().changes)
    expect(minted.changes).toHaveLength(1)
    expect(minted.writers).toEqual(['A'])
    expect(minted.changes[0]?.by).toBe(1)
  })
})
