// packages/shared/src/ws-schemas.ts
import { z } from 'zod'

export const metaSchema = z.object({
  // fileKey the request is addressed to (B3); null when unbound. Absent on replies.
  fileKey: z.string().nullable().optional(),
  // Reserved header — hook-injected session id (request-envelope.md).
  sessionId: z.string().optional(),
  // Reserved headers — hook-injected per-agent identity (request-envelope.md);
  // present only for subagent-originated calls. agentType is a display label.
  agentId: z.string().optional(),
  agentType: z.string().optional(),
  // genId('cmd') per request; correlates a reply to its command (pending map key).
  requestId: z.string().optional(),
  // Plugin connection nonce, carried on the register frame and on every PUSH
  // frame's meta (change-feed.md). Equality-compared only.
  epoch: z.string().optional(),
  // Per-connection monotonic push-frame counter, starting at 0 on the opening
  // flush. A seq beyond lastSeq+1 means the relay's bucket dropped a frame.
  seq: z.number().int().nonnegative().optional(),
})

// `command` is present on a REQUEST/PUSH (server↔plugin) but omitted on a bare
// REPLY, which carries only { meta:{requestId}, result|error }. Every field is
// optional: the relay is a forwarder that validates the outer channel frame,
// and handleMessage null-guards `command`/`meta.requestId` before acting.
export const commandMessageSchema = z.object({
  command: z.string().optional(),
  params: z.record(z.unknown()).optional(),
  meta: metaSchema.optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
})

export const joinMessageSchema = z.object({
  type: z.literal('join'),
  channel: z.string().min(1),
})

export const channelMessageSchema = z.object({
  type: z.literal('message'),
  channel: z.string().min(1),
  message: commandMessageSchema,
})

export const registerMessageSchema = z.object({
  type: z.literal('register'),
  channel: z.string().min(1),
  fileName: z.string().nullable(),
  // Stable per-file identity (principle B3). null when figma.fileKey is
  // unavailable (never-saved file / private API not enabled). Optional so
  // an old/unupdated plugin's register still parses (degrades to null);
  // the version handshake catches skew separately.
  fileKey: z.string().nullable().optional(),
  version: z.string().optional(),
  // Which BUILD produced this plugin bundle (I62). Optional so a plugin that
  // predates the stamp still registers — an absent build is reported as
  // absent, never compared.
  build: z.string().optional(),
  currentPage: z.string().optional(),
  selected: z.number().optional(),
  // Plugin connection nonce, minted per register/reconnect. Stored on the
  // channel registry entry and exposed on GET /channels so a LATE-JOINING
  // server can anchor its baseline without receiving a frame (the relay
  // never replays).
  epoch: z.string().optional(),
})

export const presenceMessageSchema = z.object({
  type: z.literal('presence'),
  channel: z.string().min(1),
  currentPage: z.string().optional(),
  selected: z.number().optional(),
})

export const leaveMessageSchema = z.object({
  type: z.literal('leave'),
  channel: z.string().min(1),
})

export const statusRecordSchema = z.object({
  key: z.string().min(1),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  agentType: z.string().optional(),
  label: z.string().optional(),
  level: z.enum(['normal', 'error']),
  text: z.string().nullable(),
  activity: z.enum(['busy', 'idle']),
  updatedAt: z.number(),
})

export const agentStatusMessageSchema = z.object({
  type: z.literal('agent-status'),
  channel: z.string().min(1),
  record: statusRecordSchema,
})

export const statusSyncMessageSchema = z.object({
  type: z.literal('status-sync'),
  channel: z.string().min(1),
})

export const agentStatusBroadcastSchema = z.object({
  type: z.literal('agent-status'),
  record: statusRecordSchema,
})

export const agentStatusRemoveBroadcastSchema = z.object({
  type: z.literal('agent-status-remove'),
  sessionId: z.string().min(1),
  agentId: z.string().optional(),
  key: z.string().optional(), // row-precise removal (TTL sweep)
})

export const agentStatusSyncBroadcastSchema = z.object({
  type: z.literal('agent-status-sync'),
  records: z.array(statusRecordSchema),
})

export const versionMismatchMessageSchema = z.object({
  type: z.literal('version-mismatch'),
  channel: z.string().min(1),
  plugin: z.string(),
  server: z.string(),
})

export const versionMismatchBroadcastSchema = z.object({
  type: z.literal('version-mismatch'),
  plugin: z.string(),
  server: z.string(),
})

export const relayIncomingSchema = z.discriminatedUnion(
  'type',
  [
    joinMessageSchema,
    channelMessageSchema,
    registerMessageSchema,
    presenceMessageSchema,
    leaveMessageSchema,
    agentStatusMessageSchema,
    statusSyncMessageSchema,
    versionMismatchMessageSchema,
  ],
)

export const broadcastMessageSchema = z.object({
  type: z.literal('broadcast'),
  message: commandMessageSchema,
})

export const systemMessageSchema = z.object({
  type: z.literal('system'),
  message: z.object({ id: z.string(), result: z.string() }),
})

export const relayOutgoingSchema = z.discriminatedUnion(
  'type',
  [
    broadcastMessageSchema,
    systemMessageSchema,
    agentStatusBroadcastSchema,
    agentStatusRemoveBroadcastSchema,
    agentStatusSyncBroadcastSchema,
    versionMismatchBroadcastSchema,
  ],
)
