import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import type { Server } from 'bun'
import {
  COMMANDS,
  APP_VERSION,
} from '@figma-agent-bridge/shared'
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

// Helper: join a channel and send a matching register (simulates a real plugin)
const joinAndRegister = async (
  ws: WebSocket,
  channel: string,
): Promise<void> => {
  ws.send(JSON.stringify({ type: 'join', channel }))
  await waitForMessage(ws)
  ws.send(
    JSON.stringify({
      type: 'register',
      channel,
      fileName: null,
      version: APP_VERSION,
    }),
  )
  await Bun.sleep(30)
}

describe('handleConnect', () => {
  it('returns success with channel', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve('joined test-ch'),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => true,
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

  it('does NOT auto-join a sole channel — asks (B3)', async () => {
    const ws = await connectRaw()

    await joinAndRegister(ws, 'auto-ch')

    const calls: string[] = []
    const mockClient: FigmaClient = {
      joinChannel: ch => {
        calls.push(ch)
        return Promise.resolve(`joined ${ch}`)
      },
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => true,
    }

    const result = await handleConnect(
      {},
      mockClient,
      HTTP_URL,
      TEST_PORT,
    )

    expect(result.content[0].text).toContain('auto-ch')
    expect(calls).toEqual([])

    await closeWs(ws)
  })

  it('returns channel list when multiple channels', async () => {
    const ws1 = await connectRaw()
    await joinAndRegister(ws1, 'multi-1')

    const ws2 = await connectRaw()
    await joinAndRegister(ws2, 'multi-2')

    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
    }

    const result = await handleConnect(
      {},
      mockClient,
      HTTP_URL,
      TEST_PORT,
    )

    expect(result.content[0].text).toContain(
      'No target file specified',
    )
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
  it('returns disconnected when no file is joined', async () => {
    const mockClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      joinedFiles: () => [],
      channelFor: () => null,
    } as unknown as FigmaClient

    const result = await handleStatus(mockClient)

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBe('disconnected')
  })

  // When the plugin returns NO live context (null), status still reports the
  // structured connection state — a joined[] entry with the live fields absent.
  // Asserted on parsed JSON, not loose substring overlap.
  it('reports the joined file with no live context', async () => {
    const mockClient = {
      joinChannel: () =>
        Promise.resolve('joined my-channel'),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => true,
      joinedFiles: () => ['fk-1'],
      channelFor: () => 'my-channel',
    } as unknown as FigmaClient

    const result = await handleStatus(mockClient)

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    const out = JSON.parse(result.content[0].text) as {
      connected: boolean
      available?: unknown
      joined: {
        fileKey: string
        channel: string
        currentPage?: unknown
        selection?: unknown
        viewport?: unknown
      }[]
    }
    expect(out.connected).toBe(true)
    expect(out.joined[0].fileKey).toBe('fk-1')
    expect(out.joined[0].channel).toBe('my-channel')
    expect(out.available).toEqual([])
    expect(out.joined[0].currentPage).toBeUndefined()
    expect(out.joined[0].selection).toBeUndefined()
    expect(out.joined[0].viewport).toBeUndefined()
  })

  // status merges LIVE context (currentPage / selection / viewport) read PER
  // FILE via COMMANDS.STATUS; sendCommand now takes (fileKey, command, …).
  it('merges the plugin live context (currentPage, selection, viewport)', async () => {
    const sent: { fileKey: string; command: string }[] = []
    const mockClient = {
      joinChannel: () => Promise.resolve('joined'),
      sendCommand: (fileKey: string, command: string) => {
        sent.push({ fileKey, command })
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
      joinedFiles: () => ['live-key'],
      channelFor: () => 'live-ch',
    } as unknown as FigmaClient

    const result = await handleStatus(mockClient)
    // Read the live context on the joined file's key with the STATUS command.
    expect(sent[0].fileKey).toBe('live-key')
    expect(sent[0].command).toBe(COMMANDS.STATUS)
    const out = JSON.parse(result.content[0].text) as {
      connected: boolean
      joined: {
        fileKey: string
        channel: string
        currentPage: { id: string; name: string }
        selection: { id: string; type: string }[]
        viewport: {
          center: { x: number; y: number }
          zoom: number
        }
      }[]
    }
    expect(out.connected).toBe(true)
    expect(out.joined[0].fileKey).toBe('live-key')
    expect(out.joined[0].channel).toBe('live-ch')
    expect(out.joined[0].currentPage).toEqual({
      id: 'page:1',
      name: 'Main',
    })
    expect(out.joined[0].selection[0].type).toBe('FRAME')
    expect(out.joined[0].viewport.zoom).toBe(2)
  })

  // Honesty: a FAILED live-context read still reports connection state — status
  // never throws and never hallucinates a context.
  it('still reports connection state when the live-context read fails', async () => {
    const mockClient = {
      joinChannel: () => Promise.resolve('joined'),
      sendCommand: () =>
        Promise.reject(new Error('command timed out')),
      disconnect: () => undefined,
      isConnected: () => true,
      joinedFiles: () => ['fk-degraded'],
      channelFor: () => 'degraded-ch',
    } as unknown as FigmaClient

    const result = await handleStatus(mockClient)
    const out = JSON.parse(result.content[0].text) as {
      connected: boolean
      joined: { channel: string; currentPage?: unknown }[]
    }
    expect(out.connected).toBe(true)
    expect(out.joined[0].channel).toBe('degraded-ch')
    expect(out.joined[0].currentPage).toBeUndefined()
  })
})
