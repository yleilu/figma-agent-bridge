import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import type { Server } from 'bun'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { createFigmaClient } from '@figma-agent-bridge/server/figma-client'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import { ChangeFeed } from '@figma-agent-bridge/server/change-feed/feed'
import { attachChangeFeed } from '@figma-agent-bridge/server/change-feed/attach'

const PORT = 3121
const WS = `ws://localhost:${PORT}`

const rawPlugin = async (): Promise<WebSocket> =>
  new Promise(res => {
    const s = new WebSocket(WS)
    s.onopen = () => res(s)
  })

describe('change-feed ingest over the relay', () => {
  let relay: Server<{ id: string }>
  beforeEach(() => {
    relay = startRelay(PORT)
  })
  afterEach(() => {
    stopRelay(relay)
  })

  it('routes a push into the buffer by meta.fileKey', async () => {
    const client = createFigmaClient(WS)
    const feed = new ChangeFeed()
    attachChangeFeed(client, feed, () => undefined)
    await client.joinChannel('ch-cf', 'fk-cf')
    feed.openBaseline('fk-cf', 'e1')

    const plugin = await rawPlugin()
    plugin.send(
      JSON.stringify({ type: 'join', channel: 'ch-cf' }),
    )
    await Bun.sleep(30)
    plugin.send(
      JSON.stringify({
        type: 'message',
        channel: 'ch-cf',
        message: {
          command: 'document_changed',
          params: {
            changes: [{ op: 'create', id: 'n1' }],
            indexStale: false,
            at: 1,
          },
          meta: {
            fileKey: 'fk-cf',
            epoch: 'e1',
            seq: 0,
          },
        },
      }),
    )
    await Bun.sleep(50)
    expect(feed.pendingCount('fk-cf')).toBe(1)
    plugin.close()
    client.disconnect()
  })

  it('DROPS a push with no meta.fileKey', async () => {
    const client = createFigmaClient(WS)
    const feed = new ChangeFeed()
    attachChangeFeed(client, feed, () => undefined)
    await client.joinChannel('ch-nf', 'fk-nf')
    feed.openBaseline('fk-nf', 'e1')

    const plugin = await rawPlugin()
    plugin.send(
      JSON.stringify({ type: 'join', channel: 'ch-nf' }),
    )
    await Bun.sleep(30)
    plugin.send(
      JSON.stringify({
        type: 'message',
        channel: 'ch-nf',
        message: {
          command: 'document_changed',
          params: {
            changes: [{ op: 'create', id: 'n1' }],
            indexStale: false,
            at: 1,
          },
          meta: { epoch: 'e1', seq: 0 },
        },
      }),
    )
    await Bun.sleep(50)
    expect(feed.pendingCount('fk-nf')).toBe(0)
    plugin.close()
    client.disconnect()
  })

  it('marks the index stale from params.indexStale, keyed by meta.fileKey', async () => {
    const client = createFigmaClient(WS)
    const feed = new ChangeFeed()
    const staled: string[] = []
    attachChangeFeed(client, feed, fileKey => {
      staled.push(fileKey)
    })
    await client.joinChannel('ch-st', 'fk-st')
    feed.openBaseline('fk-st', 'e1')

    const plugin = await rawPlugin()
    plugin.send(
      JSON.stringify({ type: 'join', channel: 'ch-st' }),
    )
    await Bun.sleep(30)
    const push = (
      params: Record<string, unknown>,
      seq: number,
    ) =>
      plugin.send(
        JSON.stringify({
          type: 'message',
          channel: 'ch-st',
          message: {
            command: 'document_changed',
            params,
            meta: { fileKey: 'fk-st', epoch: 'e1', seq },
          },
        }),
      )
    push({ changes: [], indexStale: true, at: 1 }, 0)
    push(
      {
        changes: [
          { op: 'update', id: 'n1', props: ['characters'] },
        ],
        indexStale: false,
        at: 2,
      },
      1,
    )
    await Bun.sleep(50)

    // Frame ARRIVAL is not the stale signal — only params.indexStale is; and
    // the ordinary edit still lands in the buffer.
    expect(staled).toEqual(['fk-st'])
    expect(feed.pendingCount('fk-st')).toBe(1)
    plugin.close()
    client.disconnect()
  })

  // The server↔relay socket dropping is the condition the count alone cannot
  // carry: every open buffer is EMPTY afterwards, so an un-armed baseline would
  // report `0` — "safe to act" — over a hole in the history.
  it('arms gap on EVERY open buffer when the relay socket drops', async () => {
    const client = createFigmaClient(WS)
    const feed = new ChangeFeed()
    attachChangeFeed(client, feed, () => undefined)
    await client.joinChannel('ch-a', 'fk-a')
    await client.joinChannel('ch-b', 'fk-b')
    feed.openBaseline('fk-a', 'e1')
    feed.openBaseline('fk-b', 'e1')
    // Establish a clean baseline on both so `gap` is distinguishable from the
    // opening `no_baseline`.
    feed.drain('fk-a', 100)
    feed.drain('fk-b', 100)
    expect(feed.drain('fk-a', 100)?.state).toBe('ok')
    expect(feed.drain('fk-b', 100)?.state).toBe('ok')

    stopRelay(relay)
    await Bun.sleep(100)

    expect(feed.drain('fk-a', 100)?.state).toBe('gap')
    expect(feed.drain('fk-b', 100)?.state).toBe('gap')
    client.disconnect()
  })

  // disconnect() is the one server-side teardown that clears every channel
  // membership WITHOUT the socket's onclose path running (it nulls `ws` first,
  // and onclose is guarded on `ws !== null`). Unarmed, it leaves a clean `ok`
  // over a server that is no longer a channel member.
  it('arms gap on EVERY open buffer when the client disconnects', async () => {
    const client = createFigmaClient(WS)
    const feed = new ChangeFeed()
    attachChangeFeed(client, feed, () => undefined)
    await client.joinChannel('ch-d1', 'fk-d1')
    await client.joinChannel('ch-d2', 'fk-d2')
    feed.openBaseline('fk-d1', 'e1')
    feed.openBaseline('fk-d2', 'e1')
    feed.drain('fk-d1', 100)
    feed.drain('fk-d2', 100)
    expect(feed.drain('fk-d1', 100)?.state).toBe('ok')
    expect(feed.drain('fk-d2', 100)?.state).toBe('ok')

    client.disconnect()

    expect(feed.drain('fk-d1', 100)?.state).toBe('gap')
    expect(feed.drain('fk-d2', 100)?.state).toBe('gap')
  })

  // The push path is the ONE path with no version gate (the B2 handshake
  // guards the file gate, which pushes never traverse), so a non-conforming or
  // future plugin build reaches ingest unvalidated. A synchronous throw inside
  // the handler escapes the socket message handler and kills the process.
  it('SURVIVES a document_changed frame with no changes array', async () => {
    const client = createFigmaClient(WS)
    const feed = new ChangeFeed()
    attachChangeFeed(client, feed, () => undefined)
    await client.joinChannel('ch-mal', 'fk-mal')
    feed.openBaseline('fk-mal', 'e1')

    const plugin = await rawPlugin()
    plugin.send(
      JSON.stringify({ type: 'join', channel: 'ch-mal' }),
    )
    await Bun.sleep(30)
    const send = (
      params: Record<string, unknown>,
      seq: number,
    ) =>
      plugin.send(
        JSON.stringify({
          type: 'message',
          channel: 'ch-mal',
          message: {
            command: 'document_changed',
            params,
            meta: { fileKey: 'fk-mal', epoch: 'e1', seq },
          },
        }),
      )
    send({ indexStale: false, at: 1 }, 0)
    await Bun.sleep(30)
    // The socket is still alive and still routing.
    send(
      {
        changes: [{ op: 'create', id: 'n1' }],
        indexStale: false,
        at: 2,
      },
      1,
    )
    await Bun.sleep(50)
    expect(feed.pendingCount('fk-mal')).toBe(1)
    expect(feed.drain('fk-mal', 100)?.state).toBe('gap')
    plugin.close()
    client.disconnect()
  })

  // ── the BROADCAST property ────────────────────────────────────────────────
  // The relay has NO UNICAST: one frame reaches every member of the channel or
  // none does. So the plugin ATTRIBUTES and each consumer SUBTRACTS — and THIS
  // is the property a single-server unit test cannot show, because it is about
  // two servers reading the same bytes and arriving at different buffers.
  it('the SAME frame produces DIFFERENT buffers for two consumers', async () => {
    const clientA = createFigmaClient(WS)
    const clientB = createFigmaClient(WS)
    const feedA = new ChangeFeed(
      () => undefined,
      undefined,
      {
        writer: () => 'A',
      },
    )
    const feedB = new ChangeFeed(
      () => undefined,
      undefined,
      {
        writer: () => 'B',
      },
    )
    attachChangeFeed(clientA, feedA, () => undefined)
    attachChangeFeed(clientB, feedB, () => undefined)
    await clientA.joinChannel('ch-two', 'fk-two')
    await clientB.joinChannel('ch-two', 'fk-two')
    feedA.openBaseline('fk-two', 'e1')
    feedB.openBaseline('fk-two', 'e1')

    const plugin = await rawPlugin()
    plugin.send(
      JSON.stringify({ type: 'join', channel: 'ch-two' }),
    )
    await Bun.sleep(30)
    plugin.send(
      JSON.stringify({
        type: 'message',
        channel: 'ch-two',
        message: {
          command: 'document_changed',
          params: {
            // Attribution rides `params`, which the relay forwards WHOLE —
            // `metaSchema` gains nothing, so nothing here can be silently
            // stripped by the allow-list.
            writers: ['A', 'B'],
            changes: [
              {
                op: 'update',
                id: 'n1',
                props: ['x'],
                set: { x: 1 },
                by: 1,
              },
              {
                op: 'update',
                id: 'n2',
                props: ['y'],
                set: { y: 2 },
                by: 2,
              },
              { op: 'update', id: 'n3', props: ['z'] },
            ],
            indexStale: false,
            at: 1,
          },
          meta: {
            fileKey: 'fk-two',
            epoch: 'e1',
            seq: 0,
          },
        },
      }),
    )
    await Bun.sleep(50)
    // Each drops its OWN and keeps the peer's and the user's.
    expect(
      feedA.drain('fk-two', 100)?.changes.map(c => c.id),
    ).toEqual(['n2', 'n3'])
    expect(
      feedB.drain('fk-two', 100)?.changes.map(c => c.id),
    ).toEqual(['n1', 'n3'])
    // …and each is 0 pending afterwards, which is the signal `pending_edits`
    // carries. A count that never returned to 0 would carry none.
    expect(feedA.pendingCount('fk-two')).toBe(0)
    expect(feedB.pendingCount('fk-two')).toBe(0)
    plugin.close()
    clientA.disconnect()
    clientB.disconnect()
  })

  it('keeps two records for ONE id as two RUNS, in the order the frame carried', async () => {
    const client = createFigmaClient(WS)
    const feed = new ChangeFeed(
      () => undefined,
      undefined,
      {
        writer: () => 'A',
      },
    )
    attachChangeFeed(client, feed, () => undefined)
    await client.joinChannel('ch-runs', 'fk-runs')
    feed.openBaseline('fk-runs', 'e1')

    const plugin = await rawPlugin()
    plugin.send(
      JSON.stringify({ type: 'join', channel: 'ch-runs' }),
    )
    await Bun.sleep(30)
    plugin.send(
      JSON.stringify({
        type: 'message',
        channel: 'ch-runs',
        message: {
          command: 'document_changed',
          params: {
            writers: ['A', 'B'],
            changes: [
              {
                op: 'update',
                id: 'n1',
                props: ['x'],
                set: { x: 10 },
                by: 1,
              },
              {
                op: 'update',
                id: 'n1',
                props: ['x'],
                set: { x: 20 },
                by: 2,
              },
              // `merged` must survive the wire from the plugin's accumulator
              // into the buffer: a loss of order AT SOURCE has to be visible
              // to the server rather than indistinguishable from a genuine
              // single run.
              {
                op: 'update',
                id: 'n2',
                props: ['a', 'b'],
                by: 2,
                merged: true,
              },
            ],
            indexStale: false,
            at: 1,
          },
          meta: {
            fileKey: 'fk-runs',
            epoch: 'e1',
            seq: 0,
          },
        },
      }),
    )
    await Bun.sleep(50)
    const out = feed.drain('fk-runs', 100, 'runs')
    expect(out?.changes[0]?.runs).toEqual([
      { src: 'self', mine: ['x'] },
      {
        op: 'update',
        props: ['x'],
        set: { x: 20 },
        src: 'agent',
      },
    ])
    expect(out?.changes[1]?.runs).toEqual([
      {
        op: 'update',
        props: ['a', 'b'],
        src: 'agent',
        merged: true,
      },
    ])
    plugin.close()
    client.disconnect()
  })
})

// The two disconnect arms are registrations, not behaviour of the transport:
// a missed one is silent (the buffer simply keeps reporting `ok`), so pin that
// attachChangeFeed subscribes to both and routes each to the right arm.
describe('attachChangeFeed disconnect arms', () => {
  const stubClient = () => {
    const arms: {
      socketClose: (() => void)[]
      fileDead: ((fileKey: string) => void)[]
    } = { socketClose: [], fileDead: [] }
    const client = {
      onRequest: () => undefined,
      onSocketClose: (cb: () => void) => {
        arms.socketClose.push(cb)
      },
      onFileDead: (cb: (fileKey: string) => void) => {
        arms.fileDead.push(cb)
      },
    } as unknown as FigmaClient
    return { client, arms }
  }

  it('a socket close arms every buffer; a file death arms only its own', () => {
    const { client, arms } = stubClient()
    const feed = new ChangeFeed()
    attachChangeFeed(client, feed, () => undefined)
    feed.openBaseline('fk-1', 'e1')
    feed.openBaseline('fk-2', 'e1')
    feed.drain('fk-1', 100)
    feed.drain('fk-2', 100)

    for (const cb of arms.fileDead) {
      cb('fk-1')
    }
    expect(feed.drain('fk-1', 100)?.state).toBe('gap')
    expect(feed.drain('fk-2', 100)?.state).toBe('ok')

    for (const cb of arms.socketClose) {
      cb()
    }
    expect(feed.drain('fk-1', 100)?.state).toBe('gap')
    expect(feed.drain('fk-2', 100)?.state).toBe('gap')
  })
})
