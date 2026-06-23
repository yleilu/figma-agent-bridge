import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import type { Server } from 'bun'
import type {
  BroadcastMessage,
  ChannelMessage,
} from '@figma-agent-bridge/shared/types'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import {
  createFigmaClient,
  discoverChannels,
} from '@figma-agent-bridge/server/figma-client'

const TEST_PORT = 3098
const WS_URL = `ws://localhost:${TEST_PORT}`
const HTTP_URL = `http://localhost:${TEST_PORT}`

const connectRaw = (): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    ws.onopen = () => {
      resolve(ws)
    }
    ws.onerror = () => {
      reject(new Error('WebSocket connection failed'))
    }
  })

const createMessageQueue = (ws: WebSocket) => {
  const queue: unknown[] = []
  let waiter: ((value: unknown) => void) | null = null

  ws.onmessage = event => {
    const parsed = JSON.parse(event.data as string)
    if (waiter !== null) {
      const resolve = waiter
      waiter = null
      resolve(parsed)
    } else {
      queue.push(parsed)
    }
  }

  return (): Promise<unknown> =>
    new Promise(resolve => {
      const first = queue.shift()
      if (first !== undefined) {
        resolve(first)
      } else {
        waiter = resolve
      }
    })
}

const closeWs = (ws: WebSocket): Promise<void> =>
  new Promise(resolve => {
    ws.onclose = () => {
      resolve()
    }
    ws.close()
  })

describe('figma-client', () => {
  let server: Server<{ id: string }>

  beforeEach(() => {
    server = startRelay(TEST_PORT)
  })

  afterEach(() => {
    stopRelay(server)
  })

  it('connects to relay and joins channel', async () => {
    const client = createFigmaClient(WS_URL)

    const result = await client.joinChannel('test-ch')

    expect(result).toContain('test-ch')
    expect(client.isConnected()).toBe(true)
    expect(client.currentChannel()).toBe('test-ch')

    client.disconnect()
  })

  it('sends command and receives response', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('echo-ch')

    // Set up echo mock plugin
    const plugin = await connectRaw()
    const nextMessage = createMessageQueue(plugin)

    plugin.send(
      JSON.stringify({
        type: 'join',
        channel: 'echo-ch',
      }),
    )
    // Wait for system confirmation
    await nextMessage()

    // Listen for commands and echo them back
    plugin.onmessage = (event: MessageEvent) => {
      const msg = JSON.parse(
        event.data as string,
      ) as BroadcastMessage

      if (msg.type !== 'broadcast') {
        return
      }

      const { message } = msg
      const reply: ChannelMessage = {
        type: 'message',
        channel: 'echo-ch',
        message: {
          id: message.id,
          command: message.command,
          result: { echo: message.command },
        },
      }
      plugin.send(JSON.stringify(reply))
    }

    const response = await client.sendCommand('ping', {
      value: 42,
    })

    expect(response).toEqual({ echo: 'ping' })

    await closeWs(plugin)
    client.disconnect()
  })

  it('times out when no response', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('timeout-ch')

    let caught: Error | null = null

    try {
      await client.sendCommand('slow', {}, 500)
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect((caught as Error).message).toContain('timed out')

    client.disconnect()
  })

  it('rejects a concurrent join while one is in progress', async () => {
    const client = createFigmaClient(WS_URL)

    const first = client.joinChannel('serial-ch')
    let caught: Error | null = null
    try {
      await client.joinChannel('serial-ch-2')
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect((caught as Error).message).toBe(
      'Join already in progress',
    )

    // first join still resolves normally
    const result = await first
    expect(result).toContain('serial-ch')

    client.disconnect()
  })

  it('rejects a pending join when the socket disconnects', async () => {
    // Use a silent server that accepts the WebSocket but never sends a
    // system frame, so joinPending remains set when the server closes.
    // This exercises the onclose → rejectAll → joinPending rejection path.
    const SILENT_PORT = TEST_PORT + 1
    const silentServer = Bun.serve({
      port: SILENT_PORT,
      hostname: '127.0.0.1',
      fetch(req, srv) {
        const upgraded = srv.upgrade(req, { data: {} })
        if (upgraded) {
          return undefined
        }
        return new Response('ws only', { status: 426 })
      },
      websocket: {
        open() {
          // accept without replying
        },
        message() {
          // intentionally ignore join frames so joinPending stays set
        },
        close() {},
      },
    })

    const client = createFigmaClient(
      `ws://127.0.0.1:${SILENT_PORT}`,
    )

    const joinPromise = client.joinChannel('drop-ch')
    // Give the socket a tick to open + send the join frame.
    await Bun.sleep(50)
    // Tear down the silent server to force an onclose → rejectAll.
    silentServer.stop(true)

    let caught: Error | null = null
    try {
      await joinPromise
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect((caught as Error).message).toBe('Disconnected')
  })

  it('rejects an in-flight sendCommand when the socket closes', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('inflight-ch')

    // No plugin echoes back, so this command stays pending.
    const cmd = client.sendCommand('slow', {}, 30_000)
    await Bun.sleep(50)
    stopRelay(server)

    let caught: Error | null = null
    try {
      await cmd
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect((caught as Error).message).toBe('Disconnected')

    server = startRelay(TEST_PORT)
  })
})

describe('discoverChannels', () => {
  let server: Server<{ id: string }>

  beforeEach(() => {
    server = startRelay(TEST_PORT)
  })

  afterEach(() => {
    stopRelay(server)
  })

  it('returns channel list from relay', async () => {
    const ws = await connectRaw()
    const next = createMessageQueue(ws)

    ws.send(
      JSON.stringify({
        type: 'join',
        channel: 'discover-ch',
      }),
    )
    await next()

    const result = await discoverChannels(HTTP_URL)
    expect(result).toHaveLength(1)
    expect(result[0].channel).toBe('discover-ch')

    await closeWs(ws)
  })

  it('returns empty when relay unreachable', async () => {
    stopRelay(server)

    const result = await discoverChannels(
      'http://localhost:19999',
    )
    expect(result).toEqual([])

    // Restart for afterEach cleanup
    server = startRelay(TEST_PORT)
  })
})
