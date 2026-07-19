import type { Server, ServerWebSocket } from 'bun'
import type {
  BroadcastMessage,
  ChannelInfo,
  ChannelMessage,
  RelayOutgoing,
  StatusRecord,
  SystemMessage,
} from '@figma-agent-bridge/shared'
import {
  DEFAULT_PORT,
  genId,
  relayIncomingSchema,
} from '@figma-agent-bridge/shared'

const MAX_CHANNELS_PER_CONNECTION = 32
const MAX_MEMBERS_PER_CHANNEL = 64
const MAX_TOTAL_CHANNELS = 1024
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024
const RATE_TOKENS_PER_SEC = 50
const RATE_BURST = 100
export const DEFAULT_HEARTBEAT_INTERVAL = 10_000
export const DEFAULT_IDLE_MS = 50_000 // no activity → busy fades to idle
export const DEFAULT_TTL_MS = 300_000 // no activity → row removed (ghost guard)
export const DONE_TEXT = 'Done' // a settled row that never narrated shows this, never a skeleton

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
  /** Per-relay token-bucket sizing (defaults to the module constants). */
  rateBurst: number
  rateTokensPerSec: number
  /** channel → key → record (status-monitor.md) */
  agentStatus: Map<string, Map<string, StatusRecord>>
  /** Per-relay idle-fade / backstop-TTL sizing (defaults to the module constants). */
  idleMs: number
  ttlMs: number
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
  rateBurst: RATE_BURST,
  rateTokensPerSec: RATE_TOKENS_PER_SEC,
  agentStatus: new Map(),
  idleMs: DEFAULT_IDLE_MS,
  ttlMs: DEFAULT_TTL_MS,
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
    ctx.rateBurst,
    state.tokens + elapsed * ctx.rateTokensPerSec,
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
      id: genId('sys'),
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
          ctx.agentStatus.delete(channel)
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
      fileKey: null,
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
      id: genId('sys'),
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
  fileKey: string | null,
  version: string | undefined,
  currentPage?: string,
  selected?: number,
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
    entry.fileKey = fileKey
    entry.version = version
    if (currentPage !== undefined) {
      entry.currentPage = currentPage
    }
    if (selected !== undefined) {
      entry.selected = selected
    }
  }
}

const handlePresence = (
  ctx: RelayContext,
  ws: ServerWebSocket<WsData>,
  channel: string,
  currentPage?: string,
  selected?: number,
) => {
  if (
    ctx.clientChannels.get(ws.data.id)?.has(channel) !==
    true
  ) {
    return
  }
  const entry = ctx.channelRegistry.get(channel)
  if (entry !== undefined) {
    if (currentPage !== undefined) {
      entry.currentPage = currentPage
    }
    if (selected !== undefined) {
      entry.selected = selected
    }
  }
}

const handleLeave = (
  ctx: RelayContext,
  ws: ServerWebSocket<WsData>,
  channel: string,
) => {
  const { id } = ws.data
  const joined = ctx.clientChannels.get(id)
  if (joined?.has(channel) !== true) {
    return
  }

  const members = ctx.channels.get(channel)
  if (members !== undefined) {
    members.delete(ws)
    if (members.size === 0) {
      ctx.channels.delete(channel)
      ctx.channelRegistry.delete(channel)
      ctx.agentStatus.delete(channel)
    }
  }

  joined.delete(channel)
  if (joined.size === 0) {
    ctx.clientChannels.delete(id)
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

  const payload = JSON.stringify(broadcast)
  members.forEach(client => {
    if (client !== ws) {
      client.send(payload)
    }
  })
}

const handleAgentStatus = (
  ctx: RelayContext,
  ws: ServerWebSocket<WsData>,
  channel: string,
  record: StatusRecord,
) => {
  const members = ctx.channels.get(channel)
  if (members === undefined) {
    return
  }
  let byKey = ctx.agentStatus.get(channel)
  if (byKey === undefined) {
    byKey = new Map()
    ctx.agentStatus.set(channel, byKey)
  }
  // merge by key so a later skeleton emit preserves an earlier label/agentType
  const prev = byKey.get(record.key)
  const merged: StatusRecord = {
    ...prev,
    ...record,
  }
  // A skeleton frame (text:null) marks "busy" but must NOT wipe an existing
  // narrative — keep the last line so a busy row shows what it last said (the
  // amber dot carries "busy"). The skeleton therefore only ever shows BEFORE the
  // first narrative (prev has no text yet).
  if (
    record.text === null &&
    prev?.text !== undefined &&
    prev.text !== null
  ) {
    merged.text = prev.text
  }
  byKey.set(record.key, merged)
  const payload = JSON.stringify({
    type: 'agent-status',
    record: merged,
  } satisfies RelayOutgoing)
  members.forEach(client => {
    if (client !== ws) {
      client.send(payload)
    }
  })
}

const handleStatusReplay = (
  ctx: RelayContext,
  ws: ServerWebSocket<WsData>,
  channel: string,
) => {
  const byKey = ctx.agentStatus.get(channel)
  const records = byKey ? Array.from(byKey.values()) : []
  send(ws, { type: 'agent-status-sync', records })
}

const broadcastToChannel = (
  ctx: RelayContext,
  channel: string,
  msg: RelayOutgoing,
) => {
  const members = ctx.channels.get(channel)
  if (members === undefined) {
    return
  }
  const payload = JSON.stringify(msg)
  members.forEach(client => client.send(payload))
}

// Flip a record to idle. A row that reaches green with no narrative ever gets
// the DONE_TEXT default so a green row never shows a skeleton.
const toIdle = (rec: StatusRecord): StatusRecord => ({
  ...rec,
  activity: 'idle',
  text: rec.text ?? DONE_TEXT,
})

const settleSession = (
  ctx: RelayContext,
  sessionId: string,
) => {
  for (const [channel, byKey] of ctx.agentStatus) {
    for (const rec of byKey.values()) {
      if (
        rec.sessionId === sessionId &&
        rec.activity !== 'idle'
      ) {
        const idle = toIdle(rec)
        byKey.set(rec.key, idle)
        broadcastToChannel(ctx, channel, {
          type: 'agent-status',
          record: idle,
        })
      }
    }
  }
}

const removeAgent = (
  ctx: RelayContext,
  sessionId: string,
  agentId?: string,
) => {
  for (const [channel, byKey] of ctx.agentStatus) {
    for (const rec of [...byKey.values()]) {
      const match =
        rec.sessionId === sessionId &&
        (agentId === undefined || rec.agentId === agentId)
      if (match) {
        byKey.delete(rec.key)
        broadcastToChannel(ctx, channel, {
          type: 'agent-status-remove',
          sessionId,
          agentId,
        })
      }
    }
    if (byKey.size === 0) {
      ctx.agentStatus.delete(channel)
    }
  }
}

export type StartRelayOptions = {
  hostname?: string
  heartbeatInterval?: number
  /** Token-bucket initial/max burst (default RATE_BURST). Raise it for the
   * in-process harness self-test, which replays the whole check suite +
   * cleanup back-to-back with no client pacing and would otherwise exhaust the
   * production-sized bucket and see frames silently dropped. */
  rateBurst?: number
  /** Token refill rate per second (default RATE_TOKENS_PER_SEC). */
  rateTokensPerSec?: number
  /** Idle-fade threshold in ms (default DEFAULT_IDLE_MS): a busy row with no
   * activity for this long is broadcast as idle. */
  idleMs?: number
  /** Backstop-TTL in ms (default DEFAULT_TTL_MS): a row with no activity for
   * this long is removed outright (ghost guard). */
  ttlMs?: number
}

export const startRelay = (
  port = DEFAULT_PORT,
  opts: StartRelayOptions = {},
): Server<WsData> => {
  const ctx = createContext()
  ctx.rateBurst = opts.rateBurst ?? RATE_BURST
  ctx.rateTokensPerSec =
    opts.rateTokensPerSec ?? RATE_TOKENS_PER_SEC
  ctx.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
  ctx.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const hostname =
    opts.hostname ?? process.env.RELAY_BIND ?? '127.0.0.1'
  const heartbeatInterval =
    opts.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL

  const server = Bun.serve<WsData>({
    port,
    hostname,
    fetch: async (req, srv) => {
      if (
        req.headers.get('upgrade')?.toLowerCase() ===
        'websocket'
      ) {
        const upgraded = srv.upgrade(req, {
          data: { id: genId('cli') },
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

      if (
        req.method === 'POST' &&
        url.pathname === '/agent-status/settle'
      ) {
        const body = (await req
          .json()
          .catch(() => null)) as {
          sessionId?: string
        } | null
        if (!body?.sessionId) {
          return new Response('bad request', {
            status: 400,
          })
        }
        settleSession(ctx, body.sessionId)
        return new Response('ok')
      }
      if (
        req.method === 'POST' &&
        url.pathname === '/agent-status/remove'
      ) {
        const body = (await req
          .json()
          .catch(() => null)) as {
          sessionId?: string
          agentId?: string
        } | null
        if (!body?.sessionId) {
          return new Response('bad request', {
            status: 400,
          })
        }
        removeAgent(ctx, body.sessionId, body.agentId)
        return new Response('ok')
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
          tokens: ctx.rateBurst,
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
        const frame = parsed.data

        // status-monitor.md review corrections — dispatch()'s busy+skeleton
        // emit doubles the server→relay frame rate (one agent-status frame
        // per identity-bearing command, Task 7). agent-status frames are
        // internal status chatter: dropping one is harmless (a later emit
        // supersedes it, or status-sync replays current state), but dropping
        // a paired COMMAND frame hangs the caller. Exempt agent-status from
        // the token bucket so a command burst never gets silently dropped.
        if (
          frame.type !== 'agent-status' &&
          !consumeToken(ctx, ws)
        ) {
          return
        }

        if (frame.type === 'join') {
          handleJoin(ctx, ws, frame.channel)
        } else if (frame.type === 'register') {
          handleRegister(
            ctx,
            ws,
            frame.channel,
            frame.fileName,
            frame.fileKey ?? null,
            frame.version,
            frame.currentPage,
            frame.selected,
          )
        } else if (frame.type === 'presence') {
          handlePresence(
            ctx,
            ws,
            frame.channel,
            frame.currentPage,
            frame.selected,
          )
        } else if (frame.type === 'leave') {
          handleLeave(ctx, ws, frame.channel)
        } else if (frame.type === 'message') {
          handleMessage(ctx, ws, frame.channel, frame)
        } else if (frame.type === 'agent-status') {
          handleAgentStatus(
            ctx,
            ws,
            frame.channel,
            frame.record,
          )
        } else if (frame.type === 'status-sync') {
          handleStatusReplay(ctx, ws, frame.channel)
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
    const dead: ServerWebSocket<WsData>[] = []
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

    // agent-status idle-fade + backstop-TTL sweep (status-monitor.md)
    const now = Date.now()
    for (const [channel, byKey] of ctx.agentStatus) {
      for (const rec of [...byKey.values()]) {
        const age = now - rec.updatedAt
        if (age >= ctx.ttlMs) {
          byKey.delete(rec.key)
          // KEY-scoped remove: prune exactly this one row. A bare {sessionId}
          // would make the plugin drop the whole session (incl. still-live
          // subagents) — see I2.
          broadcastToChannel(ctx, channel, {
            type: 'agent-status-remove',
            sessionId: rec.sessionId ?? '',
            agentId: rec.agentId,
            key: rec.key,
          })
        } else if (
          age >= ctx.idleMs &&
          rec.activity === 'busy'
        ) {
          const idle = toIdle(rec)
          byKey.set(rec.key, idle)
          broadcastToChannel(ctx, channel, {
            type: 'agent-status',
            record: idle,
          })
        }
      }
      if (byKey.size === 0) {
        ctx.agentStatus.delete(channel)
      }
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
    ctx.agentStatus.clear()
    contexts.delete(server)
  }
  server.stop(true)
}
