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
  ChannelInfo,
  SystemMessage,
} from '@figma-agent-bridge/shared/types'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'

const TEST_PORT = 3099
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
          id: 'cmd-1',
          command: 'ping',
        },
      }),
    )

    const broadcast =
      (await nextMessage2()) as BroadcastMessage
    expect(broadcast.type).toBe('broadcast')
    expect(broadcast.message.id).toBe('cmd-1')
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
    ws.send(JSON.stringify({ type: 'join', channel: 'iso-ch' }))
    await nextMessage()

    const firstChannels = (await (
      await fetch(`${HTTP_URL}/channels`)
    ).json()) as ChannelInfo[]
    const secondChannels = (await (
      await fetch(`http://localhost:${SECOND_PORT}/channels`)
    ).json()) as ChannelInfo[]

    expect(firstChannels.map(c => c.channel)).toEqual(['iso-ch'])
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
  })

  it('ignores register for a channel the client never joined', async () => {
    const owner = await connect()
    const ownerNext = createMessageQueue(owner)
    owner.send(JSON.stringify({ type: 'join', channel: 'guard-ch' }))
    await ownerNext()

    // attacker joins a DIFFERENT channel, then tries to register guard-ch
    const attacker = await connect()
    const attackerNext = createMessageQueue(attacker)
    attacker.send(JSON.stringify({ type: 'join', channel: 'other-ch' }))
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

    ws1.send(JSON.stringify({ type: 'join', channel: 'echo-ch' }))
    await next1()
    ws2.send(JSON.stringify({ type: 'join', channel: 'echo-ch' }))
    await next2()

    ws1.send(
      JSON.stringify({
        type: 'message',
        channel: 'echo-ch',
        message: { id: 'cmd-x', command: 'noop' },
      }),
    )

    // ws2 receives the broadcast
    const broadcast = (await next2()) as BroadcastMessage
    expect(broadcast.type).toBe('broadcast')
    expect(broadcast.message.id).toBe('cmd-x')

    // ws1 must NOT receive its own broadcast: send a marker join and assert
    // the next frame ws1 sees is the system reply, not the broadcast
    ws1.send(JSON.stringify({ type: 'join', channel: 'echo-ch' }))
    const afterSelf = (await next1()) as SystemMessage
    expect(afterSelf.type).toBe('system')

    await closeWs(ws1)
    await closeWs(ws2)
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
    ws.send(JSON.stringify({ type: 'join', channel: 'ok-ch' }))
    const msg = (await nextMessage()) as SystemMessage
    expect(msg.type).toBe('system')
    expect(msg.message.result).toBe('Connected to channel: ok-ch')

    // registry has only the valid channel
    const data = (await (
      await fetch(`${HTTP_URL}/channels`)
    ).json()) as ChannelInfo[]
    expect(data.map(c => c.channel)).toEqual(['ok-ch'])

    await closeWs(ws)
  })
})
