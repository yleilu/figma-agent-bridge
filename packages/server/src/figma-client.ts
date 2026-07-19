import {
  COMMANDS,
  genId,
  relayOutgoingSchema,
} from '@figma-agent-bridge/shared'
import type {
  ChannelInfo,
  ChannelMessage,
  CommandMessage,
  JoinMessage,
  Meta,
  RelayIncoming,
  StatusRecord,
} from '@figma-agent-bridge/shared'

/** A file-scoped view of the client: sendCommand needs no fileKey (captured). */
export type ScopedFigmaClient = {
  fileKey: string
  sendCommand: (
    command: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>
  notifyStatus: (record: StatusRecord) => void
  identity?: {
    sessionId?: string
    agentId?: string
    agentType?: string
  }
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
    opts?: {
      sessionId?: string
      agentId?: string
      agentType?: string
    },
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
  // connection-liveness.md: true while `fileKey`'s /channels entry's connectedAt
  // still matches the watchdog's declared-dead value; self-clears (returns false
  // thereafter) on a reconnect (fresher connectedAt) or once the entry is gone.
  isInstanceDead: (
    fileKey: string,
    liveConnectedAt: number | undefined,
  ) => boolean
}

// The watchdog (L6) throws this when an instance stops responding to liveness
// pings; withFile maps it to errorEnvelope('DISCONNECTED', …) (instanceof check,
// hence a VALUE export, not `export type`).
export class PluginDisconnectedError extends Error {
  constructor(public readonly fileKey: string) {
    super(`Plugin for ${fileKey} is not responding`)
    this.name = 'PluginDisconnectedError'
  }
}

type Pending<T> = {
  resolve: (value: T) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
  // connection-liveness.md — the command-liveness watchdog stashes its teardown
  // here so any OTHER settlement (real reply / real timeout) stops the loop and
  // clears its grace timer. OPTIONAL: joinPending/rejectAll never set it.
  teardown?: () => void
}

const JOIN_TIMEOUT_MS = 3e4

// connection-liveness.md — command-liveness watchdog tuning. Production defaults
// are ~2s per the spec (best-effort detection, false-kill margin); overridable
// via the 3rd createFigmaClient arg so tests can drive the loop in ~hundreds of
// ms with real timers instead of the full ~2s cadence.
const WATCHDOG_GRACE_MS = 2_000
const WATCHDOG_PING_MS = 2_000
const WATCHDOG_MAX_MISSES = 2

// Normalize a relay WebSocket URL to its HTTP origin (for the /channels REST
// registry). The single source of this ws→http conversion — shared by discover,
// the MCP server bootstrap, and the live-verify script.
export const toHttpUrl = (relayUrl: string): string =>
  relayUrl
    .replace('wss://', 'https://')
    .replace('ws://', 'http://')

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
  watchdog?: {
    graceMs?: number
    pingMs?: number
    maxMisses?: number
  },
): FigmaClient => {
  const graceMs = watchdog?.graceMs ?? WATCHDOG_GRACE_MS
  const pingMs = watchdog?.pingMs ?? WATCHDOG_PING_MS
  const maxMisses =
    watchdog?.maxMisses ?? WATCHDOG_MAX_MISSES
  let ws: WebSocket | null = null
  let disconnected = false
  // Joined files: fileKey → channel. One socket, many channels (B3 multi-file).
  const joined = new Map<string, string>()
  // Watchdog-declared-dead instances: fileKey → the dead instance's connectedAt
  // (connection-liveness.md). Set by the watchdog (L6) directly via this closure.
  const deadInstances = new Map<string, number>()
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

  const relayHttpUrl = toHttpUrl(relayUrl)

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

    // The server is a channel member, so the relay's settle/remove/idle-sweep
    // agent-status broadcasts (status-monitor.md) reach it too — it only ever
    // EMITS agent-status frames, never consumes them. Ignore anything that
    // isn't the plain command/reply broadcast shape (status-monitor.md).
    if (parsed.type !== 'broadcast') {
      return
    }

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
      // connection-liveness.md — a real reply settles the command; tear the
      // watchdog loop down so it stops probing (no-op if never armed).
      req.teardown?.()
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

  // A channel-scoped send for frames that are NOT ChannelMessage commands
  // (e.g. the server → relay agent-status push, status-monitor.md). Unlike
  // sendFrame (which fans a CommandMessage out to every joined channel),
  // this targets exactly one channel — the caller already knows which.
  const sendToChannel = (
    channel: string,
    frame: RelayIncoming,
  ): void => {
    const socket = ws
    if (
      socket === null ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return
    }
    socket.send(JSON.stringify(frame))
  }

  const channelFor = (fileKey: string): string | null =>
    joined.get(fileKey) ?? null

  // The one request sender. Stamps meta { fileKey, requestId[, sessionId] } and
  // routes on the file's joined channel; the pending map is keyed by requestId.
  const dispatch = (
    fileKey: string,
    command: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
    identity?: {
      sessionId?: string
      agentId?: string
      agentType?: string
    },
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
        // connection-liveness.md — the command's OWN timeout fired; tear the
        // watchdog down (keyed by requestId; no `req` binding here) before we
        // drop the entry.
        pending.get(requestId)?.teardown?.()
        pending.delete(requestId)
        reject(new Error(`Command ${requestId} timed out`))
      }, timeoutMs)

      pending.set(requestId, { resolve, reject, timer })

      const meta: Meta = { fileKey, requestId }
      if (identity?.sessionId !== undefined) {
        meta.sessionId = identity.sessionId
      }
      if (identity?.agentId !== undefined) {
        meta.agentId = identity.agentId
      }
      if (identity?.agentType !== undefined) {
        meta.agentType = identity.agentType
      }

      // status-monitor.md — emit a busy+skeleton agent-status frame ahead of
      // every identity-bearing command. Guarding on identity presence (rather
      // than a per-command name list) automatically excludes PING, status(),
      // and connect() — they reach dispatch with no sessionId/agentId.
      // report_status never calls dispatch (it's display-only via
      // notifyStatus), so it needs no separate exclusion.
      const skeletonKey =
        identity?.agentId ?? identity?.sessionId
      if (
        command !== COMMANDS.PING &&
        skeletonKey !== undefined
      ) {
        const skeleton: StatusRecord = {
          key: skeletonKey,
          sessionId: identity?.sessionId,
          agentId: identity?.agentId,
          agentType: identity?.agentType,
          level: 'normal',
          text: null,
          activity: 'busy',
          updatedAt: Date.now(),
        }
        sendToChannel(ch, {
          type: 'agent-status',
          channel: ch,
          record: skeleton,
        })
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

      // connection-liveness.md — command-liveness watchdog. When a dispatched
      // command runs slow (no reply within the grace window), probe liveness
      // with a CONCURRENT ping (short timeout) rather than shortening the real
      // command's timeout. Consecutive missed pongs → declare the plugin dead:
      // reject the pending real command with PluginDisconnectedError, set the
      // dead-channel marker, and drop the file from `joined`. Never arm for the
      // ping command itself (no recursion).
      if (command !== COMMANDS.PING) {
        let live = true
        const graceTimer = setTimeout(() => {
          void (async () => {
            let misses = 0
            while (live && pending.has(requestId)) {
              try {
                // Resolves on pong, rejects on the ping's own short timeout.
                await dispatch(
                  fileKey,
                  COMMANDS.PING,
                  {},
                  pingMs,
                )
                misses = 0
              } catch {
                if (!live || !pending.has(requestId)) {
                  break
                }
                if (++misses >= maxMisses) {
                  // Ownership FIRST — the real reply may have landed during the
                  // pings; declare dead ONLY if we still own the pending, else
                  // we'd mark a LIVE instance dead.
                  const at = (
                    await discoverChannels(relayHttpUrl)
                  ).find(
                    c =>
                      (c.fileKey ?? c.channel) === fileKey,
                  )?.connectedAt
                  const p = pending.get(requestId)
                  if (p === undefined) {
                    // Settled during the await → no-op, no mark.
                    return
                  }
                  if (at !== undefined) {
                    deadInstances.set(fileKey, at)
                  }
                  // Drop from joined → requireFile fast-fails the next call.
                  joined.delete(fileKey)
                  clearTimeout(p.timer)
                  pending.delete(requestId)
                  p.teardown?.()
                  p.reject(
                    new PluginDisconnectedError(fileKey),
                  )
                  return
                }
              }

              await new Promise(r => {
                setTimeout(r, pingMs)
              })
            }
          })()
        }, graceMs)
        // Wire teardown so any OTHER settlement (reply / real timeout / death)
        // stops the loop and clears the grace timer — settle-once.
        const pend = pending.get(requestId)
        if (pend !== undefined) {
          pend.teardown = () => {
            live = false
            clearTimeout(graceTimer)
          }
        }
      }
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
    opts?: {
      sessionId?: string
      agentId?: string
      agentType?: string
    },
  ): ScopedFigmaClient => ({
    fileKey,
    sendCommand: (command, params, timeoutMs = 3e4) =>
      dispatch(fileKey, command, params, timeoutMs, opts),
    notifyStatus: record => {
      const ch = channelFor(fileKey)
      if (ch !== null) {
        sendToChannel(ch, {
          type: 'agent-status',
          channel: ch,
          record,
        })
      }
    },
    identity: opts,
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
    // request-envelope.md — pushes are unsolicited and carry NO requestId. A push
    // is broadcast to every channel member and correlates to no pending command;
    // the plugin acts on it by `command`, not by id.
    sendFrame({ command, params })
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

  const discover = (): Promise<ChannelInfo[]> =>
    discoverChannels(relayHttpUrl)

  const isInstanceDead = (
    fileKey: string,
    liveConnectedAt: number | undefined,
  ): boolean => {
    const dead = deadInstances.get(fileKey)
    if (dead === undefined) {
      return false
    }
    if (liveConnectedAt === dead) {
      return true
    }
    deadInstances.delete(fileKey) // reconnect (fresh connectedAt) or gone → self-clear
    return false
  }

  const client = {
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
    isInstanceDead,
    // TEST-ONLY seam: the L6 watchdog now sets `deadInstances` directly via
    // this closure on a real death (covered end-to-end by the watchdog tests).
    // This seam is retained for the focused `isInstanceDead` unit tests, which
    // must seed an EXACT connectedAt to exercise the marker's match / self-clear
    // logic — a value the relay mints and a live death can't deterministically
    // control. NOT part of the public FigmaClient type/contract — production
    // code must never call it.
    __markDeadForTest: (
      fileKey: string,
      connectedAt: number,
    ): void => {
      deadInstances.set(fileKey, connectedAt)
    },
  }

  return client
}
