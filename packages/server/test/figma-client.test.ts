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
  PluginDisconnectedError,
} from '@figma-agent-bridge/server/figma-client'
import {
  APP_VERSION,
  COMMANDS,
} from '@figma-agent-bridge/shared'
import { createMockPlugin } from './mocks/mock-plugin'

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
      'ping-req',
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
          command: 'ping-req',
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

    client.onRequest('ping-err', async () => {
      throw new Error('boom')
    })

    rawPlugin.send(
      JSON.stringify({
        type: 'message',
        channel: CHANNEL,
        message: {
          meta: { requestId: 'req-2' },
          command: 'ping-err',
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

  it('forFile stamps sessionId/agentId/agentType into command meta', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('id-ch', 'fk-id')

    // A raw peer joins the same channel to observe forwarded frames.
    const peer = await connectRaw()
    const next = createMessageQueue(peer) // set up BEFORE join so the ack is captured
    peer.send(
      JSON.stringify({ type: 'join', channel: 'id-ch' }),
    )
    await next() // consume the join system ack — peer is now a confirmed member,
    // so it will receive the broadcast (the relay only fans out to current members)

    void client
      .forFile('fk-id', {
        sessionId: 'sess-1',
        agentId: 'agent-1',
        agentType: 'general-purpose',
      })
      .sendCommand('inspect', { nodeId: '1:2' })
      .catch(() => {}) // disconnect() below rejects the still-pending command

    // Drain until the forwarded 'inspect' command arrives.
    let frame: any
    do {
      frame = await next()
    } while (frame?.message?.command !== 'inspect')

    expect(frame.message.meta.fileKey).toBe('fk-id')
    expect(frame.message.meta.sessionId).toBe('sess-1')
    expect(frame.message.meta.agentId).toBe('agent-1')
    expect(frame.message.meta.agentType).toBe(
      'general-purpose',
    )

    await closeWs(peer)
    client.disconnect()
  })

  it('notify pushes carry no meta.requestId (pushes correlate to nothing)', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('ntf-ch', 'fk-ntf')

    const peer = await connectRaw()
    const next = createMessageQueue(peer) // set up BEFORE join so the ack is captured
    peer.send(
      JSON.stringify({ type: 'join', channel: 'ntf-ch' }),
    )
    await next() // consume the join system ack so the peer receives the broadcast

    client.notify('feedback_updated', { token: 'fb-1' })

    let frame: any
    do {
      frame = await next()
    } while (frame?.message?.command !== 'feedback_updated')

    expect(frame.message.params.token).toBe('fb-1')
    expect(frame.message.meta?.requestId).toBeUndefined()

    await closeWs(peer)
    client.disconnect()
  })

  it('notifyStatus pushes an agent-status frame to only the scoped file channel', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('file-fkA', 'fkA')
    await client.joinChannel('file-fkB', 'fkB')

    const peerA = await connectRaw()
    const qa = createMessageQueue(peerA)
    peerA.send(
      JSON.stringify({ type: 'join', channel: 'file-fkA' }),
    )
    await qa() // join ack

    const peerB = await connectRaw()
    const qb = createMessageQueue(peerB)
    peerB.send(
      JSON.stringify({ type: 'join', channel: 'file-fkB' }),
    )
    await qb() // join ack
    let peerBExtra = 0
    peerB.onmessage = () => {
      peerBExtra++
    }

    const rec = {
      key: 'k',
      sessionId: 's',
      level: 'normal' as const,
      text: 'Hi',
      activity: 'busy' as const,
      updatedAt: 1,
    }
    client.forFile('fkA').notifyStatus(rec)

    // The relay's broadcast to OTHER channel members carries only `record`
    // (no `channel` — the receiving plugin is already scoped to that channel).
    const got = await qa()
    expect(got).toEqual({
      type: 'agent-status',
      record: rec,
    })

    // peerB (a different file's channel) must NOT receive it.
    await Bun.sleep(50)
    expect(peerBExtra).toBe(0)

    await closeWs(peerA)
    await closeWs(peerB)
    client.disconnect()
  })

  it('notifyMismatch opens the ws (no prior join) and pushes to the target channel', async () => {
    const client = createFigmaClient(WS_URL)

    const peer = await connectRaw()
    const qp = createMessageQueue(peer)
    peer.send(
      JSON.stringify({ type: 'join', channel: 'file-fkX' }),
    )
    await qp() // join ack

    // NO client.joinChannel — proves the lazy connect() opens the socket
    // WITHOUT joining (the cold first-touch skew path).
    client.notifyMismatch('file-fkX', '0.0.1', '0.4.0')

    const got = await qp()
    expect(got).toEqual({
      type: 'version-mismatch',
      plugin: '0.0.1',
      server: '0.4.0',
    })
    // The server socket opened but joined nothing.
    expect(client.isConnected()).toBe(false)

    await closeWs(peer)
    client.disconnect()
  })

  it('a peer on a different channel does not receive the push', async () => {
    const client = createFigmaClient(WS_URL)
    const peer = await connectRaw()
    const qp = createMessageQueue(peer)
    peer.send(
      JSON.stringify({
        type: 'join',
        channel: 'file-other',
      }),
    )
    await qp()
    let extra = 0
    peer.onmessage = () => {
      extra++
    }
    client.notifyMismatch('file-fkX', '0.0.1', '0.4.0')
    await Bun.sleep(50)
    expect(extra).toBe(0)
    await closeWs(peer)
    client.disconnect()
  })

  it('ignores an inbound agent-status broadcast (no throw) and stays usable', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('file-fkG', 'fkG')

    const peer = await connectRaw()
    const qp = createMessageQueue(peer)
    peer.send(
      JSON.stringify({ type: 'join', channel: 'file-fkG' }),
    )
    await qp() // join ack

    // Echo mock: reply to the 'inspect' command so sendCommand resolves below.
    peer.onmessage = event => {
      const msg = JSON.parse(event.data as string)
      if (
        msg.type === 'broadcast' &&
        msg.message?.command === 'inspect'
      ) {
        peer.send(
          JSON.stringify({
            type: 'message',
            channel: 'file-fkG',
            message: {
              meta: msg.message.meta,
              result: 'ok',
            },
          }),
        )
      }
    }

    // The relay broadcasts this agent-status frame to `client`'s socket too
    // (it's a channel member) — before the guard, handleMessage would fall
    // through to `message.command` on a frame with no `message` and throw.
    peer.send(
      JSON.stringify({
        type: 'agent-status',
        channel: 'file-fkG',
        record: {
          key: 'k2',
          level: 'normal',
          text: 'hi',
          activity: 'busy',
          updatedAt: 2,
        },
      }),
    )

    // Prove the client is still usable: a normal round trip still resolves.
    const result = await client
      .forFile('fkG')
      .sendCommand('inspect', { nodeId: '1:2' })
    expect(result).toBe('ok')

    await closeWs(peer)
    client.disconnect()
  })

  it('dispatch emits a busy+skeleton agent-status before an identity-bearing command', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('file-fkE', 'fkE')

    const peer = await connectRaw()
    const next = createMessageQueue(peer)
    peer.send(
      JSON.stringify({ type: 'join', channel: 'file-fkE' }),
    )
    await next() // join ack

    void client
      .forFile('fkE', {
        sessionId: 's',
        agentId: 'a',
        agentType: 'Explore',
      })
      .sendCommand('inspect', { nodeId: '1:2' }, 50)
      .catch(() => {}) // times out; we only care about the frames it emits

    // The skeleton precedes the real command on the wire.
    const first = await next()
    expect(first).toEqual({
      type: 'agent-status',
      record: {
        key: 'a',
        sessionId: 's',
        agentId: 'a',
        agentType: 'Explore',
        level: 'normal',
        text: null,
        activity: 'busy',
        updatedAt: expect.any(Number),
      },
    })

    // Drain until the real command arrives.
    let cmd: any
    do {
      cmd = await next()
    } while (cmd?.message?.command !== 'inspect')
    expect(cmd.message.meta.agentId).toBe('a')

    await closeWs(peer)
    client.disconnect()
  })

  it('dispatch does NOT emit agent-status for a command with no identity', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('file-fkF', 'fkF')

    const peer = await connectRaw()
    const next = createMessageQueue(peer)
    peer.send(
      JSON.stringify({ type: 'join', channel: 'file-fkF' }),
    )
    await next() // join ack

    void client
      .forFile('fkF') // no identity opts
      .sendCommand('inspect', { nodeId: '1:2' }, 50)
      .catch(() => {})

    // With no identity, the very next frame IS the command — no preceding
    // agent-status skeleton.
    const first: any = await next()
    expect(first.type).toBe('broadcast')
    expect(first.message?.command).toBe('inspect')

    await closeWs(peer)
    client.disconnect()
  })

  it('dispatch does NOT emit agent-status for PING even with identity present', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('file-fkH', 'fkH')

    const peer = await connectRaw()
    const next = createMessageQueue(peer)
    peer.send(
      JSON.stringify({ type: 'join', channel: 'file-fkH' }),
    )
    await next() // join ack

    void client
      .forFile('fkH', { sessionId: 's', agentId: 'a' })
      .sendCommand(COMMANDS.PING, {}, 50)
      .catch(() => {})

    const first: any = await next()
    expect(first.type).toBe('broadcast')
    expect(first.message?.command).toBe(COMMANDS.PING)

    await closeWs(peer)
    client.disconnect()
  })
})

describe('isInstanceDead', () => {
  // TEST-ONLY seam: the watchdog (L6) sets `deadInstances` directly via the
  // closure; this cast reaches the same test-only setter to seed a dead
  // entry ahead of that watchdog existing. Not part of the FigmaClient contract.
  const seedDead = (
    client: FigmaClient,
    fileKey: string,
    epoch: string,
  ): void => {
    const withSeam = client as unknown as {
      __markDeadForTest: (
        fileKey: string,
        epoch: string,
      ) => void
    }
    withSeam.__markDeadForTest(fileKey, epoch)
  }

  it('is true while the live epoch matches the declared-dead value', () => {
    const client = createFigmaClient(WS_URL)
    seedDead(client, 'fk-dead', 'e-100')

    expect(client.isInstanceDead('fk-dead', 'e-100')).toBe(
      true,
    )
  })

  it('self-clears on a fresh epoch (reconnect) and stays clear', () => {
    const client = createFigmaClient(WS_URL)
    seedDead(client, 'fk-dead', 'e-100')

    expect(client.isInstanceDead('fk-dead', 'e-200')).toBe(
      false,
    )
    // Marker was cleared by the mismatch above — still false on a second call.
    expect(client.isInstanceDead('fk-dead', 'e-200')).toBe(
      false,
    )
  })

  it('returns false for a fileKey with no declared-dead entry', () => {
    const client = createFigmaClient(WS_URL)
    expect(
      client.isInstanceDead('fk-never-dead', 'e-1'),
    ).toBe(false)
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
    // Availability is bound to the REGISTERING socket (overview.md): a bare
    // join is not discoverable.
    ws.send(
      JSON.stringify({
        type: 'register',
        channel: 'discover-ch',
        fileName: null,
        fileKey: null,
        version: APP_VERSION,
      }),
    )
    await Bun.sleep(30)

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

// L5 — mock-plugin ping + controllable timing, for the L6 watchdog tests.
describe('mock plugin: ping + timing knobs', () => {
  let server: Server<{ id: string }>

  beforeEach(() => {
    server = startRelay(TEST_PORT)
  })

  afterEach(() => {
    stopRelay(server)
  })

  it('answers ping with a pong reply', async () => {
    const client = createFigmaClient(WS_URL)
    const plugin = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'ping-ch',
      fileKey: 'fk-ping',
    })
    await plugin.start()
    await client.joinChannel('ping-ch', 'fk-ping')

    const res = await client.sendCommand(
      'fk-ping',
      COMMANDS.PING,
      {},
    )

    expect(res).toEqual({ ok: true })

    plugin.stop()
    client.disconnect()
  })

  it('delays a real command reply while ping still pongs quickly (slow-alive)', async () => {
    const client = createFigmaClient(WS_URL)
    const plugin = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'slow-ch',
      fileKey: 'fk-slow',
    })
    await plugin.start()
    await client.joinChannel('slow-ch', 'fk-slow')

    plugin.delayCommand(COMMANDS.STATUS, 300)

    const start = Date.now()
    const statusElapsed = client
      .sendCommand('fk-slow', COMMANDS.STATUS, {})
      .then(() => Date.now() - start)
    const pingElapsed = client
      .sendCommand('fk-slow', COMMANDS.PING, {})
      .then(() => Date.now() - start)

    expect(await pingElapsed).toBeLessThan(150)
    expect(await statusElapsed).toBeGreaterThanOrEqual(300)

    plugin.stop()
    client.disconnect()
  })

  it('silent mode withholds ALL replies incl. ping (dead)', async () => {
    const client = createFigmaClient(WS_URL)
    const plugin = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'dead-ch',
      fileKey: 'fk-dead',
    })
    await plugin.start()
    await client.joinChannel('dead-ch', 'fk-dead')

    plugin.setSilent(true)

    const expectTimeout = (
      p: Promise<unknown>,
    ): Promise<string> =>
      p.then(
        () => {
          throw new Error('expected a timeout, got a reply')
        },
        (err: Error) => err.message,
      )

    const [statusErr, pingErr] = await Promise.all([
      expectTimeout(
        client.sendCommand(
          'fk-dead',
          COMMANDS.STATUS,
          {},
          120,
        ),
      ),
      expectTimeout(
        client.sendCommand(
          'fk-dead',
          COMMANDS.PING,
          {},
          120,
        ),
      ),
    ])

    expect(statusErr).toContain('timed out')
    expect(pingErr).toContain('timed out')

    plugin.stop()
    client.disconnect()
  })
})

// L6 — the command-liveness watchdog (probe, not shorten, the command).
describe('command-liveness watchdog (L6)', () => {
  let server: Server<{ id: string }>

  beforeEach(() => {
    server = startRelay(TEST_PORT)
  })
  afterEach(() => {
    stopRelay(server)
  })

  // Fast tuning so the loop runs in ~hundreds of ms instead of the ~2s
  // production cadence. grace/ping = 100ms, 2 consecutive misses → dead.
  const FAST = { graceMs: 100, pingMs: 100, maxMisses: 2 }

  const epochFor = async (
    fileKey: string,
  ): Promise<string | undefined> =>
    (await discoverChannels(HTTP_URL)).find(
      c => (c.fileKey ?? c.channel) === fileKey,
    )?.epoch

  it('keeps a slow-but-alive command alive via pings (does NOT reject)', async () => {
    const client = createFigmaClient(
      WS_URL,
      undefined,
      FAST,
    )
    const plugin = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'wd-slow-ch',
      fileKey: 'fk-wd-slow',
    })
    await plugin.start()
    await client.joinChannel('wd-slow-ch', 'fk-wd-slow')

    // Reply deferred well past grace + several ping cycles, but far under the
    // real command timeout — the watchdog's pongs must keep it alive.
    plugin.delayCommand(COMMANDS.STATUS, 600)

    const res = await client.sendCommand(
      'fk-wd-slow',
      COMMANDS.STATUS,
      {},
      30_000,
    )

    // Resolves with the REAL status result, not a watchdog rejection.
    expect(res).toMatchObject({
      currentPage: { id: 'page:1' },
    })
    // The watchdog probed (armed) but never declared death.
    expect(plugin.pings()).toBeGreaterThan(0)
    const epoch = await epochFor('fk-wd-slow')
    expect(client.isInstanceDead('fk-wd-slow', epoch)).toBe(
      false,
    )
    expect(client.channelFor('fk-wd-slow')).toBe(
      'wd-slow-ch',
    )

    plugin.stop()
    client.disconnect()
  })

  it('declares a silent plugin dead: rejects DISCONNECTED, marks instance, drops joined', async () => {
    const client = createFigmaClient(
      WS_URL,
      undefined,
      FAST,
    )
    const plugin = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'wd-dead-ch',
      fileKey: 'fk-wd-dead',
    })
    await plugin.start()
    await client.joinChannel('wd-dead-ch', 'fk-wd-dead')

    // Capture the live epoch BEFORE death: the relay never reaps on a
    // watchdog death, so the entry (and its epoch) persist.
    const deadEpoch = await epochFor('fk-wd-dead')
    expect(deadEpoch).not.toBeUndefined()

    plugin.setSilent(true)

    let caught: Error | null = null
    try {
      await client.sendCommand(
        'fk-wd-dead',
        COMMANDS.STATUS,
        {},
        30_000,
      )
    } catch (err) {
      caught = err as Error
    }

    // Rejected in ~grace + 2 ping cycles with the typed error — NOT the 30s
    // command timeout.
    expect(caught).toBeInstanceOf(PluginDisconnectedError)
    // Dead-channel marker set on the declared-dead epoch.
    expect(
      client.isInstanceDead('fk-wd-dead', deadEpoch),
    ).toBe(true)
    // Dropped from joined → the channel is gone for the next call.
    expect(client.channelFor('fk-wd-dead')).toBeNull()

    plugin.stop()
    client.disconnect()
  })

  // connection-liveness.md — the reconnect race defect 2 fixes: if the
  // instance's identity CHANGES between the pre-probe sample and the
  // mark-time check, a reconnect landed mid-probe and the dying instance's
  // marker must NOT be recorded against the fresh, healthy one. We stub the
  // `/channels` HTTP lookup itself (rather than racing a real reconnect,
  // which can't be staged deterministically): it answers with the OLD epoch
  // until the first ping has gone out, then flips to a DIFFERENT ("NEW")
  // epoch — modeling a reconnect that completes somewhere during the probe
  // window, discovered only once the watchdog re-checks at mark time.
  it('reconnect race: identity change between sample and mark skips the mark (no false-dead)', async () => {
    const client = createFigmaClient(
      WS_URL,
      undefined,
      FAST,
    )
    const plugin = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'wd-race-ch',
      fileKey: 'fk-wd-race',
    })
    await plugin.start()
    await client.joinChannel('wd-race-ch', 'fk-wd-race')
    plugin.setSilent(true)

    const OLD_EPOCH = 'epoch-old'
    const NEW_EPOCH = 'epoch-new'
    let fetchCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      fetchCalls++
      const epoch =
        plugin.pings() === 0 ? OLD_EPOCH : NEW_EPOCH
      return new Response(
        JSON.stringify([
          {
            channel: 'wd-race-ch',
            fileName: null,
            fileKey: 'fk-wd-race',
            connectedAt: 0,
            epoch,
          },
        ]),
      )
    }) as typeof fetch

    try {
      let caught: Error | null = null
      try {
        await client.sendCommand(
          'fk-wd-race',
          COMMANDS.STATUS,
          {},
          30_000,
        )
      } catch (err) {
        caught = err as Error
      }

      // The command itself still fails — the watchdog correctly gives up on
      // the silent instance either way.
      expect(caught).toBeInstanceOf(PluginDisconnectedError)
      // The stub was actually exercised for both the pre-probe sample AND
      // the mark-time re-check (else this test would prove nothing).
      expect(fetchCalls).toBeGreaterThanOrEqual(2)
      // No mark recorded for the NEW epoch — the live/current identity must
      // never be declared dead just because the OLD one went silent.
      expect(
        client.isInstanceDead('fk-wd-race', NEW_EPOCH),
      ).toBe(false)
      // Nor for the OLD one — it turned over, so there is nothing live left
      // to fast-fail against; the marker is skipped entirely, not re-keyed.
      expect(
        client.isInstanceDead('fk-wd-race', OLD_EPOCH),
      ).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      plugin.stop()
      client.disconnect()
    }
  })

  it('fast path: a prompt reply never arms the watchdog (no ping sent)', async () => {
    const client = createFigmaClient(
      WS_URL,
      undefined,
      FAST,
    )
    const plugin = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'wd-fast-ch',
      fileKey: 'fk-wd-fast',
    })
    await plugin.start()
    await client.joinChannel('wd-fast-ch', 'fk-wd-fast')

    // Default synchronous mock reply — well under the 100ms grace window.
    const res = await client.sendCommand(
      'fk-wd-fast',
      COMMANDS.STATUS,
      {},
      30_000,
    )
    expect(res).toMatchObject({
      currentPage: { id: 'page:1' },
    })

    // Give any (erroneously-armed) watchdog its full grace + a ping cycle to
    // fire, then assert it never probed and left no death marker.
    await Bun.sleep(FAST.graceMs + FAST.pingMs + 100)
    expect(plugin.pings()).toBe(0)
    const epoch = await epochFor('fk-wd-fast')
    expect(client.isInstanceDead('fk-wd-fast', epoch)).toBe(
      false,
    )

    plugin.stop()
    client.disconnect()
  })

  it('settles exactly once with no unhandled rejections (slow-alive + dead)', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      // slow-alive: the real reply wins the race against the watchdog.
      const c1 = createFigmaClient(WS_URL, undefined, FAST)
      const p1 = createMockPlugin({
        relayUrl: WS_URL,
        channel: 'wd-once-ch',
        fileKey: 'fk-wd-once',
      })
      await p1.start()
      await c1.joinChannel('wd-once-ch', 'fk-wd-once')
      p1.delayCommand(COMMANDS.STATUS, 350)
      const settled1 = await c1
        .sendCommand(
          'fk-wd-once',
          COMMANDS.STATUS,
          {},
          30_000,
        )
        .then(
          () => 'resolved',
          () => 'rejected',
        )
      expect(settled1).toBe('resolved')
      p1.stop()
      c1.disconnect()

      // dead: the watchdog wins and rejects exactly once.
      const c2 = createFigmaClient(WS_URL, undefined, FAST)
      const p2 = createMockPlugin({
        relayUrl: WS_URL,
        channel: 'wd-once-dead-ch',
        fileKey: 'fk-wd-once-dead',
      })
      await p2.start()
      await c2.joinChannel(
        'wd-once-dead-ch',
        'fk-wd-once-dead',
      )
      p2.setSilent(true)
      const settled2 = await c2
        .sendCommand(
          'fk-wd-once-dead',
          COMMANDS.STATUS,
          {},
          30_000,
        )
        .then(
          () => 'resolved',
          () => 'rejected',
        )
      expect(settled2).toBe('rejected')
      p2.stop()
      c2.disconnect()

      // Let any late/duplicate settlement or stray ping rejection surface.
      await Bun.sleep(FAST.pingMs * 3)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
