import type { Server, ServerWebSocket } from 'bun'
import type {
  BroadcastMessage,
  ChannelInfo,
  ChannelMessage,
  PongMessage,
  RelayIncoming,
  SystemMessage,
} from '@figma-agent-bridge/shared'
import {
  APP_NAME,
  APP_VERSION,
} from '@figma-agent-bridge/shared'
import { randomUUID } from 'crypto'

const HEARTBEAT_INTERVAL = 30_000

type WsData = { id: string }

const channels = new Map<
  string,
  Set<ServerWebSocket<WsData>>
>()

const clientChannels = new Map<string, Set<string>>()
const channelRegistry = new Map<string, ChannelInfo>()
const alive = new WeakMap<
  ServerWebSocket<WsData>,
  boolean
>()
let heartbeatTimer: ReturnType<typeof setInterval> | null =
  null

const removeClient = (ws: ServerWebSocket<WsData>) => {
  const { id } = ws.data
  const joined = clientChannels.get(id)

  if (joined !== undefined) {
    joined.forEach(channel => {
      const members = channels.get(channel)
      if (members !== undefined) {
        members.delete(ws)
        if (members.size === 0) {
          channels.delete(channel)
          channelRegistry.delete(channel)
        }
      }
    })
    clientChannels.delete(id)
  }
}

const handleJoin = (
  ws: ServerWebSocket<WsData>,
  channel: string,
) => {
  const { id } = ws.data

  let members = channels.get(channel)
  if (members === undefined) {
    members = new Set()
    channels.set(channel, members)
  }
  members.add(ws)
  alive.set(ws, true)

  if (!channelRegistry.has(channel)) {
    channelRegistry.set(channel, {
      channel,
      fileName: null,
      connectedAt: Date.now(),
    })
  }

  let joined = clientChannels.get(id)
  if (joined === undefined) {
    joined = new Set()
    clientChannels.set(id, joined)
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
  channel: string,
  fileName: string | null,
) => {
  const entry = channelRegistry.get(channel)
  if (entry !== undefined) {
    entry.fileName = fileName
  }
}

const handleMessage = (
  channel: string,
  message: ChannelMessage,
) => {
  const members = channels.get(channel)
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

export const startRelay = (
  port: number = 3000,
): Server<WsData> => {
  const server = Bun.serve<WsData>({
    port,
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
          Array.from(channelRegistry.values()),
        )
      }

      return new Response('WebSocket only', {
        status: 426,
      })
    },
    websocket: {
      message: (ws, raw) => {
        let parsed: RelayIncoming

        try {
          parsed = JSON.parse(
            raw as string,
          ) as RelayIncoming
        } catch {
          return
        }

        if (parsed.type === 'ping') {
          const pong: PongMessage = {
            type: 'pong',
            name: APP_NAME,
            version: APP_VERSION,
          }
          ws.send(JSON.stringify(pong))
        } else if (parsed.type === 'join') {
          handleJoin(ws, parsed.channel)
        } else if (parsed.type === 'register') {
          handleRegister(parsed.channel, parsed.fileName)
        } else if (parsed.type === 'message') {
          handleMessage(parsed.channel, parsed)
        }
      },
      pong: ws => {
        alive.set(ws, true)
      },
      close: ws => {
        removeClient(ws)
      },
    },
  })

  heartbeatTimer = setInterval(() => {
    for (const [, members] of channels) {
      for (const ws of members) {
        if (alive.get(ws) === false) {
          ws.close()
          continue
        }
        alive.set(ws, false)
        ws.ping()
      }
    }
  }, HEARTBEAT_INTERVAL)

  return server
}

export const stopRelay = (server: Server<WsData>): void => {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  channels.clear()
  clientChannels.clear()
  channelRegistry.clear()
  server.stop(true)
}
