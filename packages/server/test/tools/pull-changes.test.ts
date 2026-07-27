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
