import type { Server, ServerWebSocket } from 'bun'
import type {
  BroadcastMessage,
  ChannelInfo,
  ChannelMessage,
  RelayOutgoing,
  SystemMessage,
} from '@figma-agent-bridge/shared'
import {
  DEFAULT_PORT,
  relayIncomingSchema,
} from '@figma-agent-bridge/shared'
import { randomUUID } from 'node:crypto'

const MAX_CHANNELS_PER_CONNECTION = 32
const MAX_MEMBERS_PER_CHANNEL = 64
const MAX_TOTAL_CHANNELS = 1024
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024
const RATE_TOKENS_PER_SEC = 50
const RATE_BURST = 100
const DEFAULT_HEARTBEAT_INTERVAL = 30_000

type WsData = { id: string }
type RateState = { tokens: number; last: number }

type RelayContext = {
  channels: Map<string, Set<ServerWebSocket<WsData>>>
  clientChannels: Map<string, Set<string>>
  channelRegistry: Map<string, ChannelInfo>
  sockets: Set<ServerWebSocket<WsData>>
  alive: WeakMap<ServerWebSocket<WsData>, boolean>
  rate: WeakMap<ServerWebSocket<WsData>, RateState>
  heartbeatTimer: ReturnType<typeof setInterval> | null
}

const contexts = new WeakMap<Server<WsData>, RelayContext>()

const createContext = (): RelayContext => ({
  channels: new Map(),
  clientChannels: new Map(),
  channelRegistry: new Map(),
  sockets: new Set(),
  alive: new WeakMap(),
  rate: new WeakMap(),
  heartbeatTimer: null,
})

const send = (
  ws: ServerWebSocket<WsData>,
  msg: RelayOutgoing,
) => {
  ws.send(JSON.stringify(msg))
}

const consumeToken = (
  ctx: RelayContext,
  ws: ServerWebSocket<WsData>,
): boolean => {
  const state = ctx.rate.get(ws)
  if (state === undefined) {
    // Bucket must always be seeded in `open`; missing state is a bug.
    return false
  }
  const now = Date.now()
  const elapsed = (now - state.last) / 1000
  state.tokens = Math.min(
    RATE_BURST,
    state.tokens + elapsed * RATE_TOKENS_PER_SEC,
  )
  state.last = now
  if (state.tokens < 1) {
    return false
  }
  state.tokens -= 1
  return true
}

const rejectJoin = (
  ws: ServerWebSocket<WsData>,
  reason: string,
) => {
  const reply: SystemMessage = {
    type: 'system',
    message: {
      id: randomUUID(),
      result: `Error: ${reason}`,
    },
  }
  send(ws, reply)
}

const removeClient = (
  ctx: RelayContext,
  ws: ServerWebSocket<WsData>,
) => {
  const { id } = ws.data
  const joined = ctx.clientChannels.get(id)

  if (joined !== undefined) {
    joined.forEach(channel => {
      const members = ctx.channels.get(channel)
      if (members !== undefined) {
        members.delete(ws)
        if (members.size === 0) {
          ctx.channels.delete(channel)
          ctx.channelRegistry.delete(channel)
        }
      }
    })
    ctx.clientChannels.delete(id)
  }
}

const handleJoin = (
  ctx: RelayContext,
  ws: ServerWebSocket<WsData>,
  channel: string,
) => {
  const { id } = ws.data

  const joinedSet = ctx.clientChannels.get(id)
  const alreadyIn = joinedSet?.has(channel) === true

  if (!alreadyIn) {
    if (
      (joinedSet?.size ?? 0) >= MAX_CHANNELS_PER_CONNECTION
    ) {
      rejectJoin(
        ws,
        'channel limit reached for this connection',
      )
      return
    }
    const existing = ctx.channels.get(channel)
    if (existing === undefined) {
      if (ctx.channels.size >= MAX_TOTAL_CHANNELS) {
        rejectJoin(ws, 'global channel limit reached')
        return
      }
    } else if (existing.size >= MAX_MEMBERS_PER_CHANNEL) {
      rejectJoin(
        ws,
        'member limit reached for this channel',
      )
      return
    }
  }

  let members = ctx.channels.get(channel)
  if (members === undefined) {
    members = new Set()
    ctx.channels.set(channel, members)
  }
  members.add(ws)
  ctx.alive.set(ws, true)

  if (!ctx.channelRegistry.has(channel)) {
    ctx.channelRegistry.set(channel, {
      channel,
      fileName: null,
      connectedAt: Date.now(),
    })
  }

  let joined = ctx.clientChannels.get(id)
  if (joined === undefined) {
    joined = new Set()
    ctx.clientChannels.set(id, joined)
  }
  joined.add(channel)

  const reply: SystemMessage = {
    type: 'system',
    message: {
      id: randomUUID(),
      result: `Connected to channel: ${channel}`,
    },
  }

  send(ws, reply)
}

const handleRegister = (
  ctx: RelayContext,
  ws: ServerWebSocket<WsData>,
  channel: string,
  fileName: string | null,
) => {
  if (
    ctx.clientChannels.get(ws.data.id)?.has(channel) !==
    true
  ) {
    return
  }
  const entry = ctx.channelRegistry.get(channel)
  if (entry !== undefined) {
    entry.fileName = fileName
  }
}

const handleMessage = (
  ctx: RelayContext,
  ws: ServerWebSocket<WsData>,
  channel: string,
  message: ChannelMessage,
) => {
  const members = ctx.channels.get(channel)
  if (members === undefined) {
    return
  }

  const broadcast: BroadcastMessage = {
    type: 'broadcast',
    message: message.message,
  }

  members.forEach(client => {
    if (client !== ws) {
      send(client, broadcast)
    }
  })
}

export type StartRelayOptions = {
  hostname?: string
  heartbeatInterval?: number
}

export const startRelay = (
  port = DEFAULT_PORT,
  opts: StartRelayOptions = {},
): Server<WsData> => {
  const ctx = createContext()
  const hostname =
    opts.hostname ?? process.env.RELAY_BIND ?? '127.0.0.1'
  const heartbeatInterval =
    opts.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL

  const server = Bun.serve<WsData>({
    port,
    hostname,
    fetch: (req, srv) => {
      if (
        req.headers.get('upgrade')?.toLowerCase() ===
        'websocket'
      ) {
        const upgraded = srv.upgrade(req, {
          data: { id: randomUUID() },
        })
        if (upgraded) {
          return undefined
        }
      }

      const url = new URL(req.url)
      if (
        req.method === 'GET' &&
        url.pathname === '/channels'
      ) {
        return Response.json(
          Array.from(ctx.channelRegistry.values()),
        )
      }

      return new Response('WebSocket only', {
        status: 426,
      })
    },
    websocket: {
      maxPayloadLength: MAX_PAYLOAD_BYTES,
      open: ws => {
        ctx.sockets.add(ws)
        ctx.alive.set(ws, true)
        ctx.rate.set(ws, {
          tokens: RATE_BURST,
          last: Date.now(),
        })
      },
      message: (ws, raw) => {
        let json: unknown
        try {
          json = JSON.parse(raw as string)
        } catch {
          return
        }

        const parsed = relayIncomingSchema.safeParse(json)
        if (!parsed.success) {
          return
        }
        if (!consumeToken(ctx, ws)) {
          return
        }
        const frame = parsed.data

        if (frame.type === 'join') {
          handleJoin(ctx, ws, frame.channel)
        } else if (frame.type === 'register') {
          handleRegister(
            ctx,
            ws,
            frame.channel,
            frame.fileName,
          )
        } else if (frame.type === 'message') {
          handleMessage(ctx, ws, frame.channel, frame)
        }
      },
      pong: ws => {
        ctx.alive.set(ws, true)
      },
      close: ws => {
        ctx.sockets.delete(ws)
        removeClient(ctx, ws)
      },
    },
  })

  ctx.heartbeatTimer = setInterval(() => {
    const dead = []
    for (const ws of ctx.sockets) {
      if (ctx.alive.get(ws) === false) {
        dead.push(ws)
        continue
      }
      ctx.alive.set(ws, false)
      ws.ping()
    }
    for (const ws of dead) {
      ws.close()
    }
  }, heartbeatInterval)

  contexts.set(server, ctx)
  return server
}

export const stopRelay = (server: Server<WsData>): void => {
  const ctx = contexts.get(server)
  if (ctx !== undefined) {
    if (ctx.heartbeatTimer !== null) {
      clearInterval(ctx.heartbeatTimer)
      ctx.heartbeatTimer = null
    }
    ctx.channels.clear()
    ctx.clientChannels.clear()
    ctx.channelRegistry.clear()
    ctx.sockets.clear()
    contexts.delete(server)
  }
  server.stop(true)
}
