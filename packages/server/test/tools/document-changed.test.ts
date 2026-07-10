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

const PORT = 3103
const WS = `ws://localhost:${PORT}`

describe('document_changed push', () => {
  let server: Server<{ id: string }>
  beforeEach(() => {
    server = startRelay(PORT)
  })
  afterEach(() => {
    stopRelay(server)
  })

  it('dispatches by command + params.fileId (no meta, no reply)', async () => {
    const client = createFigmaClient(WS)
    await client.joinChannel('ch-dc', 'fk-dc')
    let markedStale: string | null = null
    client.onRequest('document_changed', params => {
      if (typeof params.fileId === 'string') {
        markedStale = params.fileId
      }
      return { ok: true }
    })

    // Raw plugin pushes a document_changed frame: command + params.fileId, NO meta.
    const plugin = await new Promise<WebSocket>(
      (res, rej) => {
        const s = new WebSocket(WS)
        s.onopen = () => res(s)
        s.onerror = () => rej(new Error('connect failed'))
      },
    )
    const seen: unknown[] = []
    plugin.onmessage = e =>
      seen.push(JSON.parse(e.data as string))
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
          params: { fileId: 'fk-dc' },
        },
      }),
    )
    await Bun.sleep(50)

    expect(markedStale).toBe('fk-dc') // markStale fired for the right key
    // No reply frame was broadcast back for a push (rid undefined → no sendReply).
    expect(
      seen.some(
        m => (m as { type?: string }).type === 'broadcast',
      ),
    ).toBe(false)

    plugin.close()
    client.disconnect()
  })
})
