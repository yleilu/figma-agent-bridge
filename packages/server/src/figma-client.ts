import {
  genId,
  relayOutgoingSchema,
} from '@figma-agent-bridge/shared'
import type {
  ChannelInfo,
  ChannelMessage,
  CommandMessage,
  JoinMessage,
  Meta,
} from '@figma-agent-bridge/shared'

/** A file-scoped view of the client: sendCommand needs no fileKey (captured). */
export type ScopedFigmaClient = {
  fileKey: string
  sendCommand: (
    command: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>
}

export type FigmaClient = {
  joinChannel: (
    channel: string,
    fileKey: string,
  ) => Promise<string>
  sendCommand: (
    fileKey: string,
    command: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>
  forFile: (
    fileKey: string,
    opts?: { sessionId?: string },
  ) => ScopedFigmaClient
  notify: (
    command: string,
    params: Record<string, unknown>,
  ) => void
  onRequest: (
    command: string,
    handler: (
      params: Record<string, unknown>,
    ) => Promise<unknown> | unknown,
  ) => void
  disconnect: () => void
  isConnected: () => boolean
  joinedFiles: () => string[]
  channelFor: (fileKey: string) => string | null
  discover: () => Promise<ChannelInfo[]>
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
  // Joined files: fileKey → channel. One socket, many channels (B3 multi-file).
  const joined = new Map<string, string>()
  // Dedupe concurrent joins for the SAME fileKey; serialize DISTINCT joins
  // through joinQueue so the single-slot handshake state below is never
  // clobbered by an overlapping join.
  const inFlight = new Map<string, Promise<string>>()
  let joinQueue: Promise<unknown> = Promise.resolve()
  // The single in-flight handshake's channel/fileKey (one outstanding ack at a
  // time, enforced by joinQueue). Committed into `joined` on the relay's ack.
  let pendingChannel: string | null = null
  let pendingFileKey: string | null = null
  // Pending requests, keyed by meta.requestId (globally unique, genId('cmd')).
  const pending = new Map<string, Pending<unknown>>()
  let joinPending: Pending<string> | null = null
  const requestHandlers = new Map<
    string,
    (
      params: Record<string, unknown>,
    ) => Promise<unknown> | unknown
  >()

  const relayHttpUrl = relayUrl
    .replace('wss://', 'https://')
    .replace('ws://', 'http://')

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
          pendingFileKey = null
          clearTimeout(timer)
          reject(new Error(result))
        } else {
          const { resolve, timer } = joinPending
          joinPending = null
          clearTimeout(timer)
          if (
            pendingChannel !== null &&
            pendingFileKey !== null
          ) {
            joined.set(pendingFileKey, pendingChannel)
          }
          pendingChannel = null
          pendingFileKey = null
          resolve(result)
        }
      }

      return
    }

    // parsed.type === 'broadcast'
    const { message } = parsed

    // Inbound request/push from the plugin (unsolicited; we did not originate
    // it). These carry a `command` AND match a registered handler. Command
    // REPLIES ({ meta:{requestId}, result|error } with NO command) fall through
    // to pending-resolution. A push with no meta.requestId (e.g. document_changed)
    // is dispatched but gets NO reply — replying would fan a stray frame.
    if (
      message.command !== undefined &&
      requestHandlers.has(message.command)
    ) {
      const handler = requestHandlers.get(message.command)!
      const rid = message.meta?.requestId
      // `sendReply` is defined later in this same closure; `handleMessage` only
      // runs at runtime (on an inbound message), so the forward reference is safe.
      /* eslint-disable @typescript-eslint/no-use-before-define */
      Promise.resolve(handler(message.params ?? {}))
        .then(result => {
          if (rid !== undefined) {
            sendReply(rid, { result })
          }
        })
        .catch((err: unknown) => {
          if (rid !== undefined) {
            sendReply(rid, {
              error:
                err instanceof Error
                  ? err.message
                  : String(err),
            })
          }
        })
      /* eslint-enable @typescript-eslint/no-use-before-define */
      return
    }

    const hasResponse =
      message.result !== undefined ||
      message.error !== undefined
    const rid = message.meta?.requestId
    const req =
      rid !== undefined ? pending.get(rid) : undefined
    if (
      req !== undefined &&
      rid !== undefined &&
      hasResponse
    ) {
      clearTimeout(req.timer)
      pending.delete(rid)
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
          joined.clear()
          inFlight.clear()
          pendingChannel = null
          pendingFileKey = null
          rejectAll('Disconnected')
        }
      }
    })

  // The actual single handshake. joinQueue guarantees only ONE runJoin is
  // outstanding at a time, so the single pending slot is safe. Resolves when the
  // relay's system ack lands, rejects on timeout / connect failure / Error-frame
  // / socket close.
  const runJoin = (
    ch: string,
    fileKey: string,
  ): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        joinPending = null
        pendingChannel = null
        pendingFileKey = null
        reject(new Error('Join timed out'))
      }, joinTimeoutMs)

      joinPending = { resolve, reject, timer }
      pendingChannel = ch
      pendingFileKey = fileKey

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
            joinPending = null
            pendingChannel = null
            pendingFileKey = null
            clearTimeout(timer)
            reject(err as Error)
          }
        })
    })

  const joinChannel = (
    ch: string,
    fileKey: string,
  ): Promise<string> => {
    disconnected = false
    if (joined.has(fileKey)) {
      return Promise.resolve(`Connected to channel: ${ch}`)
    }
    const existing = inFlight.get(fileKey)
    if (existing !== undefined) {
      return existing
    }
    const p = joinQueue.then(() => runJoin(ch, fileKey))
    joinQueue = p.catch(() => undefined)
    inFlight.set(fileKey, p)
    const clear = (): void => {
      inFlight.delete(fileKey)
    }
    p.then(clear, clear)
    return p
  }

  // The one request sender. Stamps meta { fileKey, requestId[, sessionId] } and
  // routes on the file's joined channel; the pending map is keyed by requestId.
  const dispatch = (
    fileKey: string,
    command: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
    sessionId?: string,
  ): Promise<unknown> => {
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected'))
    }
    const ch = joined.get(fileKey)
    if (ch === undefined) {
      return Promise.reject(
        new Error(`Not joined to file ${fileKey}`),
      )
    }
    const socket = ws
    const requestId = genId('cmd')

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`Command ${requestId} timed out`))
      }, timeoutMs)

      pending.set(requestId, { resolve, reject, timer })

      const meta: Meta = { fileKey, requestId }
      if (sessionId !== undefined) {
        meta.sessionId = sessionId
      }
      const cmdMessage: CommandMessage = {
        command,
        params,
        meta,
      }
      const msg: ChannelMessage = {
        type: 'message',
        channel: ch,
        message: cmdMessage,
      }
      socket.send(JSON.stringify(msg))
    })
  }

  const sendCommand = (
    fileKey: string,
    command: string,
    params?: Record<string, unknown>,
    timeoutMs = 3e4,
  ): Promise<unknown> =>
    dispatch(fileKey, command, params, timeoutMs)

  // A file-scoped view: sendCommand carries no fileKey (captured), and
  // sessionId (reserved, forward-compat) rides meta when the wrapper supplies it.
  const forFile = (
    fileKey: string,
    opts?: { sessionId?: string },
  ): ScopedFigmaClient => ({
    fileKey,
    sendCommand: (command, params, timeoutMs = 3e4) =>
      dispatch(
        fileKey,
        command,
        params,
        timeoutMs,
        opts?.sessionId,
      ),
  })

  // Fire-and-forget send (notify, sendReply). A broadcast frame carries no
  // channel, so a reply cannot be routed to one originating channel; send it on
  // EVERY joined channel and rely on the globally-unique meta.requestId so only
  // the plugin holding that pending id acts on it. Drops when the socket is closed.
  const sendFrame = (message: CommandMessage): void => {
    const socket = ws
    if (
      socket === null ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return
    }
    for (const ch of joined.values()) {
      socket.send(
        JSON.stringify({
          type: 'message',
          channel: ch,
          message,
        } satisfies ChannelMessage),
      )
    }
  }

  const notify = (
    command: string,
    params: Record<string, unknown>,
  ): void => {
    sendFrame({
      command,
      params,
      meta: { requestId: genId('ntf') },
    })
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
    requestId: string,
    body: { result?: unknown; error?: string },
  ): void => {
    sendFrame({ meta: { requestId }, ...body })
  }

  const disconnect = (): void => {
    disconnected = true
    const socket = ws
    ws = null
    joined.clear()
    inFlight.clear()
    rejectAll('Disconnected')
    if (socket !== null) {
      socket.close()
    }
  }

  const isConnected = (): boolean =>
    ws !== null &&
    ws.readyState === WebSocket.OPEN &&
    joined.size > 0

  const joinedFiles = (): string[] =>
    Array.from(joined.keys())

  const channelFor = (fileKey: string): string | null =>
    joined.get(fileKey) ?? null

  const discover = (): Promise<ChannelInfo[]> =>
    discoverChannels(relayHttpUrl)

  return {
    joinChannel,
    sendCommand,
    forFile,
    notify,
    onRequest,
    disconnect,
    isConnected,
    joinedFiles,
    channelFor,
    discover,
  }
}
