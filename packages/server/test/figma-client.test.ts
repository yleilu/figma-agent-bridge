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
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
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

    const result = await client.joinChannel(
      'test-ch',
      'fk-test',
    )

    expect(result).toContain('test-ch')
    expect(client.isConnected()).toBe(true)
    expect(client.channelFor('fk-test')).toBe('test-ch')

    client.disconnect()
  })

  it('sends command and receives response', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('echo-ch', 'fk-echo')

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
          meta: { requestId: message.meta?.requestId },
          command: message.command,
          result: { echo: message.command },
        },
      }
      plugin.send(JSON.stringify(reply))
    }

    const response = await client.sendCommand(
      'fk-echo',
      'ping',
      {
        value: 42,
      },
    )

    expect(response).toEqual({ echo: 'ping' })

    await closeWs(plugin)
    client.disconnect()
  })

  it('notify broadcasts a fire-and-forget frame with no reply expected', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('notify-ch', 'fk-notify')

    const plugin = await connectRaw()
    const nextMessage = createMessageQueue(plugin)
    plugin.send(
      JSON.stringify({
        type: 'join',
        channel: 'notify-ch',
      }),
    )
    // Wait for system confirmation.
    await nextMessage()

    client.notify('feedback-added', {
      item: { path: 'bugs/x.md', title: 'x' },
    })

    const received =
      (await nextMessage()) as BroadcastMessage
    expect(received.type).toBe('broadcast')
    expect(received.message.command).toBe('feedback-added')
    expect(
      (
        received.message.params as {
          item: { path: string }
        }
      ).item.path,
    ).toBe('bugs/x.md')
    expect(received.message.result).toBeUndefined()

    await closeWs(plugin)
    client.disconnect()
  })

  it('onRequest handles an inbound command and replies with a correlated result', async () => {
    const CHANNEL = 'req-ch'
    const client = createFigmaClient(WS_URL)
    await client.joinChannel(CHANNEL, 'fk-req')

    const rawPlugin = await connectRaw()
    const pluginQueue = createMessageQueue(rawPlugin)
    rawPlugin.send(
      JSON.stringify({ type: 'join', channel: CHANNEL }),
    )
    // Wait for system confirmation.
    await pluginQueue()

    client.onRequest(
      'feedback-sync',
      async (params: Record<string, unknown>) => ({
        echoed: params.marker,
      }),
    )

    rawPlugin.send(
      JSON.stringify({
        type: 'message',
        channel: CHANNEL,
        message: {
          meta: { requestId: 'req-1' },
          command: 'feedback-sync',
          params: { marker: 7 },
        },
      }),
    )

    const reply = (await pluginQueue()) as BroadcastMessage
    expect(reply.type).toBe('broadcast')
    expect(reply.message.meta?.requestId).toBe('req-1')
    expect(
      (reply.message.result as { echoed: number }).echoed,
    ).toBe(7)

    await closeWs(rawPlugin)
    client.disconnect()
  })

  it('onRequest replies with an error when the handler throws', async () => {
    const CHANNEL = 'req-err-ch'
    const client = createFigmaClient(WS_URL)
    await client.joinChannel(CHANNEL, 'fk-req-err')

    const rawPlugin = await connectRaw()
    const pluginQueue = createMessageQueue(rawPlugin)
    rawPlugin.send(
      JSON.stringify({ type: 'join', channel: CHANNEL }),
    )
    await pluginQueue()

    client.onRequest('send-feedback', async () => {
      throw new Error('boom')
    })

    rawPlugin.send(
      JSON.stringify({
        type: 'message',
        channel: CHANNEL,
        message: {
          meta: { requestId: 'req-2' },
          command: 'send-feedback',
          params: {},
        },
      }),
    )

    const reply = (await pluginQueue()) as BroadcastMessage
    expect(reply.message.meta?.requestId).toBe('req-2')
    expect(reply.message.error).toContain('boom')

    await closeWs(rawPlugin)
    client.disconnect()
  })

  it('times out when no response', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('timeout-ch', 'fk-timeout')

    let caught: Error | null = null

    try {
      await client.sendCommand(
        'fk-timeout',
        'slow',
        {},
        500,
      )
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect((caught as Error).message).toContain('timed out')

    client.disconnect()
  })

  it('dedupes concurrent joins of the SAME file to one resolved promise', async () => {
    const client = createFigmaClient(WS_URL)
    const [r1, r2] = await Promise.all([
      client.joinChannel('dedupe-ch', 'fk-dedupe'),
      client.joinChannel('dedupe-ch', 'fk-dedupe'),
    ])
    expect(r1).toContain('dedupe-ch')
    expect(r2).toContain('dedupe-ch')
    expect(client.joinedFiles()).toEqual(['fk-dedupe'])
    client.disconnect()
  })

  it('concurrent joins of DIFFERENT files both succeed (queued)', async () => {
    const client = createFigmaClient(WS_URL)
    const [ra, rb] = await Promise.all([
      client.joinChannel('q-a', 'fk-q-a'),
      client.joinChannel('q-b', 'fk-q-b'),
    ])
    expect(ra).toContain('q-a')
    expect(rb).toContain('q-b')
    expect(client.joinedFiles().sort()).toEqual([
      'fk-q-a',
      'fk-q-b',
    ])
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

    const joinPromise = client.joinChannel(
      'drop-ch',
      'fk-drop',
    )
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

  it('rejects join with "Join timed out" when relay never confirms', async () => {
    // A silent ws server: upgrades, but never answers the join frame.
    const silent = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) {
          return undefined
        }
        return new Response('no', { status: 400 })
      },
      websocket: { message() {} },
    })
    const silentUrl = `ws://localhost:${silent.port}`

    const client = createFigmaClient(silentUrl, 200)

    let caught: Error | null = null
    try {
      await client.joinChannel('never-ch', 'fk-never')
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect((caught as Error).message).toBe('Join timed out')

    client.disconnect()
    silent.stop(true)
  })

  it('ignores a malformed inbound frame and still serves later commands', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('robust-ch', 'fk-robust')

    const plugin = await connectRaw()
    const nextMessage = createMessageQueue(plugin)
    plugin.send(
      JSON.stringify({
        type: 'join',
        channel: 'robust-ch',
      }),
    )
    await nextMessage()

    plugin.onmessage = (event: MessageEvent) => {
      const msg = JSON.parse(
        event.data as string,
      ) as BroadcastMessage
      if (msg.type !== 'broadcast') {
        return
      }
      // First send a garbage frame the client must ignore, then the real reply.
      plugin.send(JSON.stringify({ type: 'broadcast' })) // missing `message`
      const reply: ChannelMessage = {
        type: 'message',
        channel: 'robust-ch',
        message: {
          meta: { requestId: msg.message.meta?.requestId },
          command: msg.message.command,
          result: { ok: true },
        },
      }
      plugin.send(JSON.stringify(reply))
    }

    const response = await client.sendCommand(
      'fk-robust',
      'ping',
      {},
      2000,
    )
    expect(response).toEqual({ ok: true })

    await closeWs(plugin)
    client.disconnect()
  })

  it('sendCommand rejects with "Not connected" before any join', async () => {
    const client = createFigmaClient(WS_URL)

    let caught: Error | null = null
    try {
      await client.sendCommand('fk-none', 'noop')
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect((caught as Error).message).toBe('Not connected')
    expect(client.isConnected()).toBe(false)
    expect(client.joinedFiles()).toEqual([])
  })

  it('two sequential joins reuse a single OPEN socket', async () => {
    const client = createFigmaClient(WS_URL)

    const r1 = await client.joinChannel('seq-a', 'fk-seq-a')
    expect(r1).toContain('seq-a')

    // Second join after the first resolved: socket is OPEN, connect()
    // must reuse it (no throw; the second file joins on the same socket).
    const r2 = await client.joinChannel('seq-b', 'fk-seq-b')
    expect(r2).toContain('seq-b')
    expect(client.channelFor('fk-seq-b')).toBe('seq-b')

    client.disconnect()
  })

  it('rejects joinChannel and stays disconnected when relay sends an Error: frame', async () => {
    // Stand up a tiny WS server that always replies with the relay's rejection
    // system frame format ("Error: <reason>"), simulating cap-exceeded responses.
    const rejectServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req, srv) {
        if (srv.upgrade(req)) {
          return undefined
        }
        return new Response('ws only', { status: 426 })
      },
      websocket: {
        open() {},
        message(ws) {
          // Reply with a rejection system frame (same format as relay rejectJoin).
          ws.send(
            JSON.stringify({
              type: 'system',
              message: {
                id: 'reject-id',
                result:
                  'Error: member limit reached for this channel',
              },
            }),
          )
        },
        close() {},
      },
    })

    const client = createFigmaClient(
      `ws://127.0.0.1:${rejectServer.port}`,
    )

    let caught: Error | null = null
    try {
      await client.joinChannel('full-ch', 'fk-full')
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect((caught as Error).message).toContain('Error:')
    expect(client.isConnected()).toBe(false)
    expect(client.joinedFiles()).toEqual([])

    client.disconnect()
    rejectServer.stop(true)
  })

  it('joinChannel while socket is CONNECTING opens a fresh socket and succeeds', async () => {
    const client = createFigmaClient(WS_URL)

    // Kick a join and immediately disconnect to leave ws === null,
    // then a new join must create a brand-new socket (CONNECTING path).
    client
      .joinChannel('connecting-ch', 'fk-connecting')
      .catch(() => {})
    client.disconnect()

    const result = await client.joinChannel(
      'fresh-ch',
      'fk-fresh',
    )
    expect(result).toContain('fresh-ch')
    expect(client.isConnected()).toBe(true)

    client.disconnect()
  })

  it('rejects an in-flight sendCommand when the socket closes', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('inflight-ch', 'fk-inflight')

    // No plugin echoes back, so this command stays pending.
    const cmd = client.sendCommand(
      'fk-inflight',
      'slow',
      {},
      30_000,
    )
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

describe('isInstanceDead', () => {
  // TEST-ONLY seam: the watchdog (L6) sets `deadInstances` directly via the
  // closure; this cast reaches the same test-only setter to seed a dead
  // entry ahead of that watchdog existing. Not part of the FigmaClient contract.
  const seedDead = (
    client: FigmaClient,
    fileKey: string,
    connectedAt: number,
  ): void => {
    const withSeam = client as unknown as {
      __markDeadForTest: (
        fileKey: string,
        connectedAt: number,
      ) => void
    }
    withSeam.__markDeadForTest(fileKey, connectedAt)
  }

  it('is true while the live connectedAt matches the declared-dead value', () => {
    const client = createFigmaClient(WS_URL)
    seedDead(client, 'fk-dead', 100)

    expect(client.isInstanceDead('fk-dead', 100)).toBe(true)
  })

  it('self-clears on a fresher connectedAt (reconnect) and stays clear', () => {
    const client = createFigmaClient(WS_URL)
    seedDead(client, 'fk-dead', 100)

    expect(client.isInstanceDead('fk-dead', 200)).toBe(
      false,
    )
    // Marker was cleared by the mismatch above — still false on a second call.
    expect(client.isInstanceDead('fk-dead', 200)).toBe(
      false,
    )
  })

  it('returns false for a fileKey with no declared-dead entry', () => {
    const client = createFigmaClient(WS_URL)
    expect(client.isInstanceDead('fk-never-dead', 1)).toBe(
      false,
    )
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

describe('figma-client meta stamping', () => {
  const CAP_PORT = 3099
  const CAP_WS = `ws://localhost:${CAP_PORT}`

  const startCaptureServer = (port: number) => {
    const frames: {
      type?: string
      channel?: string
      message?: {
        command?: string
        meta?: {
          fileKey?: string | null
          requestId?: string
        }
      }
    }[] = []
    const server = Bun.serve({
      port,
      fetch(req, srv) {
        if (srv.upgrade(req)) {
          return undefined
        }
        return new Response('ws only', { status: 426 })
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(raw as string)
          frames.push(msg)
          if (msg.type === 'join') {
            // Ack the join with a relay-shaped system frame so joinChannel resolves.
            ws.send(
              JSON.stringify({
                type: 'system',
                message: {
                  id: 'sys',
                  result: `Joined ${msg.channel}`,
                },
              }),
            )
          }
        },
      },
    })
    return { server, frames }
  }

  it('stamps meta { fileKey, requestId } on outbound commands', async () => {
    const { server, frames } = startCaptureServer(CAP_PORT)
    const client = createFigmaClient(CAP_WS)

    await client.joinChannel('cap-ch', 'file-key-123')
    expect(client.channelFor('file-key-123')).toBe('cap-ch')

    // Fire a command; the capture server never replies, so do not await it.
    // Attach a no-op catch so the teardown disconnect (which rejects the still
    // -pending command) does not surface as an unhandled rejection.
    void client
      .sendCommand('file-key-123', 'status', { foo: 'bar' })
      .catch(() => {})
    await Bun.sleep(30)

    const cmdFrame = frames.find(f => f.type === 'message')
    expect(cmdFrame?.message?.command).toBe('status')
    expect(cmdFrame?.message?.meta?.fileKey).toBe(
      'file-key-123',
    )
    expect(typeof cmdFrame?.message?.meta?.requestId).toBe(
      'string',
    )

    client.disconnect()
    server.stop(true)
  })
})

describe('figma-client multi-file + meta', () => {
  let server: Server<{ id: string }>

  beforeEach(() => {
    server = startRelay(TEST_PORT)
  })
  afterEach(() => {
    stopRelay(server)
  })

  it('routes a command by fileKey and stamps meta { fileKey, requestId }', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('ch-a', 'fk-a')
    await client.joinChannel('ch-b', 'fk-b')
    expect(client.joinedFiles().sort()).toEqual([
      'fk-a',
      'fk-b',
    ])
    expect(client.channelFor('fk-a')).toBe('ch-a')
    expect(client.channelFor('fk-missing')).toBeNull()

    const pluginA = await connectRaw()
    const queueA = createMessageQueue(pluginA)
    pluginA.send(
      JSON.stringify({ type: 'join', channel: 'ch-a' }),
    )
    await queueA()
    pluginA.onmessage = (event: MessageEvent) => {
      const msg = JSON.parse(
        event.data as string,
      ) as BroadcastMessage
      if (msg.type !== 'broadcast') {
        return
      }
      // Echo the meta.fileKey back and correlate by meta.requestId.
      const reply: ChannelMessage = {
        type: 'message',
        channel: 'ch-a',
        message: {
          meta: { requestId: msg.message.meta?.requestId },
          result: {
            on: 'a',
            target: msg.message.meta?.fileKey,
          },
        },
      }
      pluginA.send(JSON.stringify(reply))
    }

    const res = await client.sendCommand('fk-a', 'ping', {})
    expect(res).toEqual({ on: 'a', target: 'fk-a' })

    await closeWs(pluginA)
    client.disconnect()
  })

  it('forFile routes without a fileKey arg and lifts sessionId into meta when present', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('ch-s', 'fk-s')
    expect(client.forFile('fk-s').fileKey).toBe('fk-s')

    const plugin = await connectRaw()
    const q = createMessageQueue(plugin)
    plugin.send(
      JSON.stringify({ type: 'join', channel: 'ch-s' }),
    )
    await q()
    plugin.onmessage = (event: MessageEvent) => {
      const msg = JSON.parse(
        event.data as string,
      ) as BroadcastMessage
      if (msg.type !== 'broadcast') {
        return
      }
      // Echo back the meta the server stamped, so the test can assert it.
      plugin.send(
        JSON.stringify({
          type: 'message',
          channel: 'ch-s',
          message: {
            meta: {
              requestId: msg.message.meta?.requestId,
            },
            result: {
              scopedTarget: msg.message.meta?.fileKey,
              session: msg.message.meta?.sessionId ?? null,
            },
          },
        } satisfies ChannelMessage),
      )
    }

    // No sessionId → meta.sessionId is absent (null echoed).
    expect(
      await client.forFile('fk-s').sendCommand('ping', {}),
    ).toEqual({
      scopedTarget: 'fk-s',
      session: null,
    })
    // sessionId supplied at forFile time → it lands in meta.sessionId.
    expect(
      await client
        .forFile('fk-s', { sessionId: 's-9' })
        .sendCommand('ping', {}),
    ).toEqual({ scopedTarget: 'fk-s', session: 's-9' })

    await closeWs(plugin)
    client.disconnect()
  })

  it('sendCommand rejects for a fileKey that was never joined', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('ch-a', 'fk-a')
    let caught: Error | null = null
    try {
      await client.sendCommand('fk-b', 'ping', {})
    } catch (err) {
      caught = err as Error
    }
    expect(caught?.message).toBe('Not joined to file fk-b')
    client.disconnect()
  })

  it('disconnect clears every joined file', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('ch-a', 'fk-a')
    await client.joinChannel('ch-b', 'fk-b')
    client.disconnect()
    expect(client.joinedFiles()).toEqual([])
    expect(client.isConnected()).toBe(false)
  })
})
