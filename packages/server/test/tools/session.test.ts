import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import type { Server } from 'bun'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import {
  handleConnect,
  handleStatus,
} from '@figma-agent-bridge/server/tools/session'

const TEST_PORT = 3096
const HTTP_URL = `http://localhost:${TEST_PORT}`
const WS_URL = `ws://localhost:${TEST_PORT}`

const connectRaw = (): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    ws.onopen = () => resolve(ws)
    ws.onerror = () =>
      reject(new Error('Connection failed'))
  })

const waitForMessage = (ws: WebSocket): Promise<unknown> =>
  new Promise(resolve => {
    ws.onmessage = event => {
      resolve(JSON.parse(event.data as string))
    }
  })

const closeWs = (ws: WebSocket): Promise<void> =>
  new Promise(resolve => {
    ws.onclose = () => resolve()
    ws.close()
  })

describe('handleConnect', () => {
  it('returns success with channel', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve('joined test-ch'),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleConnect(
      { channel: 'test-ch' },
      mockClient,
    )

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('test-ch')
  })
})

describe('handleConnect auto-discovery', () => {
  let server: Server<{ id: string }>

  beforeEach(() => {
    server = startRelay(TEST_PORT)
  })

  afterEach(() => {
    stopRelay(server)
  })

  it('auto-joins when exactly one channel available', async () => {
    const ws = await connectRaw()

    ws.send(
      JSON.stringify({
        type: 'join',
        channel: 'auto-ch',
      }),
    )
    await waitForMessage(ws)

    const calls: string[] = []
    const mockClient: FigmaClient = {
      joinChannel: ch => {
        calls.push(ch)
        return Promise.resolve(`joined ${ch}`)
      },
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => calls[0] ?? null,
    }

    const result = await handleConnect(
      {},
      mockClient,
      HTTP_URL,
      TEST_PORT,
    )

    expect(result.content[0].text).toContain('auto-ch')
    expect(calls).toEqual(['auto-ch'])

    await closeWs(ws)
  })

  it('returns channel list when multiple channels', async () => {
    const ws1 = await connectRaw()
    ws1.send(
      JSON.stringify({
        type: 'join',
        channel: 'multi-1',
      }),
    )
    await waitForMessage(ws1)

    const ws2 = await connectRaw()
    ws2.send(
      JSON.stringify({
        type: 'join',
        channel: 'multi-2',
      }),
    )
    await waitForMessage(ws2)

    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleConnect(
      {},
      mockClient,
      HTTP_URL,
      TEST_PORT,
    )

    expect(result.content[0].text).toContain('Multiple')
    expect(result.content[0].text).toContain('multi-1')
    expect(result.content[0].text).toContain('multi-2')

    await closeWs(ws1)
    await closeWs(ws2)
  })

  it('returns error when no channels', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleConnect(
      {},
      mockClient,
      HTTP_URL,
      TEST_PORT,
    )

    expect(result.content[0].text).toContain(
      'No Figma plugins connected',
    )
  })

  it('explicit channel bypasses discovery', async () => {
    const calls: string[] = []
    const mockClient: FigmaClient = {
      joinChannel: ch => {
        calls.push(ch)
        return Promise.resolve(`joined ${ch}`)
      },
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => calls[0] ?? null,
    }

    const result = await handleConnect(
      { channel: 'explicit-ch' },
      mockClient,
      HTTP_URL,
      TEST_PORT,
    )

    expect(result.content[0].text).toContain('explicit-ch')
    expect(calls).toEqual(['explicit-ch'])
  })
})

describe('handleStatus', () => {
  it('returns disconnected when no channel', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleStatus(mockClient)

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBe('disconnected')
  })

  // D1: when the plugin returns NO live context (null), status still reports
  // the structured connection state — {connected, channel} with the live
  // fields absent. Asserted on parsed JSON, not loose substring overlap.
  it('returns the structured {connected, channel} when there is no live context', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () =>
        Promise.resolve('joined my-channel'),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'my-channel',
    }

    const result = await handleStatus(mockClient)

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    const out = JSON.parse(result.content[0].text) as {
      connected: boolean
      channel: string
      currentPage?: unknown
      selection?: unknown
      viewport?: unknown
    }
    expect(out.connected).toBe(true)
    expect(out.channel).toBe('my-channel')
    expect(out.currentPage).toBeUndefined()
    expect(out.selection).toBeUndefined()
    expect(out.viewport).toBeUndefined()
  })

  // D1: status merges LIVE context (currentPage / selection / viewport) read
  // from the plugin via COMMANDS.STATUS with the server-side connection state.
  it('merges the plugin live context (currentPage, selection, viewport)', async () => {
    const sent: { command: string }[] = []
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve('joined'),
      sendCommand: (command: string) => {
        sent.push({ command })
        return Promise.resolve({
          currentPage: { id: 'page:1', name: 'Main' },
          selection: [
            { id: '1:42', name: 'Card', type: 'FRAME' },
          ],
          viewport: {
            center: { x: 10, y: 20 },
            zoom: 2,
          },
        })
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'live-ch',
    }

    const result = await handleStatus(mockClient)
    // Sent the STATUS command to read the live context.
    expect(sent[0].command).toBe(COMMANDS.STATUS)
    const out = JSON.parse(result.content[0].text) as {
      connected: boolean
      channel: string
      currentPage: { id: string; name: string }
      selection: { id: string; type: string }[]
      viewport: {
        center: { x: number; y: number }
        zoom: number
      }
    }
    expect(out.connected).toBe(true)
    expect(out.channel).toBe('live-ch')
    expect(out.currentPage).toEqual({
      id: 'page:1',
      name: 'Main',
    })
    expect(out.selection[0].type).toBe('FRAME')
    expect(out.viewport.zoom).toBe(2)
  })

  // D1 honesty: a FAILED live-context read still reports connection state — the
  // status never throws and never hallucinates a context.
  it('still reports connection state when the live-context read fails', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve('joined'),
      sendCommand: () =>
        Promise.reject(new Error('command timed out')),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'degraded-ch',
    }

    const result = await handleStatus(mockClient)
    const out = JSON.parse(result.content[0].text) as {
      connected: boolean
      channel: string
      currentPage?: unknown
    }
    expect(out.connected).toBe(true)
    expect(out.channel).toBe('degraded-ch')
    expect(out.currentPage).toBeUndefined()
  })
})
