import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import type { Server } from 'bun'
import net from 'node:net'
import type {
  BroadcastMessage,
  ChannelInfo,
  SystemMessage,
} from '@figma-agent-bridge/shared/types'
import { APP_VERSION } from '@figma-agent-bridge/shared'
import {
  DEFAULT_HEARTBEAT_INTERVAL,
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'

const TEST_PORT = 3099
// HB_PORT must not collide with TEST_PORT (3099); used only by the eviction test
const HB_PORT = 3110
const WS_URL = `ws://localhost:${TEST_PORT}`
const HTTP_URL = `http://localhost:${TEST_PORT}`

const connect = (): Promise<WebSocket> => {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    ws.onopen = () => {
      resolve(ws)
    }
    ws.onerror = () => {
      reject(new Error('WebSocket connection failed'))
    }
  })
}

const createMessageQueue = (ws: WebSocket) => {
  const queue: unknown[] = []
  let waiter: ((value: unknown) => void) | null = null

  ws.onmessage = event => {
    const parsed = JSON.parse(event.data as string)
    if (waiter) {
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

const closeWs = (ws: WebSocket): Promise<void> => {
  return new Promise(resolve => {
    ws.onclose = () => {
      resolve()
    }
    ws.close()
  })
}

describe('relay heartbeat default', () => {
  it('default heartbeat interval is 10s (fast idle-death detection)', () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL).toBe(10_000)
  })
})

describe('relay', () => {
  let server: Server<{ id: string }>

  beforeEach(() => {
    server = startRelay(TEST_PORT)
  })

  afterEach(() => {
    stopRelay(server)
  })

  it('accepts WebSocket connections', async () => {
    const ws = await connect()
    expect(ws.readyState).toBe(WebSocket.OPEN)
    await closeWs(ws)
  })

  it('joins a channel and receives system confirmation', async () => {
    const ws = await connect()
    const nextMessage = createMessageQueue(ws)

    ws.send(
      JSON.stringify({
        type: 'join',
        channel: 'test-channel',
      }),
    )

    const msg = (await nextMessage()) as SystemMessage
    expect(msg.type).toBe('system')
    expect(msg.message.result).toBe(
      'Connected to channel: test-channel',
    )
    expect(typeof msg.message.id).toBe('string')

    await closeWs(ws)
  })

  it('broadcasts messages to all clients in channel', async () => {
    const ws1 = await connect()
    const ws2 = await connect()
    const nextMessage1 = createMessageQueue(ws1)
    const nextMessage2 = createMessageQueue(ws2)

    ws1.send(
      JSON.stringify({
        type: 'join',
        channel: 'broadcast-channel',
      }),
    )
    await nextMessage1()

    ws2.send(
      JSON.stringify({
        type: 'join',
        channel: 'broadcast-channel',
      }),
    )
    await nextMessage2()

    ws1.send(
      JSON.stringify({
        type: 'message',
        channel: 'broadcast-channel',
        message: {
          meta: { requestId: 'cmd-1' },
          command: 'ping',
        },
      }),
    )

    const broadcast =
      (await nextMessage2()) as BroadcastMessage
    expect(broadcast.type).toBe('broadcast')
    expect(broadcast.message.meta?.requestId).toBe('cmd-1')
    expect(broadcast.message.command).toBe('ping')

    await closeWs(ws1)
    await closeWs(ws2)
  })

  it('two relays on different ports keep independent state', async () => {
    const SECOND_PORT = 3100
    const second = startRelay(SECOND_PORT)

    // join on the first server's port only
    const ws = await connect()
    const nextMessage = createMessageQueue(ws)
    ws.send(
      JSON.stringify({ type: 'join', channel: 'iso-ch' }),
    )
    await nextMessage()

    const firstChannels = (await (
      await fetch(`${HTTP_URL}/channels`)
    ).json()) as ChannelInfo[]
    const secondChannels = (await (
      await fetch(
        `http://localhost:${SECOND_PORT}/channels`,
      )
    ).json()) as ChannelInfo[]

    expect(firstChannels.map(c => c.channel)).toEqual([
      'iso-ch',
    ])
    expect(secondChannels).toEqual([])

    await closeWs(ws)
    stopRelay(second)
  })

  describe('channel registry', () => {
    it('GET /channels returns empty array when no channels', async () => {
      const res = await fetch(`${HTTP_URL}/channels`)
      const data = await res.json()
      expect(data).toEqual([])
    })

    it('GET /channels returns channel after join', async () => {
      const ws = await connect()
      const nextMessage = createMessageQueue(ws)

      ws.send(
        JSON.stringify({
          type: 'join',
          channel: 'registry-ch',
        }),
      )
      await nextMessage()

      const res = await fetch(`${HTTP_URL}/channels`)
      const data = (await res.json()) as ChannelInfo[]
      expect(data).toHaveLength(1)
      expect(data[0].channel).toBe('registry-ch')
      expect(data[0].fileName).toBeNull()
      expect(typeof data[0].connectedAt).toBe('number')

      await closeWs(ws)
    })

    it('register updates fileName on channel', async () => {
      const ws = await connect()
      const nextMessage = createMessageQueue(ws)

      ws.send(
        JSON.stringify({
          type: 'join',
          channel: 'register-ch',
        }),
      )
      await nextMessage()

      ws.send(
        JSON.stringify({
          type: 'register',
          channel: 'register-ch',
          fileName: 'My Design.fig',
        }),
      )

      // Give relay a moment to process
      await Bun.sleep(50)

      const res = await fetch(`${HTTP_URL}/channels`)
      const data = (await res.json()) as ChannelInfo[]
      expect(data).toHaveLength(1)
      expect(data[0].channel).toBe('register-ch')
      expect(data[0].fileName).toBe('My Design.fig')

      await closeWs(ws)
    })

    it('register with fileKey is reflected in /channels', async () => {
      const ws = await connect()
      const nextMessage = createMessageQueue(ws)

      ws.send(
        JSON.stringify({
          type: 'join',
          channel: 'filekey-ch',
        }),
      )
      await nextMessage()

      // default entry (before register) must carry fileKey:null, not undefined
      const before = (await (
        await fetch(`${HTTP_URL}/channels`)
      ).json()) as ChannelInfo[]
      expect(
        before.find(c => c.channel === 'filekey-ch')
          ?.fileKey,
      ).toBeNull()

      ws.send(
        JSON.stringify({
          type: 'register',
          channel: 'filekey-ch',
          fileName: 'My Design.fig',
          fileKey: 'ABC123fileKey',
        }),
      )
      // Give relay a moment to process
      await Bun.sleep(50)

      const after = (await (
        await fetch(`${HTTP_URL}/channels`)
      ).json()) as ChannelInfo[]
      const entry = after.find(
        c => c.channel === 'filekey-ch',
      )
      expect(entry?.fileName).toBe('My Design.fig')
      expect(entry?.fileKey).toBe('ABC123fileKey')

      await closeWs(ws)
    })

    it('channel removed from registry on disconnect', async () => {
      const ws = await connect()
      const nextMessage = createMessageQueue(ws)

      ws.send(
        JSON.stringify({
          type: 'join',
          channel: 'remove-ch',
        }),
      )
      await nextMessage()

      await closeWs(ws)

      // Give relay a moment to process close
      await Bun.sleep(50)

      const res = await fetch(`${HTTP_URL}/channels`)
      const data = await res.json()
      expect(data).toEqual([])
    })

    it('a registered channel (with fileKey) is reaped from /channels on disconnect', async () => {
      const ws = await connect()
      const nextMessage = createMessageQueue(ws)

      ws.send(
        JSON.stringify({
          type: 'join',
          channel: 'avail-ch',
        }),
      )
      await nextMessage()

      ws.send(
        JSON.stringify({
          type: 'register',
          channel: 'avail-ch',
          fileName: 'Avail.fig',
          fileKey: 'AVAILfileKey',
        }),
      )
      await Bun.sleep(50)

      // present with its fileKey while the last member is connected
      const present = (await (
        await fetch(`${HTTP_URL}/channels`)
      ).json()) as ChannelInfo[]
      expect(
        present.find(c => c.channel === 'avail-ch')
          ?.fileKey,
      ).toBe('AVAILfileKey')

      // last member leaves -> close -> removeClient deletes the registry entry
      await closeWs(ws)
      await Bun.sleep(50)

      const gone = (await (
        await fetch(`${HTTP_URL}/channels`)
      ).json()) as ChannelInfo[]
      expect(gone.some(c => c.channel === 'avail-ch')).toBe(
        false,
      )
    })

    it('multiple channels listed independently', async () => {
      const ws1 = await connect()
      const ws2 = await connect()
      const next1 = createMessageQueue(ws1)
      const next2 = createMessageQueue(ws2)

      ws1.send(
        JSON.stringify({
          type: 'join',
          channel: 'multi-ch-1',
        }),
      )
      await next1()

      ws2.send(
        JSON.stringify({
          type: 'join',
          channel: 'multi-ch-2',
        }),
      )
      await next2()

      const res = await fetch(`${HTTP_URL}/channels`)
      const data = (await res.json()) as ChannelInfo[]
      expect(data).toHaveLength(2)

      const channels = data.map(c => c.channel).sort()
      expect(channels).toEqual(['multi-ch-1', 'multi-ch-2'])

      await closeWs(ws1)
      await closeWs(ws2)
    })

    it('register carries currentPage/selected onto the registry', async () => {
      const ws = await connect()
      const nextMessage = createMessageQueue(ws)

      ws.send(
        JSON.stringify({ type: 'join', channel: 'file-p' }),
      )
      await nextMessage()

      ws.send(
        JSON.stringify({
          type: 'register',
          channel: 'file-p',
          fileName: 'P',
          fileKey: 'p',
          version: '0.2.0',
          currentPage: 'Icons',
          selected: 2,
        }),
      )
      await Bun.sleep(50)

      const data = (await (
        await fetch(`${HTTP_URL}/channels`)
      ).json()) as ChannelInfo[]
      const info = data.find(c => c.channel === 'file-p')
      expect(info?.currentPage).toBe('Icons')
      expect(info?.selected).toBe(2)

      await closeWs(ws)
    })

    it('presence frame updates currentPage/selected in place', async () => {
      const ws = await connect()
      const nextMessage = createMessageQueue(ws)

      ws.send(
        JSON.stringify({ type: 'join', channel: 'file-q' }),
      )
      await nextMessage()

      ws.send(
        JSON.stringify({
          type: 'register',
          channel: 'file-q',
          fileName: 'Q',
          fileKey: 'q',
          currentPage: 'Page 1',
          selected: 0,
        }),
      )
      await Bun.sleep(30)

      ws.send(
        JSON.stringify({
          type: 'presence',
          channel: 'file-q',
          currentPage: 'Icons',
          selected: 5,
        }),
      )
      await Bun.sleep(30)

      const data = (await (
        await fetch(`${HTTP_URL}/channels`)
      ).json()) as ChannelInfo[]
      const info = data.find(c => c.channel === 'file-q')
      expect(info?.currentPage).toBe('Icons')
      expect(info?.selected).toBe(5)

      await closeWs(ws)
    })

    it('ignores presence for a channel the client never joined', async () => {
      const ws = await connect()

      ws.send(
        JSON.stringify({
          type: 'presence',
          channel: 'file-unjoined',
          currentPage: 'X',
          selected: 1,
        }),
      )
      await Bun.sleep(30)

      const data = (await (
        await fetch(`${HTTP_URL}/channels`)
      ).json()) as ChannelInfo[]
      const info = data.find(
        c => c.channel === 'file-unjoined',
      )
      expect(info).toBeUndefined()

      await closeWs(ws)
    })

    it('leave frame reaps the channel from the registry', async () => {
      const ws = await connect()
      const nextMessage = createMessageQueue(ws)

      ws.send(
        JSON.stringify({ type: 'join', channel: 'file-l' }),
      )
      await nextMessage()

      ws.send(
        JSON.stringify({
          type: 'register',
          channel: 'file-l',
          fileName: 'L',
          fileKey: 'l',
        }),
      )
      await Bun.sleep(30)

      const present = (await (
        await fetch(`${HTTP_URL}/channels`)
      ).json()) as ChannelInfo[]
      expect(
        present.some(c => c.channel === 'file-l'),
      ).toBe(true)

      ws.send(
        JSON.stringify({
          type: 'leave',
          channel: 'file-l',
        }),
      )
      await Bun.sleep(30)

      const gone = (await (
        await fetch(`${HTTP_URL}/channels`)
      ).json()) as ChannelInfo[]
      expect(gone.some(c => c.channel === 'file-l')).toBe(
        false,
      )

      await closeWs(ws)
    })

    it('leave for one channel does not drop another', async () => {
      const ws = await connect()
      const nextMessage = createMessageQueue(ws)

      ws.send(
        JSON.stringify({
          type: 'join',
          channel: 'file-a1',
        }),
      )
      await nextMessage()
      ws.send(
        JSON.stringify({
          type: 'join',
          channel: 'file-a2',
        }),
      )
      await nextMessage()

      ws.send(
        JSON.stringify({
          type: 'register',
          channel: 'file-a1',
          fileName: 'A1',
          fileKey: 'a1',
        }),
      )
      ws.send(
        JSON.stringify({
          type: 'register',
          channel: 'file-a2',
          fileName: 'A2',
          fileKey: 'a2',
        }),
      )
      await Bun.sleep(30)

      ws.send(
        JSON.stringify({
          type: 'leave',
          channel: 'file-a1',
        }),
      )
      await Bun.sleep(30)

      const data = (await (
        await fetch(`${HTTP_URL}/channels`)
      ).json()) as ChannelInfo[]
      expect(data.some(c => c.channel === 'file-a1')).toBe(
        false,
      )
      const a2 = data.find(c => c.channel === 'file-a2')
      expect(a2?.fileKey).toBe('a2')

      await closeWs(ws)
    })
  })

  it('ignores register for a channel the client never joined', async () => {
    const owner = await connect()
    const ownerNext = createMessageQueue(owner)
    owner.send(
      JSON.stringify({ type: 'join', channel: 'guard-ch' }),
    )
    await ownerNext()

    // attacker joins a DIFFERENT channel, then tries to register guard-ch
    const attacker = await connect()
    const attackerNext = createMessageQueue(attacker)
    attacker.send(
      JSON.stringify({ type: 'join', channel: 'other-ch' }),
    )
    await attackerNext()
    attacker.send(
      JSON.stringify({
        type: 'register',
        channel: 'guard-ch',
        fileName: 'HIJACK.fig',
      }),
    )
    await Bun.sleep(50)

    const data = (await (
      await fetch(`${HTTP_URL}/channels`)
    ).json()) as ChannelInfo[]
    const guard = data.find(c => c.channel === 'guard-ch')
    expect(guard?.fileName).toBeNull()

    await closeWs(owner)
    await closeWs(attacker)
  })

  it('excludes the sending socket from its own broadcast', async () => {
    const ws1 = await connect()
    const ws2 = await connect()
    const next1 = createMessageQueue(ws1)
    const next2 = createMessageQueue(ws2)

    ws1.send(
      JSON.stringify({ type: 'join', channel: 'echo-ch' }),
    )
    await next1()
    ws2.send(
      JSON.stringify({ type: 'join', channel: 'echo-ch' }),
    )
    await next2()

    ws1.send(
      JSON.stringify({
        type: 'message',
        channel: 'echo-ch',
        message: {
          meta: { requestId: 'cmd-x' },
          command: 'noop',
        },
      }),
    )

    // ws2 receives the broadcast
    const broadcast = (await next2()) as BroadcastMessage
    expect(broadcast.type).toBe('broadcast')
    expect(broadcast.message.meta?.requestId).toBe('cmd-x')

    // ws1 must NOT receive its own broadcast: send a marker join and assert
    // the next frame ws1 sees is the system reply, not the broadcast
    ws1.send(
      JSON.stringify({ type: 'join', channel: 'echo-ch' }),
    )
    const afterSelf = (await next1()) as SystemMessage
    expect(afterSelf.type).toBe('system')

    await closeWs(ws1)
    await closeWs(ws2)
  })

  it('rejects joins beyond the per-connection channel cap', async () => {
    const ws = await connect()
    const nextMessage = createMessageQueue(ws)

    // 32 accepted joins
    for (let i = 0; i < 32; i++) {
      ws.send(
        JSON.stringify({
          type: 'join',
          channel: `cap-${i}`,
        }),
      )
      const ok = (await nextMessage()) as SystemMessage
      expect(ok.message.result).toBe(
        `Connected to channel: cap-${i}`,
      )
    }

    // 33rd is rejected
    ws.send(
      JSON.stringify({ type: 'join', channel: 'cap-over' }),
    )
    const rejected = (await nextMessage()) as SystemMessage
    expect(rejected.type).toBe('system')
    expect(rejected.message.result).toBe(
      'Error: channel limit reached for this connection',
    )

    // rejected channel never entered the registry
    const data = (await (
      await fetch(`${HTTP_URL}/channels`)
    ).json()) as ChannelInfo[]
    expect(data.some(c => c.channel === 'cap-over')).toBe(
      false,
    )

    await closeWs(ws)
  })

  it('token-bucket rate limiter silently drops frames when bucket is empty', async () => {
    // The bucket refills off the wall clock, so the first version of this test
    // raced it: draining the production bucket (100 tokens @ 50/s) took ~100
    // round-trips, and 20ms of scheduler jitter anywhere in that loop refilled
    // a token — the probe frame was then answered instead of dropped
    // (`Expected: 0  Received: 1`, reproduced ~1 run in 50).
    // Fix: a dedicated relay with an injected, frozen clock. Bucket time moves
    // only when this test moves it, so a drained bucket stays drained however
    // slow the run is, and no assertion depends on real elapsed time.
    const RATE_PORT = 3150
    const RATE_BURST = 5
    const DRAIN_CH = 'rate-ch'
    const RECOVER_CH = 'rate-ch-recovered'
    let fakeNow = 1_000_000
    const rateServer = startRelay(RATE_PORT, {
      rateBurst: RATE_BURST,
      rateTokensPerSec: 5,
      rateNow: () => fakeNow,
    })

    const connectRate = (): Promise<WebSocket> =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(
          `ws://localhost:${RATE_PORT}`,
        )
        socket.onopen = () => resolve(socket)
        socket.onerror = () =>
          reject(new Error('WebSocket connection failed'))
      })

    const joinFrame = (channel: string) =>
      JSON.stringify({ type: 'join', channel })

    try {
      const ws = await connectRate() // the socket being drained
      const observer = await connectRate() // its own, untouched bucket
      const nextMessage = createMessageQueue(ws)
      const nextObserved = createMessageQueue(observer)

      observer.send(joinFrame(DRAIN_CH))
      await nextObserved()

      // Drain the bucket: every idempotent re-join costs 1 token, and the
      // frozen clock refills none of them back.
      for (let i = 0; i < RATE_BURST; i++) {
        ws.send(joinFrame(DRAIN_CH))
        await nextMessage()
      }

      // Collect everything the relay sends to `ws` from here on.
      const received: SystemMessage[] = []
      const recoveredAck = new Promise<void>(resolve => {
        ws.onmessage = event => {
          const msg = JSON.parse(
            event.data as string,
          ) as SystemMessage
          received.push(msg)
          if (
            msg.message.result ===
            `Connected to channel: ${RECOVER_CH}`
          ) {
            resolve()
          }
        }
      })

      // Bucket is empty — this frame must be silently dropped (no reply).
      ws.send(joinFrame(DRAIN_CH))

      // Barrier: agent-status frames are exempt from the bucket, so this one
      // IS handled and is broadcast to `observer`. One socket's frames are
      // handled in order, so `observer` seeing it proves the relay has already
      // reached (and dropped) the probe above. That is what makes advancing
      // the clock safe: `ws.send` only queues a frame, so bumping the clock on
      // the test's own timeline could land before the relay ever read the
      // probe — and would hand it the token it must not have.
      const record = {
        key: 'rate-barrier',
        sessionId: 'rate',
        level: 'normal',
        text: 'barrier',
        activity: 'busy',
        updatedAt: 1,
      }
      ws.send(
        JSON.stringify({
          type: 'agent-status',
          channel: DRAIN_CH,
          record,
        }),
      )
      expect(await nextObserved()).toEqual({
        type: 'agent-status',
        record,
      })

      // Connection is still alive — after a refill it is answered again.
      fakeNow += 1_000 // 5 tokens refilled at 5/s
      ws.send(joinFrame(RECOVER_CH))

      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'recovery frame was never answered',
              ),
            ),
          2_000,
        )
      })
      try {
        await Promise.race([recoveredAck, timeout])
      } finally {
        clearTimeout(timer)
      }

      // Exactly one reply: the recovery ack. The probe got none — replies on
      // one socket arrive in order, so a probe ack would already be here.
      expect(received).toHaveLength(1)
      expect(received[0]?.type).toBe('system')
      expect(received[0]?.message.result).toBe(
        `Connected to channel: ${RECOVER_CH}`,
      )

      await closeWs(ws)
      await closeWs(observer)
    } finally {
      stopRelay(rateServer)
    }
  })

  it('evicts a client that misses a heartbeat', async () => {
    const hbServer = startRelay(HB_PORT, {
      heartbeatInterval: 30,
    })

    try {
      // Bun's WebSocket auto-pongs native pings, so use a raw TCP socket that
      // performs the WS handshake but never responds to ping frames.
      // The relay flips alive=false on tick 1, sends a ping, and if no pong
      // arrives before tick 2, closes the socket (collect-then-close path).
      const wsHandshake = [
        'GET / HTTP/1.1',
        `Host: localhost:${HB_PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n')

      const closed = new Promise<void>(
        (resolve, reject) => {
          const socket = net.createConnection(
            { port: HB_PORT, host: '127.0.0.1' },
            () => socket.write(wsHandshake),
          )
          socket.on('close', () => resolve())
          socket.on('error', e => reject(e))
        },
      )

      const result = await Promise.race([
        closed.then(() => 'closed' as const),
        Bun.sleep(500).then(() => 'timeout' as const),
      ])

      expect(result).toBe('closed')
    } finally {
      stopRelay(hbServer)
    }
  })

  it('double-join is idempotent and re-confirms', async () => {
    const ws = await connect()
    const nextMessage = createMessageQueue(ws)

    ws.send(
      JSON.stringify({ type: 'join', channel: 'idem-ch' }),
    )
    const first = (await nextMessage()) as SystemMessage
    expect(first.message.result).toBe(
      'Connected to channel: idem-ch',
    )

    ws.send(
      JSON.stringify({ type: 'join', channel: 'idem-ch' }),
    )
    const second = (await nextMessage()) as SystemMessage
    expect(second.message.result).toBe(
      'Connected to channel: idem-ch',
    )

    // still exactly one registry entry
    const data = (await (
      await fetch(`${HTTP_URL}/channels`)
    ).json()) as ChannelInfo[]
    expect(
      data.filter(c => c.channel === 'idem-ch'),
    ).toHaveLength(1)

    await closeWs(ws)
  })

  it('rejects the 65th member joining a full channel', async () => {
    const CAP_PORT = 3120
    const CAP_CHANNEL = 'full-channel'
    const capServer = startRelay(CAP_PORT, {
      heartbeatInterval: 600_000,
    })
    const sockets: WebSocket[] = []

    try {
      // Open MAX_MEMBERS_PER_CHANNEL (64) sockets and join the same channel
      for (let i = 0; i < 64; i++) {
        const ws = await new Promise<WebSocket>(
          (resolve, reject) => {
            const s = new WebSocket(
              `ws://localhost:${CAP_PORT}`,
            )
            s.onopen = () => resolve(s)
            s.onerror = () =>
              reject(
                new Error('WebSocket connection failed'),
              )
          },
        )
        sockets.push(ws)
        const next = createMessageQueue(ws)
        ws.send(
          JSON.stringify({
            type: 'join',
            channel: CAP_CHANNEL,
          }),
        )
        const ok = (await next()) as SystemMessage
        expect(ok.message.result).toBe(
          `Connected to channel: ${CAP_CHANNEL}`,
        )
      }

      // 65th socket — should be rejected with member-cap error
      const ws65 = await new Promise<WebSocket>(
        (resolve, reject) => {
          const s = new WebSocket(
            `ws://localhost:${CAP_PORT}`,
          )
          s.onopen = () => resolve(s)
          s.onerror = () =>
            reject(new Error('WebSocket connection failed'))
        },
      )
      sockets.push(ws65)
      const next65 = createMessageQueue(ws65)
      ws65.send(
        JSON.stringify({
          type: 'join',
          channel: CAP_CHANNEL,
        }),
      )
      const rejected = (await next65()) as SystemMessage
      expect(rejected.type).toBe('system')
      expect(rejected.message.result).toBe(
        'Error: member limit reached for this channel',
      )
    } finally {
      await Promise.all(
        sockets.map(
          ws =>
            new Promise<void>(resolve => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.onclose = () => resolve()
                ws.close()
              } else {
                resolve()
              }
            }),
        ),
      )
      stopRelay(capServer)
    }
  })

  it('returns 426 for non-websocket, non-/channels requests', async () => {
    const res = await fetch(`${HTTP_URL}/anything-else`)
    expect(res.status).toBe(426)
    expect(await res.text()).toBe('WebSocket only')
  })

  it('drops malformed frames without affecting the connection', async () => {
    const ws = await connect()
    const nextMessage = createMessageQueue(ws)

    // unknown discriminator -> dropped, no reply
    ws.send(JSON.stringify({ type: 'bogus', channel: 'x' }))
    // join with empty channel -> fails schema (.min(1)) -> dropped
    ws.send(JSON.stringify({ type: 'join', channel: '' }))
    // non-JSON -> dropped
    ws.send('not json at all')

    // a valid join still works on the same socket
    ws.send(
      JSON.stringify({ type: 'join', channel: 'ok-ch' }),
    )
    const msg = (await nextMessage()) as SystemMessage
    expect(msg.type).toBe('system')
    expect(msg.message.result).toBe(
      'Connected to channel: ok-ch',
    )

    // registry has only the valid channel
    const data = (await (
      await fetch(`${HTTP_URL}/channels`)
    ).json()) as ChannelInfo[]
    expect(data.map(c => c.channel)).toEqual(['ok-ch'])

    await closeWs(ws)
  })

  describe('agent-status store', () => {
    it('stores an agent-status frame and broadcasts it to other channel members', async () => {
      const server2 = await connect() // the "MCP server" socket
      const plugin = await connect() // the "plugin" socket
      const sQ = createMessageQueue(server2)
      const pQ = createMessageQueue(plugin)
      server2.send(
        JSON.stringify({ type: 'join', channel: 'c1' }),
      )
      await sQ()
      plugin.send(
        JSON.stringify({ type: 'join', channel: 'c1' }),
      )
      await pQ()
      const record = {
        key: 'a1',
        sessionId: 's1',
        level: 'normal',
        text: 'Building',
        activity: 'busy',
        updatedAt: 1,
      }
      server2.send(
        JSON.stringify({
          type: 'agent-status',
          channel: 'c1',
          record,
        }),
      )
      const got = await pQ()
      expect(got).toEqual({ type: 'agent-status', record })
      await closeWs(server2)
      await closeWs(plugin)
    })

    it('replays current records on status-sync', async () => {
      const server2 = await connect()
      const sQ = createMessageQueue(server2)
      server2.send(
        JSON.stringify({ type: 'join', channel: 'c2' }),
      )
      await sQ()
      const record = {
        key: 'a2',
        sessionId: 's2',
        level: 'normal',
        text: 'X',
        activity: 'busy',
        updatedAt: 2,
      }
      server2.send(
        JSON.stringify({
          type: 'agent-status',
          channel: 'c2',
          record,
        }),
      )
      const plugin = await connect()
      const pQ = createMessageQueue(plugin)
      plugin.send(
        JSON.stringify({ type: 'join', channel: 'c2' }),
      )
      await pQ()
      plugin.send(
        JSON.stringify({
          type: 'status-sync',
          channel: 'c2',
        }),
      )
      const sync = await pQ()
      expect(sync).toEqual({
        type: 'agent-status-sync',
        records: [record],
      })
      await closeWs(server2)
      await closeWs(plugin)
    })

    it('merges by key (a later skeleton keeps an earlier label AND does not wipe the narrative)', async () => {
      const server2 = await connect()
      const sQ = createMessageQueue(server2)
      server2.send(
        JSON.stringify({ type: 'join', channel: 'c3' }),
      )
      await sQ()
      server2.send(
        JSON.stringify({
          type: 'agent-status',
          channel: 'c3',
          record: {
            key: 'a3',
            sessionId: 's3',
            label: 'Nav',
            level: 'normal',
            text: 'Building',
            activity: 'busy',
            updatedAt: 1,
          },
        }),
      )
      server2.send(
        JSON.stringify({
          type: 'agent-status',
          channel: 'c3',
          record: {
            key: 'a3',
            sessionId: 's3',
            level: 'normal',
            text: null,
            activity: 'busy',
            updatedAt: 2,
          },
        }),
      )
      const plugin = await connect()
      const pQ = createMessageQueue(plugin)
      plugin.send(
        JSON.stringify({ type: 'join', channel: 'c3' }),
      )
      await pQ()
      plugin.send(
        JSON.stringify({
          type: 'status-sync',
          channel: 'c3',
        }),
      )
      const sync = (await pQ()) as {
        records: Record<string, unknown>[]
      }
      // a skeleton frame (text:null) must not wipe the earlier narrative —
      // the row stays "Building" (busy dot carries the busy signal instead)
      expect(sync.records[0]).toMatchObject({
        key: 'a3',
        label: 'Nav',
        text: 'Building',
        updatedAt: 2,
      })
      await closeWs(server2)
      await closeWs(plugin)
    })

    it('a skeleton after a narrative preserves the text (does not wipe it)', async () => {
      const server2 = await connect()
      const plugin = await connect()
      const sQ = createMessageQueue(server2)
      const pQ = createMessageQueue(plugin)
      server2.send(
        JSON.stringify({ type: 'join', channel: 'c3b' }),
      )
      await sQ()
      plugin.send(
        JSON.stringify({ type: 'join', channel: 'c3b' }),
      )
      await pQ()

      server2.send(
        JSON.stringify({
          type: 'agent-status',
          channel: 'c3b',
          record: {
            key: 'a3b',
            sessionId: 's3b',
            level: 'normal',
            text: 'Building the header',
            activity: 'busy',
            updatedAt: 1,
          },
        }),
      )
      await pQ() // broadcast of the narrative

      server2.send(
        JSON.stringify({
          type: 'agent-status',
          channel: 'c3b',
          record: {
            key: 'a3b',
            sessionId: 's3b',
            level: 'normal',
            text: null,
            activity: 'busy',
            updatedAt: 2,
          },
        }),
      )
      const got = await pQ()
      expect(got).toMatchObject({
        type: 'agent-status',
        record: {
          key: 'a3b',
          text: 'Building the header',
        },
      })

      await closeWs(server2)
      await closeWs(plugin)
    })

    it('a skeleton with no prior narrative stays null (start state)', async () => {
      const server2 = await connect()
      const plugin = await connect()
      const sQ = createMessageQueue(server2)
      const pQ = createMessageQueue(plugin)
      server2.send(
        JSON.stringify({ type: 'join', channel: 'c3c' }),
      )
      await sQ()
      plugin.send(
        JSON.stringify({ type: 'join', channel: 'c3c' }),
      )
      await pQ()

      server2.send(
        JSON.stringify({
          type: 'agent-status',
          channel: 'c3c',
          record: {
            key: 'a3c',
            sessionId: 's3c',
            level: 'normal',
            text: null,
            activity: 'busy',
            updatedAt: 1,
          },
        }),
      )
      const got = await pQ()
      expect(got).toMatchObject({
        type: 'agent-status',
        record: { key: 'a3c', text: null },
      })

      await closeWs(server2)
      await closeWs(plugin)
    })

    it("POST /agent-status/settle flips a session's rows to idle and broadcasts", async () => {
      const server2 = await connect()
      const sQ = createMessageQueue(server2)
      server2.send(
        JSON.stringify({ type: 'join', channel: 'c4' }),
      )
      await sQ()
      server2.send(
        JSON.stringify({
          type: 'agent-status',
          channel: 'c4',
          record: {
            key: 'a4',
            sessionId: 's4',
            level: 'normal',
            text: 'X',
            activity: 'busy',
            updatedAt: 1,
          },
        }),
      )
      const plugin = await connect()
      const pQ = createMessageQueue(plugin)
      plugin.send(
        JSON.stringify({ type: 'join', channel: 'c4' }),
      )
      await pQ()
      const res = await fetch(
        `${HTTP_URL}/agent-status/settle`,
        {
          method: 'POST',
          body: JSON.stringify({ sessionId: 's4' }),
        },
      )
      expect(res.status).toBe(200)
      const got = await pQ()
      expect(got).toMatchObject({
        type: 'agent-status',
        record: { key: 'a4', activity: 'idle' },
      })
      await closeWs(server2)
      await closeWs(plugin)
    })

    it('settle defaults a never-narrated row to "Done" (never a skeleton on green)', async () => {
      const server2 = await connect()
      const sQ = createMessageQueue(server2)
      server2.send(
        JSON.stringify({ type: 'join', channel: 'c4b' }),
      )
      await sQ()
      server2.send(
        JSON.stringify({
          type: 'agent-status',
          channel: 'c4b',
          record: {
            key: 'a4b',
            sessionId: 's4b',
            level: 'normal',
            text: null,
            activity: 'busy',
            updatedAt: 1,
          },
        }),
      )
      const plugin = await connect()
      const pQ = createMessageQueue(plugin)
      plugin.send(
        JSON.stringify({ type: 'join', channel: 'c4b' }),
      )
      await pQ()
      const res = await fetch(
        `${HTTP_URL}/agent-status/settle`,
        {
          method: 'POST',
          body: JSON.stringify({ sessionId: 's4b' }),
        },
      )
      expect(res.status).toBe(200)
      const got = await pQ()
      expect(got).toMatchObject({
        type: 'agent-status',
        record: {
          key: 'a4b',
          activity: 'idle',
          text: 'Done',
        },
      })
      await closeWs(server2)
      await closeWs(plugin)
    })

    it('settle keeps an existing narrative (does not overwrite with "Done")', async () => {
      const server2 = await connect()
      const sQ = createMessageQueue(server2)
      server2.send(
        JSON.stringify({ type: 'join', channel: 'c4c' }),
      )
      await sQ()
      server2.send(
        JSON.stringify({
          type: 'agent-status',
          channel: 'c4c',
          record: {
            key: 'a4c',
            sessionId: 's4c',
            level: 'normal',
            text: 'Wiring cards',
            activity: 'busy',
            updatedAt: 1,
          },
        }),
      )
      const plugin = await connect()
      const pQ = createMessageQueue(plugin)
      plugin.send(
        JSON.stringify({ type: 'join', channel: 'c4c' }),
      )
      await pQ()
      const res = await fetch(
        `${HTTP_URL}/agent-status/settle`,
        {
          method: 'POST',
          body: JSON.stringify({ sessionId: 's4c' }),
        },
      )
      expect(res.status).toBe(200)
      const got = await pQ()
      expect(got).toMatchObject({
        type: 'agent-status',
        record: {
          key: 'a4c',
          activity: 'idle',
          text: 'Wiring cards',
        },
      })
      await closeWs(server2)
      await closeWs(plugin)
    })

    it('POST /agent-status/remove drops matching rows and broadcasts a remove', async () => {
      const server2 = await connect()
      const sQ = createMessageQueue(server2)
      server2.send(
        JSON.stringify({ type: 'join', channel: 'c5' }),
      )
      await sQ()
      server2.send(
        JSON.stringify({
          type: 'agent-status',
          channel: 'c5',
          record: {
            key: 'ag5',
            sessionId: 's5',
            agentId: 'ag5',
            level: 'normal',
            text: 'X',
            activity: 'busy',
            updatedAt: 1,
          },
        }),
      )
      const plugin = await connect()
      const pQ = createMessageQueue(plugin)
      plugin.send(
        JSON.stringify({ type: 'join', channel: 'c5' }),
      )
      await pQ()
      const res = await fetch(
        `${HTTP_URL}/agent-status/remove`,
        {
          method: 'POST',
          body: JSON.stringify({
            sessionId: 's5',
            agentId: 'ag5',
          }),
        },
      )
      expect(res.status).toBe(200)
      expect(await pQ()).toEqual({
        type: 'agent-status-remove',
        sessionId: 's5',
        agentId: 'ag5',
      })
      await closeWs(server2)
      await closeWs(plugin)
    })

    it('fades a busy row to idle after idleMs and removes it after ttlMs', async () => {
      const IDLE_PORT = 3130
      // Two independent races made this test hang to its 5s timeout (~1 run in
      // 50, reproducible at HEAD too — it is not new to this branch):
      //
      // 1. The observer used to join AFTER the busy row was created. The row
      //    ages from its own `updatedAt`, so a slow connect+join could land
      //    past idleMs (observer misses the fade and sees the remove where it
      //    expected idle) or past ttlMs (row already gone, nothing is ever
      //    broadcast). Fixed by subscribing the observer FIRST, so it is a
      //    member for every broadcast the row will ever produce and reads them
      //    in order: busy → idle → remove.
      //
      // 2. startRelay drives heartbeat EVICTION and the idle/TTL sweep from a
      //    single timer, so `heartbeatInterval` is both "how often the sweep
      //    runs" and "how long a client has to answer a ping". At 15ms any
      //    client whose pong missed one tick was closed mid-test; an
      //    instrumented run caught exactly that (observer got the join ack and
      //    the busy frame, then BOTH sockets closed with code 1000, and the
      //    idle broadcast never arrived).
      //
      // So the sweep is no longer made fast by shortening the tick. The tick is
      // 150ms — 10x more pong headroom — and promptness comes from backdating
      // `updatedAt` instead: the row is already idle-eligible when it is
      // created, so the FIRST tick fades it whatever the tick's phase, and
      // ttlMs stays far enough above that starting age that no single tick can
      // skip the idle state and go straight to remove.
      const IDLE_TICK = 150
      const IDLE_START_AGE = 50 // > idleMs on arrival: first tick fades it
      const idleServer = startRelay(IDLE_PORT, {
        idleMs: 10,
        ttlMs: 800,
        heartbeatInterval: IDLE_TICK,
      })

      const connectIdle = (): Promise<WebSocket> =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(
            `ws://localhost:${IDLE_PORT}`,
          )
          ws.onopen = () => resolve(ws)
          ws.onerror = () =>
            reject(new Error('WebSocket connection failed'))
        })

      try {
        // Observer first: joined before the row exists, so no broadcast
        // predates its membership.
        const p = await connectIdle()
        const pQ = createMessageQueue(p)
        p.send(
          JSON.stringify({ type: 'join', channel: 'cx' }),
        )
        await pQ()

        const s = await connectIdle()
        const sQ = createMessageQueue(s)
        s.send(
          JSON.stringify({ type: 'join', channel: 'cx' }),
        )
        await sQ()
        s.send(
          JSON.stringify({
            type: 'agent-status',
            channel: 'cx',
            record: {
              key: 'k',
              sessionId: 's',
              level: 'normal',
              text: 'x',
              activity: 'busy',
              updatedAt: Date.now() - IDLE_START_AGE,
            },
          }),
        )

        // The row's own creation is broadcast to the observer first (the
        // sender is excluded from its own agent-status broadcast).
        const busy = await pQ()
        expect(busy).toMatchObject({
          type: 'agent-status',
          record: { key: 'k', activity: 'busy' },
        })

        const idle = await pQ()
        expect(idle).toMatchObject({
          type: 'agent-status',
          record: { key: 'k', activity: 'idle' },
        })

        const removed = await pQ()
        expect(removed).toMatchObject({
          type: 'agent-status-remove',
          sessionId: 's',
          key: 'k',
        })

        await closeWs(s)
        await closeWs(p)
      } finally {
        stopRelay(idleServer)
      }
    })

    it('does not drop command frames when interleaved agent-status skeletons share the token bucket (status-monitor.md review corrections)', async () => {
      // dispatch() sends one agent-status skeleton immediately before every
      // identity-bearing command (Task 7), doubling the server→relay frame
      // rate on the same socket. A small, deterministic token bucket proves
      // the point fast: N command frames alone fit the burst; N commands
      // PLUS N skeletons (2N frames) would overflow it if agent-status still
      // consumed a token. agent-status frames must be exempt from
      // `consumeToken` so a burst of real commands never gets silently
      // dropped (a dropped command frame hangs the caller forever).
      const BURST_PORT = 3140
      const burstServer = startRelay(BURST_PORT, {
        rateBurst: 20,
        rateTokensPerSec: 1,
      })
      const connectBurst = (): Promise<WebSocket> =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(
            `ws://localhost:${BURST_PORT}`,
          )
          ws.onopen = () => resolve(ws)
          ws.onerror = () =>
            reject(new Error('WebSocket connection failed'))
        })

      try {
        const server2 = await connectBurst() // the "MCP server" socket
        const plugin = await connectBurst() // the "plugin" socket
        const sQ = createMessageQueue(server2)
        const pQ = createMessageQueue(plugin)
        server2.send(
          JSON.stringify({
            type: 'join',
            channel: 'burst-ch',
          }),
        )
        await sQ()
        plugin.send(
          JSON.stringify({
            type: 'join',
            channel: 'burst-ch',
          }),
        )
        await pQ()

        const N = 15 // <= rateBurst(20) alone; 2*N (30) overflows it
        const commandFrames: unknown[] = []
        plugin.onmessage = event => {
          const parsed = JSON.parse(
            event.data as string,
          ) as { type: string }
          if (parsed.type === 'broadcast') {
            commandFrames.push(parsed)
          }
        }

        for (let i = 0; i < N; i++) {
          // Mirrors dispatch(): skeleton immediately followed by the real
          // command, on the same server socket.
          server2.send(
            JSON.stringify({
              type: 'agent-status',
              channel: 'burst-ch',
              record: {
                key: 'a',
                sessionId: 's',
                level: 'normal',
                text: null,
                activity: 'busy',
                updatedAt: Date.now(),
              },
            }),
          )
          server2.send(
            JSON.stringify({
              type: 'message',
              channel: 'burst-ch',
              message: {
                command: 'inspect',
                params: {},
                meta: { requestId: `r${i}` },
              },
            }),
          )
        }

        await Bun.sleep(150)
        expect(commandFrames.length).toBe(N)

        await closeWs(server2)
        await closeWs(plugin)
      } finally {
        stopRelay(burstServer)
      }
    })
  })

  describe('version-mismatch frame', () => {
    it('routes to other members (channel dropped) and NOT the sender', async () => {
      const server2 = await connect() // the "MCP server" socket
      const plugin = await connect() // the "plugin" socket
      const sQ = createMessageQueue(server2)
      const pQ = createMessageQueue(plugin)
      server2.send(
        JSON.stringify({ type: 'join', channel: 'vm1' }),
      )
      await sQ()
      plugin.send(
        JSON.stringify({ type: 'join', channel: 'vm1' }),
      )
      await pQ()

      let senderEcho = 0
      server2.onmessage = () => {
        senderEcho++
      }
      server2.send(
        JSON.stringify({
          type: 'version-mismatch',
          channel: 'vm1',
          plugin: '0.3.0',
          server: '0.4.0',
        }),
      )
      const got = await pQ()
      expect(got).toEqual({
        type: 'version-mismatch',
        plugin: '0.3.0',
        server: '0.4.0',
      })
      await Bun.sleep(50)
      expect(senderEcho).toBe(0)

      await closeWs(server2)
      await closeWs(plugin)
    })

    it('is route-only: nothing is stored, status-sync replays empty', async () => {
      const server2 = await connect()
      const sQ = createMessageQueue(server2)
      server2.send(
        JSON.stringify({ type: 'join', channel: 'vm2' }),
      )
      await sQ()
      server2.send(
        JSON.stringify({
          type: 'version-mismatch',
          channel: 'vm2',
          plugin: '0.3.0',
          server: '0.4.0',
        }),
      )

      const plugin = await connect()
      const pQ = createMessageQueue(plugin)
      plugin.send(
        JSON.stringify({ type: 'join', channel: 'vm2' }),
      )
      await pQ() // join ack
      plugin.send(
        JSON.stringify({
          type: 'status-sync',
          channel: 'vm2',
        }),
      )
      const sync = (await pQ()) as {
        type: string
        records: unknown[]
      }
      expect(sync.type).toBe('agent-status-sync')
      expect(sync.records).toEqual([])

      await closeWs(server2)
      await closeWs(plugin)
    })
  })
})

const RELAY_VERSION_PORT = 18191
const RELAY_VERSION_WS = `ws://localhost:${RELAY_VERSION_PORT}`
const RELAY_VERSION_HTTP = `http://localhost:${RELAY_VERSION_PORT}`

describe('relay stores register version', () => {
  let server: ReturnType<typeof startRelay>
  beforeEach(() => {
    server = startRelay(RELAY_VERSION_PORT)
  })
  afterEach(() => {
    stopRelay(server)
  })

  it('exposes the registered version on GET /channels', async () => {
    const ws = new WebSocket(RELAY_VERSION_WS)
    await new Promise<void>((res, rej) => {
      ws.onerror = () => rej(new Error('ws error'))
      ws.onopen = () =>
        ws.send(
          JSON.stringify({ type: 'join', channel: 'ch1' }),
        )
      ws.onmessage = e => {
        const m = JSON.parse(e.data as string)
        if (m.type === 'system') {
          ws.send(
            JSON.stringify({
              type: 'register',
              channel: 'ch1',
              fileName: 'f.fig',
              version: APP_VERSION,
            }),
          )
          setTimeout(res, 50)
        }
      }
    })
    const channels = await (
      await fetch(`${RELAY_VERSION_HTTP}/channels`)
    ).json()
    const ch1 = (channels as ChannelInfo[]).find(
      (c: ChannelInfo) => c.channel === 'ch1',
    )
    expect(ch1?.version).toBe(APP_VERSION)
    ws.close()
  })
})
