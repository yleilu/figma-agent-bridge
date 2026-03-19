import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import type { Server } from 'bun'
import type { FigmaClient } from '../../../packages/server/src/figma-client'
import {
  startRelay,
  stopRelay,
} from '../../../packages/relay/src/relay'
import {
  handleConnect,
  handleStatus,
} from '../../../packages/server/src/tools/session'

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

  it('returns connected with channel info', async () => {
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
    expect(result.content[0].text).toContain('connected')
    expect(result.content[0].text).toContain('my-channel')
  })
})
