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
  /** channel → id of the socket whose `register` created the entry
   *  (overview.md: availability is bound to the registering plugin's socket). */
  registrar: Map<string, string>
  sockets: Set<ServerWebSocket<WsData>>
  alive: WeakMap<ServerWebSocket<WsData>, boolean>
  rate: WeakMap<ServerWebSocket<WsData>, RateState>
  heartbeatTimer: ReturnType<typeof setInterval> | null
  /** Per-relay token-bucket sizing (defaults to the module constants). */
  rateBurst: number
  rateTokensPerSec: number
  /** Time source for the token bucket only (defaults to Date.now). */
  rateNow: () => number
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
  registrar: new Map(),
  sockets: new Set(),
  alive: new WeakMap(),
  rate: new WeakMap(),
  heartbeatTimer: null,
  rateBurst: RATE_BURST,
  rateTokensPerSec: RATE_TOKENS_PER_SEC,
  rateNow: Date.now,
  agentStatus: new Map(),
  idleMs: DEFAULT_IDLE_MS,
  ttlMs: DEFAULT_TTL_MS,
})

const send = (
  ws: ServerWebSocket<WsData>,
  msg: RelayOutgoing,
) => {
  try {
    ws.send(JSON.stringify(msg))
  } catch (err) {
    // A peer that went away mid-send is ordinary; what is not ordinary is
    // pretending the frame landed. Nothing here can reach the waiter — this
    // IS the delivery path — so the console is the only honest record.
    console.error(
      `[relay] send failed (${msg.type}):`,
      String(err),
    )
  }
}

/**
 * Tell whoever is waiting that a frame died here.
 *
 * A dropped frame is the worst failure this process can produce: the caller
 * learns nothing and waits out a timeout whose message points at Figma rather
 * than at the hop that lost it. That misdirection cost a whole investigation
 * once, so every drop path in this file ends here instead of at a bare
 * `return`.
 *
 * The notice rides the ORDINARY reply shape — `{ meta: { requestId }, error }`
 * — which the server already turns into a rejected command (see
 * figma-client's handleMessage). No new frame type, so no version skew: an
 * older peer sees a normal error reply, which is exactly what this is.
 */
const reportDrop = (
  ctx: RelayContext,
  ws: ServerWebSocket<WsData>,
  reason: string,
  requestId?: string,
  channel?: string,
) => {
  console.error(`[relay] dropped a frame: ${reason}`)
  if (requestId === undefined) {
    // Nothing to correlate against — the frame was too broken to name its
    // own request. The caller's timeout is all that is left.
    return
  }
  const notice: BroadcastMessage = {
    type: 'broadcast',
    message: {
      meta: { requestId },
      error: `relay dropped a ${reason} — the command did not reach its peer and can be retried`,
    },
  }
  // Prefer the channel (the waiter may be any member), fall back to the
  // sender so a channel-less drop still reaches someone.
  const members =
    channel !== undefined
      ? ctx.channels.get(channel)
      : undefined
  if (members === undefined || members.size === 0) {
    send(ws, notice)
    return
  }
  members.forEach(client => {
    send(client, notice)
  })
}

/** Best-effort requestId from a frame too malformed to trust. */
const requestIdOf = (json: unknown): string | undefined => {
  const rid = (
    json as
      | { message?: { meta?: { requestId?: unknown } } }
      | undefined
  )?.message?.meta?.requestId
  return typeof rid === 'string' ? rid : undefined
}

/** Best-effort channel from the same. */
const channelOf = (json: unknown): string | undefined => {
  const ch = (json as { channel?: unknown } | undefined)
    ?.channel
  return typeof ch === 'string' ? ch : undefined
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
  const now = ctx.rateNow()
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

/**
 * Availability is bound to the REGISTERING socket (overview.md), never to the
 * channel's member count: a plugin close drops the file even while the MCP
 * server still holds the channel open, and a channel with members but no
 * registered plugin has no entry at all. Both departure paths (`close` and an
 * explicit `leave`) ask the same question — is this socket the registrar?
 */
const dropRegistration = (
  ctx: RelayContext,
  channel: string,
  socketId: string,
) => {
  if (ctx.registrar.get(channel) === socketId) {
    ctx.registrar.delete(channel)
    ctx.channelRegistry.delete(channel)
  }
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
          ctx.agentStatus.delete(channel)
        }
      }
      dropRegistration(ctx, channel, id)
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

  // Joining creates NO availability entry: the registry answers *which files
  // have a live plugin*, not *which channels exist* (overview.md). Only
  // `register` mints one.

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
  build: string | undefined,
  currentPage?: string,
  selected?: number,
  epoch?: string,
) => {
  if (
    ctx.clientChannels.get(ws.data.id)?.has(channel) !==
    true
  ) {
    return
  }
  // Create-or-rebind. Every binding mints a fresh connectedAt: that value
  // identifies one plugin CONNECTION, not one channel (overview.md), which is
  // what makes connection-liveness.md's dead marker self-clear on reconnect.
  const prev = ctx.channelRegistry.get(channel)
  const entry: ChannelInfo = {
    channel,
    fileName,
    fileKey,
    connectedAt: Date.now(),
    version,
    // I62 — carried, never defaulted from `prev`: a re-register is a NEW
    // plugin connection, and inheriting the last one's build would report a
    // freshly installed bundle under the id of the one it replaced.
    build,
    currentPage: currentPage ?? prev?.currentPage,
    selected: selected ?? prev?.selected,
    epoch: epoch ?? prev?.epoch,
  }
  ctx.channelRegistry.set(channel, entry)
  ctx.registrar.set(channel, ws.data.id)
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
      ctx.agentStatus.delete(channel)
    }
  }
  dropRegistration(ctx, channel, id)

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
    // The channel was reaped, or both peers left while this frame was in
    // flight. The work may already have happened, so saying nothing would
    // leave the waiter to time out against a document that did change.
    reportDrop(
      ctx,
      ws,
      `frame for an unknown channel (${channel})`,
      message.message.meta?.requestId,
    )
    return
  }

  const broadcast: BroadcastMessage = {
    type: 'broadcast',
    message: message.message,
  }

  let delivered = 0
  members.forEach(client => {
    if (client !== ws) {
      send(client, broadcast)
      delivered += 1
    }
  })
  if (
    delivered === 0 &&
    message.message.meta?.requestId !== undefined
  ) {
    // Joined, but alone: the peer has gone. Recorded, NOT turned into an
    // error reply — "the other side is gone" already belongs to the
    // connection-liveness watchdog, which answers DISCONNECTED, a truer code
    // than a dropped-frame notice. Synthesizing one here would race it and
    // sometimes win with the worse answer.
    console.error(
      `[relay] no peer on ${channel} for request ${message.message.meta.requestId} — liveness will resolve it`,
    )
  }
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
  // first narrative (prev has no text yet). Same for `level`: a skeleton frame
  // (any non-report_status tool call) always carries level:'normal' — without
  // this, the next tool call after an error silently resets an errored row's
  // dot back to green while the error narrative is still on screen.
  if (
    record.text === null &&
    prev?.text !== undefined &&
    prev.text !== null
  ) {
    merged.text = prev.text
    merged.level = prev.level
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

// version-handshake.md — route-only (B1): the relay forwards a server-detected
// skew to the channel's members and stores NOTHING (unlike agent-status, this
// is never a roster row and is never TTL-swept). The server owns the compare.
const handleVersionMismatch = (
  ctx: RelayContext,
  ws: ServerWebSocket<WsData>,
  channel: string,
  plugin: string,
  server: string,
) => {
  const members = ctx.channels.get(channel)
  if (members === undefined) {
    return
  }
  const payload = JSON.stringify({
    type: 'version-mismatch',
    plugin,
    server,
  } satisfies RelayOutgoing)
  members.forEach(client => {
    if (client !== ws) {
      client.send(payload)
    }
  })
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
  /** Time source for the token bucket only, in ms (default Date.now).
   * Injectable so a test can freeze/advance bucket time explicitly instead of
   * racing the wall clock: with a frozen clock a drained bucket stays drained
   * no matter how long the real round-trips take. Does not affect heartbeats,
   * connectedAt, or the status idle/TTL sweep. */
  rateNow?: () => number
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
  ctx.rateNow = opts.rateNow ?? Date.now
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
          last: ctx.rateNow(),
        })
      },
      message: (ws, raw) => {
        let json: unknown
        try {
          json = JSON.parse(raw as string)
        } catch (err) {
          // Unparseable, so it cannot name its own request — a log is all
          // that is available. Recorded rather than swallowed so a peer
          // emitting bad frames is visible instead of merely slow.
          console.error(
            '[relay] dropped an unparseable frame:',
            String(err),
          )
          return
        }

        const parsed = relayIncomingSchema.safeParse(json)
        if (!parsed.success) {
          // Well-formed JSON the schema refuses — a version skew or a bug.
          // The frame can still name its request, so the waiter gets a real
          // error instead of a timeout that reads as Figma being slow.
          reportDrop(
            ctx,
            ws,
            'frame the relay could not validate',
            requestIdOf(json),
            channelOf(json),
          )
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
          // The comment above says a dropped COMMAND frame hangs the caller,
          // and exempting agent-status only narrowed that — it did not close
          // it. Now the drop announces itself, so a rate-limited caller gets
          // a retryable error rather than a mystery timeout.
          reportDrop(
            ctx,
            ws,
            'frame over the rate limit',
            frame.type === 'message'
              ? frame.message.meta?.requestId
              : undefined,
            'channel' in frame ? frame.channel : undefined,
          )
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
            frame.build,
            frame.currentPage,
            frame.selected,
            frame.epoch,
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
        } else if (frame.type === 'version-mismatch') {
          handleVersionMismatch(
            ctx,
            ws,
            frame.channel,
            frame.plugin,
            frame.server,
          )
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
    ctx.registrar.clear()
    ctx.sockets.clear()
    ctx.agentStatus.clear()
    contexts.delete(server)
  }
  server.stop(true)
}
