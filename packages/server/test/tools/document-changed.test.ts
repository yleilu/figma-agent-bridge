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
import { createDocumentChangedHandler } from '@figma-agent-bridge/server/component-index/document-changed'

const PORT = 3103
const WS = `ws://localhost:${PORT}`

const rawPlugin = async (): Promise<WebSocket> =>
  new Promise((res, rej) => {
    const s = new WebSocket(WS)
    s.onopen = () => res(s)
    s.onerror = () => rej(new Error('connect failed'))
  })

/** Records every markStale key the REAL handler asks for. */
const spyManager = () => {
  const staled: string[] = []
  return {
    staled,
    markStale: (fileKey: string) => {
      staled.push(fileKey)
    },
  }
}

describe('document_changed push', () => {
  let server: Server<{ id: string }>
  beforeEach(() => {
    server = startRelay(PORT)
  })
  afterEach(() => {
    stopRelay(server)
  })

  it('dispatches by command + meta { fileKey, epoch, seq } (no reply)', async () => {
    const client = createFigmaClient(WS)
    await client.joinChannel('ch-dc', 'fk-dc')
    const seenMeta: Record<string, unknown>[] = []
    const seenParams: Record<string, unknown>[] = []
    client.onRequest('document_changed', (params, meta) => {
      seenParams.push(params)
      seenMeta.push(meta)
      return { ok: true }
    })

    const plugin = await rawPlugin()
    const back: unknown[] = []
    plugin.onmessage = e =>
      back.push(JSON.parse(e.data as string))
    plugin.send(
      JSON.stringify({ type: 'join', channel: 'ch-dc' }),
    )
    await Bun.sleep(30)
    plugin.send(
      JSON.stringify({
        type: 'message',
        channel: 'ch-dc',
        message: {
          command: 'document_changed',
          params: {
            changes: [
              { op: 'update', id: 'n1', props: ['name'] },
            ],
            indexStale: true,
            at: 1234,
          },
          meta: {
            fileKey: 'fk-dc',
            epoch: 'epoch-one',
            seq: 0,
          },
        },
      }),
    )
    await Bun.sleep(50)

    // meta.seq SURVIVES the relay — the meta schema is an allow-list, so a
    // doc-only addition would be silently inert.
    expect(seenMeta[0]?.fileKey).toBe('fk-dc')
    expect(seenMeta[0]?.epoch).toBe('epoch-one')
    expect(seenMeta[0]?.seq).toBe(0)
    expect(seenParams[0]?.indexStale).toBe(true)
    expect(seenParams[0]?.changes).toEqual([
      { op: 'update', id: 'n1', props: ['name'] },
    ])
    // A push carries no requestId → no reply frame is broadcast back.
    expect(
      back.some(
        m => (m as { type?: string }).type === 'broadcast',
      ),
    ).toBe(false)

    plugin.close()
    client.disconnect()
  })

  // The component index must not regress across the wire cut. Frame ARRIVAL
  // used to be the stale signal; it is now params.indexStale, so the SHIPPED
  // handler (not a copy of it) is exercised over the real relay.
  it('marks the index stale from params.indexStale, keyed by meta.fileKey', async () => {
    const mgr = spyManager()
    const client = createFigmaClient(WS)
    await client.joinChannel('ch-stale', 'fk-stale')
    client.onRequest(
      'document_changed',
      createDocumentChangedHandler(mgr),
    )

    const plugin = await rawPlugin()
    plugin.send(
      JSON.stringify({ type: 'join', channel: 'ch-stale' }),
    )
    await Bun.sleep(30)

    const push = (
      params: Record<string, unknown>,
      meta: Record<string, unknown>,
    ) =>
      plugin.send(
        JSON.stringify({
          type: 'message',
          channel: 'ch-stale',
          message: {
            command: 'document_changed',
            params,
            meta,
          },
        }),
      )

    const meta = {
      fileKey: 'fk-stale',
      epoch: 'e1',
      seq: 0,
    }
    // A component write: stale.
    push(
      { changes: [], indexStale: true, at: 1 },
      { ...meta, seq: 1 },
    )
    // Every other edit — a keystroke, a nudge — must NOT re-project the
    // index, even though the frame now arrives for those too.
    push(
      {
        changes: [
          { op: 'update', id: 'n1', props: ['characters'] },
        ],
        indexStale: false,
        at: 2,
      },
      { ...meta, seq: 2 },
    )
    // The opening flush is empty and never stale.
    push(
      { changes: [], indexStale: false, at: 3 },
      { ...meta, seq: 0 },
    )
    await Bun.sleep(50)

    expect(mgr.staled).toEqual(['fk-stale'])

    plugin.close()
    client.disconnect()
  })

  it('DROPS a push whose meta.fileKey is absent or empty', async () => {
    const mgr = spyManager()
    const client = createFigmaClient(WS)
    await client.joinChannel('ch-drop', 'fk-drop')
    client.onRequest(
      'document_changed',
      createDocumentChangedHandler(mgr),
    )

    const plugin = await rawPlugin()
    plugin.send(
      JSON.stringify({ type: 'join', channel: 'ch-drop' }),
    )
    await Bun.sleep(30)
    for (const meta of [
      {},
      { fileKey: '' },
      { fileKey: null },
    ]) {
      plugin.send(
        JSON.stringify({
          type: 'message',
          channel: 'ch-drop',
          message: {
            command: 'document_changed',
            params: {
              changes: [],
              indexStale: true,
              at: 1,
            },
            meta,
          },
        }),
      )
    }
    await Bun.sleep(50)

    // Unroutable: no buffer to reach, and inventing a route violates B3.
    expect(mgr.staled).toEqual([])

    plugin.close()
    client.disconnect()
  })
})
