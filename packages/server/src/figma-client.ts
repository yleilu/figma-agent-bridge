import { randomUUID } from 'node:crypto'
import { relayOutgoingSchema } from '@figma-agent-bridge/shared'
import type {
  ChannelInfo,
  ChannelMessage,
  CommandMessage,
  JoinMessage,
} from '@figma-agent-bridge/shared'

export type FigmaClient = {
  joinChannel: (channel: string) => Promise<string>
  sendCommand: (
    command: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>
  notify: (command: string, params: Record<string, unknown>) => void
  onRequest: (
    command: string,
    handler: (
      params: Record<string, unknown>,
    ) => Promise<unknown> | unknown,
  ) => void
  disconnect: () => void
  isConnected: () => boolean
  currentChannel: () => string | null
}

type Pending<T> = {
  resolve: (value: T) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const JOIN_TIMEOUT_MS = 3e4

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
  joinTimeoutMs = JOIN_TIMEOUT_MS,
): FigmaClient => {
  let ws: WebSocket | null = null
  let disconnected = false
  let channel: string | null = null
  let pendingChannel: string | null = null
  const pending = new Map<string, Pending<unknown>>()
  let joinPending: Pending<string> | null = null
  const requestHandlers = new Map<
    string,
    (params: Record<string, unknown>) => Promise<unknown> | unknown
  >()

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
    const raw = (() => {
      try {
        return JSON.parse(event.data as string) as unknown
      } catch {
        return null
      }
    })()
    if (raw === null) {
      return
    }

    const parsedResult = relayOutgoingSchema.safeParse(raw)
    if (!parsedResult.success) {
      return
    }
    const parsed = parsedResult.data

    if (parsed.type === 'system') {
      if (joinPending !== null) {
        const { result } = parsed.message
        // The relay sends "Error: <reason>" for both cap-exceeded rejections and
        // other join failures. Detect this prefix and reject rather than resolve.
        // TODO(follow-up): a cleaner long-term fix is a distinct relay frame type
        // (e.g. type: 'join-rejected') so clients never need to parse free-text.
        if (result.startsWith('Error:')) {
          const { reject, timer } = joinPending
          joinPending = null
          pendingChannel = null
          clearTimeout(timer)
          reject(new Error(result))
        } else {
          const { resolve, timer } = joinPending
          joinPending = null
          clearTimeout(timer)
          channel = pendingChannel
          resolve(result)
        }
      }

      return
    }

    // parsed.type === 'broadcast'
    const { message } = parsed

    // Inbound request from the plugin (unsolicited; we did not originate it).
    // These carry a `command` AND match a registered handler. Command REPLIES
    // ({ id, result|error } with NO command) fall through to pending-resolution.
    if (
      message.command !== undefined &&
      requestHandlers.has(message.command)
    ) {
      const handler = requestHandlers.get(message.command)!
      Promise.resolve(handler(message.params ?? {}))
        .then(result => {
          sendReply(message.id, { result })
        })
        .catch((err: unknown) => {
          sendReply(message.id, {
            error:
              err instanceof Error ? err.message : String(err),
          })
        })
      return
    }

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

  const connect = (): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      if (disconnected) {
        reject(new Error('WebSocket connection failed'))
        return
      }

      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        resolve(ws)
        return
      }

      const socket = new WebSocket(relayUrl)

      socket.onopen = () => {
        // Guard against disconnect() being called while connect() was in flight.
        if (disconnected) {
          // disconnect() already ran; close this socket to avoid leaking a relay slot.
          socket.close()
          reject(new Error('WebSocket connection failed'))
          return
        }
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
          pendingChannel = null
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

    // A new joinChannel call represents an intentional reconnect — reset the
    // disconnected flag so connect() can open a fresh socket.
    disconnected = false

    // Set joinPending synchronously before any await to prevent concurrent joins.
    const joinPromise = new Promise<string>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          joinPending = null
          pendingChannel = null
          reject(new Error('Join timed out'))
        }, joinTimeoutMs)

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
          pendingChannel = null
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

  const notify = (
    command: string,
    params: Record<string, unknown>,
  ): void => {
    const socket = ws
    const ch = channel
    if (socket === null || ch === null) {
      // Best-effort: no plugin attached, drop silently.
      return
    }

    const message: CommandMessage = {
      id: randomUUID(),
      command,
      params,
    }

    const frame: ChannelMessage = {
      type: 'message',
      channel: ch,
      message,
    }

    socket.send(JSON.stringify(frame))
  }

  const onRequest = (
    command: string,
    handler: (
      params: Record<string, unknown>,
    ) => Promise<unknown> | unknown,
  ): void => {
    requestHandlers.set(command, handler)
  }

  const sendReply = (
    id: string,
    body: { result?: unknown; error?: string },
  ): void => {
    const socket = ws
    const ch = channel
    if (socket === null || ch === null) {
      return
    }

    const message: CommandMessage = { id, ...body }
    const frame: ChannelMessage = {
      type: 'message',
      channel: ch,
      message,
    }

    socket.send(JSON.stringify(frame))
  }

  const disconnect = (): void => {
    disconnected = true
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
    notify,
    onRequest,
    disconnect,
    isConnected,
    currentChannel,
  }
}
