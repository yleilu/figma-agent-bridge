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
