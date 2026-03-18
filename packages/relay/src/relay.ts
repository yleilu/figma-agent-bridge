import type { Server, ServerWebSocket } from 'bun'
import type {
  BroadcastMessage,
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

type WsData = { id: string }

const channels = new Map<
  string,
  Set<ServerWebSocket<WsData>>
>()

const clientChannels = new Map<string, Set<string>>()

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
  return Bun.serve<WsData>({
    port,
    fetch: (req, srv) => {
      const upgraded = srv.upgrade(req, {
        data: { id: randomUUID() },
      })

      if (upgraded) {
        return undefined
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
        } else if (parsed.type === 'message') {
          handleMessage(parsed.channel, parsed)
        }
      },
      close: ws => {
        removeClient(ws)
      },
    },
  })
}

export const stopRelay = (server: Server<WsData>): void => {
  channels.clear()
  clientChannels.clear()
  server.stop(true)
}
