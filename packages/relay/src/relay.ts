import type { Server, ServerWebSocket } from 'bun'
import type {
  BroadcastMessage,
  ChannelInfo,
  ChannelMessage,
  RelayIncoming,
  SystemMessage,
} from '@figma-agent-bridge/shared'
import { DEFAULT_PORT } from '@figma-agent-bridge/shared'
import { randomUUID } from 'node:crypto'

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

  ws.send(JSON.stringify(reply))
}

const handleRegister = (
  ctx: RelayContext,
  channel: string,
  fileName: string | null,
) => {
  const entry = ctx.channelRegistry.get(channel)
  if (entry !== undefined) {
    entry.fileName = fileName
  }
}

const handleMessage = (
  ctx: RelayContext,
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
  const payload = JSON.stringify(broadcast)

  members.forEach(client => {
    client.send(payload)
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
      open: ws => {
        ctx.sockets.add(ws)
        ctx.alive.set(ws, true)
      },
      message: (ws, raw) => {
        let parsed: RelayIncoming

        try {
          parsed = JSON.parse(raw as string) as RelayIncoming
        } catch {
          return
        }

        if (parsed.type === 'join') {
          handleJoin(ctx, ws, parsed.channel)
        } else if (parsed.type === 'register') {
          handleRegister(ctx, parsed.channel, parsed.fileName)
        } else if (parsed.type === 'message') {
          handleMessage(ctx, parsed.channel, parsed)
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
    for (const ws of ctx.sockets) {
      if (ctx.alive.get(ws) === false) {
        ws.close()
        continue
      }
      ctx.alive.set(ws, false)
      ws.ping()
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
