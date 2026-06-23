import { randomUUID } from 'node:crypto'
import type {
  BroadcastMessage,
  ChannelInfo,
  ChannelMessage,
  CommandMessage,
  JoinMessage,
  SystemMessage,
} from '@figma-agent-bridge/shared'

export type FigmaClient = {
  joinChannel: (channel: string) => Promise<string>
  sendCommand: (
    command: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>
  disconnect: () => void
  isConnected: () => boolean
  currentChannel: () => string | null
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const JOIN_TIMEOUT_MS = 3e4

type JoinPending = {
  resolve: (result: string) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export const discoverChannels = async (
  relayHttpUrl: string,
): Promise<ChannelInfo[]> => {
  try {
    const res = await fetch(`${relayHttpUrl}/channels`)
    if (!res.ok) {
      return []
    }
    return (await res.json()) as ChannelInfo[]
  } catch {
    return []
  }
}

export const createFigmaClient = (
  relayUrl: string,
): FigmaClient => {
  let ws: WebSocket | null = null
  let channel: string | null = null
  let pendingChannel: string | null = null
  const pending = new Map<string, PendingRequest>()
  let joinPending: JoinPending | null = null

  const rejectAll = (reason: string) => {
    pending.forEach(({ reject, timer }) => {
      clearTimeout(timer)
      reject(new Error(reason))
    })
    pending.clear()

    if (joinPending !== null) {
      const { reject, timer } = joinPending
      joinPending = null
      clearTimeout(timer)
      reject(new Error(reason))
    }
  }

  const handleMessage = (event: MessageEvent) => {
    let parsed: BroadcastMessage | SystemMessage

    try {
      parsed = JSON.parse(event.data as string) as
        | BroadcastMessage
        | SystemMessage
    } catch {
      return
    }

    if (parsed.type === 'system') {
      if (joinPending !== null) {
        const { resolve, timer } = joinPending
        joinPending = null
        clearTimeout(timer)
        channel = pendingChannel
        resolve(parsed.message.result)
      }

      return
    }

    if (parsed.type === 'broadcast') {
      const { message } = parsed
      const hasResponse =
        message.result !== undefined ||
        message.error !== undefined
      const req = pending.get(message.id)
      if (req !== undefined && hasResponse) {
        clearTimeout(req.timer)
        pending.delete(message.id)
        if (message.error !== undefined) {
          req.reject(new Error(message.error))
        } else {
          req.resolve(message.result)
        }
      }
    }
  }

  const connect = (): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        resolve(ws)
        return
      }

      const socket = new WebSocket(relayUrl)

      socket.onopen = () => {
        ws = socket
        resolve(socket)
      }

      socket.onerror = () => {
        reject(new Error('WebSocket connection failed'))
      }

      socket.onmessage = handleMessage

      socket.onclose = () => {
        if (ws !== null) {
          ws = null
          channel = null
          rejectAll('Disconnected')
        }
      }
    })

  const joinChannel = (ch: string): Promise<string> => {
    if (joinPending !== null) {
      return Promise.reject(
        new Error('Join already in progress'),
      )
    }

    // Set joinPending synchronously before any await to prevent concurrent joins.
    const joinPromise = new Promise<string>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          joinPending = null
          reject(new Error('Join timed out'))
        }, JOIN_TIMEOUT_MS)

        joinPending = { resolve, reject, timer }
      },
    )

    pendingChannel = ch

    // Connect and send join frame; errors propagate via rejectAll or socket close.
    connect()
      .then(socket => {
        const msg: JoinMessage = {
          type: 'join',
          channel: ch,
        }
        socket.send(JSON.stringify(msg))
      })
      .catch(err => {
        if (joinPending !== null) {
          const { reject, timer } = joinPending
          joinPending = null
          clearTimeout(timer)
          reject(err as Error)
        }
      })

    return joinPromise
  }

  const sendCommand = (
    command: string,
    params?: Record<string, unknown>,
    timeoutMs = 3e4,
  ): Promise<unknown> => {
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected'))
    }

    if (channel === null) {
      return Promise.reject(new Error('Not in a channel'))
    }

    const socket = ws
    const ch = channel
    const id = randomUUID()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Command ${id} timed out`))
      }, timeoutMs)

      pending.set(id, { resolve, reject, timer })

      const cmdMessage: CommandMessage = {
        id,
        command,
        params,
      }

      const msg: ChannelMessage = {
        type: 'message',
        channel: ch,
        message: cmdMessage,
      }

      socket.send(JSON.stringify(msg))
    })
  }

  const disconnect = (): void => {
    const socket = ws
    ws = null
    channel = null
    rejectAll('Disconnected')
    if (socket !== null) {
      socket.close()
    }
  }

  const isConnected = (): boolean =>
    ws !== null &&
    ws.readyState === WebSocket.OPEN &&
    channel !== null

  const currentChannel = (): string | null => channel

  return {
    joinChannel,
    sendCommand,
    disconnect,
    isConnected,
    currentChannel,
  }
}
