import { describe, it, expect } from 'bun:test'
import type {
  ChannelInfo,
  FigmaClient,
} from '@figma-agent-bridge/server/figma-client'
import { ChangeFeed } from '@figma-agent-bridge/server/change-feed/feed'
import {
  withBuffer,
  handlePullChanges,
} from '@figma-agent-bridge/server/tools/with-buffer'
import { pullChangesParamsSchema } from '@figma-agent-bridge/shared/tool-params'

const stub = (available: ChannelInfo[]): FigmaClient =>
  ({
    discover: () => Promise.resolve(available),
    joinChannel: () => {
      throw new Error(
        'pull_changes must never join a channel',
      )
    },
  }) as unknown as FigmaClient

const text = (r: { content: { text: string }[] }) =>
  JSON.parse(r.content[0].text)

describe('pull_changes', () => {
  it('drains a buffer that exists', async () => {
    const feed = new ChangeFeed()
    feed.openBaseline('fk', 'e1')
    feed.ingest(
      'fk',
      {
        changes: [{ op: 'update', id: 'n1', props: ['x'] }],
        indexStale: false,
        at: 1,
      },
      { epoch: 'e1', seq: 0 },
    )
    const call = withBuffer(
      stub([]),
      feed,
      handlePullChanges,
    )
    const out = text(
      (await call({ fileKey: 'fk' })) as never,
    )
    expect(out).toEqual({
      changes: [{ op: 'update', id: 'n1', props: ['x'] }],
      truncated: false,
      state: 'no_baseline',
    })
  })

  it('answers no_baseline for an AVAILABLE file with no buffer, creating none', async () => {
    const feed = new ChangeFeed()
    const call = withBuffer(
      stub([
        {
          channel: 'file-fk',
          fileName: 'D',
          fileKey: 'fk',
          connectedAt: 0,
        },
      ]),
      feed,
      handlePullChanges,
    )
    expect(
      text((await call({ fileKey: 'fk' })) as never),
    ).toEqual({
      changes: [],
      truncated: false,
      state: 'no_baseline',
    })
    expect(feed.has('fk')).toBe(false)
  })

  it('WRONG_FILE when no buffer AND no available match', async () => {
    const call = withBuffer(
      stub([
        {
          channel: 'file-other',
          fileName: 'Other',
          fileKey: 'other',
          connectedAt: 0,
        },
      ]),
      new ChangeFeed(),
      handlePullChanges,
    )
    const out = text(
      (await call({ fileKey: 'fk' })) as never,
    )
    expect(out.code).toBe('WRONG_FILE')
    expect(out.error).toContain('other')
  })

  it('WRONG_FILE with an EMPTY registry names the emptiness, not a blank list', async () => {
    // B3's ask-don't-guess obligation cannot be discharged with an
    // unanswerable ask: listAvailable([]) is the empty string, so the agent
    // would get "Choose one of the connected files:" followed by nothing.
    const call = withBuffer(
      stub([]),
      new ChangeFeed(),
      handlePullChanges,
    )
    const out = text(
      (await call({ fileKey: 'fk' })) as never,
    )
    expect(out.code).toBe('WRONG_FILE')
    expect(out.error).not.toContain('Choose one')
    expect(out.error).toContain(
      'No Figma file is connected',
    )
  })

  it('INVALID_PARAM on an empty fileKey, without consulting the registry', async () => {
    const call = withBuffer(
      stub([]),
      new ChangeFeed(),
      handlePullChanges,
    )
    const out = text((await call({ fileKey: '' })) as never)
    expect(out.code).toBe('INVALID_PARAM')
  })

  it('NEVER returns DISCONNECTED — an existing buffer drains with an EMPTY registry', async () => {
    const feed = new ChangeFeed()
    feed.openBaseline('fk', 'e1')
    feed.markGap('fk')
    const call = withBuffer(
      stub([]),
      feed,
      handlePullChanges,
    )
    expect(
      text((await call({ fileKey: 'fk' })) as never).state,
    ).toBe('gap')
  })

  it('honours limit and reports truncated', async () => {
    const feed = new ChangeFeed()
    feed.openBaseline('fk', 'e1')
    feed.ingest(
      'fk',
      {
        changes: [
          { op: 'create', id: 'n1' },
          { op: 'create', id: 'n2' },
        ],
        indexStale: false,
        at: 1,
      },
      { epoch: 'e1', seq: 0 },
    )
    const call = withBuffer(
      stub([]),
      feed,
      handlePullChanges,
    )
    const first = text(
      (await call({ fileKey: 'fk', limit: 1 })) as never,
    )
    expect(first.truncated).toBe(true)
    expect(first.changes).toHaveLength(1)
    const second = text(
      (await call({ fileKey: 'fk', limit: 1 })) as never,
    )
    expect(second.truncated).toBe(false)
  })

  it('defaults to `folded`, and `detail:"runs"` swaps the four fields for runs[]', async () => {
    const feed = new ChangeFeed(() => undefined, 2000, {
      writer: () => 'A',
    })
    feed.openBaseline('fk', 'e1')
    const frame = (over: Record<string, unknown>) => ({
      changes: [
        {
          op: 'update',
          id: 'n1',
          props: ['x'],
          set: { x: 20 },
          ...over,
        },
      ],
      writers: ['A', 'B'],
      indexStale: false,
      at: 1,
    })
    feed.ingest('fk', frame({ by: 1 }) as never, {
      epoch: 'e1',
      seq: 0,
    })
    feed.ingest('fk', frame({ by: 2 }) as never, {
      epoch: 'e1',
      seq: 1,
    })
    const call = withBuffer(
      stub([]),
      feed,
      handlePullChanges,
    )

    const folded = text(
      (await call({ fileKey: 'fk' })) as never,
    )
    expect(folded.changes[0]).toEqual({
      id: 'n1',
      op: 'update',
      props: ['x'],
      set: { x: 20 },
      src: 'agent',
      mine: ['x'],
    })
    expect(folded.changes[0].runs).toBeUndefined()
  })

  it('`detail:"runs"` returns runs[] and NONE of op/props/set/src on the entry', async () => {
    const feed = new ChangeFeed(() => undefined, 2000, {
      writer: () => 'A',
    })
    feed.openBaseline('fk', 'e1')
    feed.ingest(
      'fk',
      {
        changes: [
          { op: 'update', id: 'n1', props: ['x'], by: 1 },
          {
            op: 'update',
            id: 'n1',
            props: ['y'],
            set: { y: 2 },
            by: 2,
          },
          { op: 'select', ids: ['n1'] },
        ],
        writers: ['A', 'B'],
        indexStale: false,
        at: 1,
      } as never,
      { epoch: 'e1', seq: 0 },
    )
    const call = withBuffer(
      stub([]),
      feed,
      handlePullChanges,
    )
    const out = text(
      (await call({
        fileKey: 'fk',
        detail: 'runs',
      })) as never,
    )
    const [node, slot] = out.changes
    expect(node.runs).toEqual([
      { src: 'self', mine: ['x'] },
      {
        op: 'update',
        props: ['y'],
        set: { y: 2 },
        src: 'agent',
      },
    ])
    for (const field of ['op', 'props', 'set', 'src']) {
      expect(node[field]).toBeUndefined()
    }
    // The CONTEXT SLOTS ignore `detail` entirely and keep `op`.
    expect(slot).toEqual({ op: 'select', ids: ['n1'] })
  })

  it('an invalid `detail` is INVALID_PARAM at the schema', () => {
    const bad = pullChangesParamsSchema.safeParse({
      fileKey: 'fk',
      detail: 'everything',
    })
    expect(bad.success).toBe(false)
    expect(
      pullChangesParamsSchema.safeParse({ fileKey: 'fk' })
        .success,
    ).toBe(true)
  })

  it('`remaining` rides a truncated drain and reconciles with the count the mirror then writes', async () => {
    const feed = new ChangeFeed()
    feed.openBaseline('fk', 'e1')
    feed.ingest(
      'fk',
      {
        changes: [
          { op: 'create', id: 'n1', fr: 'f1', pg: 'p1' },
          { op: 'create', id: 'n2', fr: 'f1', pg: 'p1' },
          { op: 'create', id: 'n3' },
        ],
        indexStale: false,
        at: 1,
      },
      { epoch: 'e1', seq: 0 },
    )
    const call = withBuffer(
      stub([]),
      feed,
      handlePullChanges,
    )
    const first = text(
      (await call({ fileKey: 'fk', limit: 1 })) as never,
    )
    expect(first.truncated).toBe(true)
    expect(first.remaining.total).toBe(2)
    expect(first.remaining.total).toBe(
      feed.pendingCount('fk'),
    )
    expect(
      first.remaining.frames.reduce(
        (s: number, f: { n: number }) => s + f.n,
        0,
      ) + first.remaining.other,
    ).toBe(first.remaining.total)
    const second = text(
      (await call({ fileKey: 'fk' })) as never,
    )
    expect(second.truncated).toBe(false)
    expect(second.remaining).toBeUndefined()
  })

  it('strips the identity headers and forwards only the tool params', async () => {
    const feed = new ChangeFeed()
    feed.openBaseline('fk', 'e1')
    let seen: Record<string, unknown> | null = null
    let ctxKey: string | null = null
    const call = withBuffer(
      stub([]),
      feed,
      async (params: { limit?: number }, ctx) => {
        seen = params
        ctxKey = ctx.fileKey
        return handlePullChanges(params, ctx)
      },
    )
    await call({
      fileKey: 'fk',
      sessionId: 's-1',
      agentId: 'a-1',
      agentType: 'general',
      limit: 5,
    })
    expect(seen).toEqual({ limit: 5 })
    expect(ctxKey).toBe('fk')
  })
})
