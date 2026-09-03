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
import { createMockPlugin } from '../mocks/mock-plugin'

const PORT = 3111
const WS_URL = `ws://localhost:${PORT}`

type Frame = {
  type: string
  message: {
    meta?: { requestId?: string; fileKey?: string | null }
    result?: unknown
    error?: string
  }
}

const connectRaw = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = () =>
      reject(new Error('raw connect failed'))
  })

// Arm the handler BEFORE sending, so a fast reply can't race the listener.
const nextFrame = (ws: WebSocket): Promise<Frame> =>
  new Promise(resolve => {
    ws.onmessage = e =>
      resolve(JSON.parse(e.data as string) as Frame)
  })

const CARD = [{ id: '1:42', name: 'Card', type: 'FRAME' }]

describe('targetFileKey identity guard (mock refuses mismatched targets)', () => {
  let server: Server<{ id: string }>
  let plugin: ReturnType<typeof createMockPlugin> | null =
    null

  beforeEach(() => {
    server = startRelay(PORT)
  })

  afterEach(() => {
    if (plugin !== null) {
      plugin.stop()
      plugin = null
    }
    stopRelay(server)
  })

  it('refuses a mismatched target, executes a matching one, executes an unaddressed one', async () => {
    plugin = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'guard-ch',
      fileKey: 'file-A',
      documentName: 'File A',
    })
    await plugin.start()

    const ws = await connectRaw(WS_URL)
    const sysP = nextFrame(ws)
    ws.send(
      JSON.stringify({ type: 'join', channel: 'guard-ch' }),
    )
    await sysP // "Connected to channel" system ack

    // mismatch → refused (typed error), NOT executed
    const missP = nextFrame(ws)
    ws.send(
      JSON.stringify({
        type: 'message',
        channel: 'guard-ch',
        message: {
          meta: { fileKey: 'file-B', requestId: 'm1' },
          command: 'get_selection',
          params: {},
        },
      }),
    )
    const miss = await missP
    expect(miss.type).toBe('broadcast')
    expect(miss.message.meta?.requestId).toBe('m1')
    expect(miss.message.error).toBeUndefined()
    const missErr = (
      miss.message.result as { error?: string }
    ).error
    expect(missErr).toContain('file-B')
    expect(missErr).toContain('file-A')

    // match → executes normally
    const okP = nextFrame(ws)
    ws.send(
      JSON.stringify({
        type: 'message',
        channel: 'guard-ch',
        message: {
          meta: { fileKey: 'file-A', requestId: 'm2' },
          command: 'get_selection',
          params: {},
        },
      }),
    )
    const ok = await okP
    expect(ok.message.meta?.requestId).toBe('m2')
    expect(ok.message.error).toBeUndefined()
    expect(ok.message.result).toEqual(CARD)

    // unaddressed (null target) → executes (honest degrade, unchanged behavior)
    const unP = nextFrame(ws)
    ws.send(
      JSON.stringify({
        type: 'message',
        channel: 'guard-ch',
        message: {
          meta: { fileKey: null, requestId: 'm3' },
          command: 'get_selection',
          params: {},
        },
      }),
    )
    const un = await unP
    expect(un.message.meta?.requestId).toBe('m3')
    expect(un.message.error).toBeUndefined()
    expect(un.message.result).toEqual(CARD)

    ws.close()
  })

  it('a plugin whose own fileKey is unavailable cannot verify → executes (documented honest degrade)', async () => {
    plugin = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'unsaved-guard-ch',
      documentName: 'Untitled',
    }) // fileKey defaults to null

    await plugin.start()

    const ws = await connectRaw(WS_URL)
    const sysP = nextFrame(ws)
    ws.send(
      JSON.stringify({
        type: 'join',
        channel: 'unsaved-guard-ch',
      }),
    )
    await sysP

    const p = nextFrame(ws)
    ws.send(
      JSON.stringify({
        type: 'message',
        channel: 'unsaved-guard-ch',
        message: {
          meta: { fileKey: 'file-B', requestId: 'n1' },
          command: 'get_selection',
          params: {},
        },
      }),
    )
    const r = await p
    expect(r.message.error).toBeUndefined()
    expect(r.message.result).toEqual(CARD)

    ws.close()
  })
})
