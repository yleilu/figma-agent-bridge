// packages/shared/src/ws-schemas.ts
import { z } from 'zod'

export const metaSchema = z.object({
  // fileKey the request is addressed to (B3); null when unbound. Absent on replies.
  fileKey: z.string().nullable().optional(),
  // Reserved header — hook-injected session id (request-envelope.md); not used yet.
  sessionId: z.string().optional(),
  // genId('cmd') per request; correlates a reply to its command (pending map key).
  requestId: z.string().optional(),
  // Plugin connection nonce for change-feed pushes (forward-compat; not used here).
  epoch: z.string().optional(),
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
  currentPage: z.string().optional(),
  selected: z.number().optional(),
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

export const relayIncomingSchema = z.discriminatedUnion(
  'type',
  [
    joinMessageSchema,
    channelMessageSchema,
    registerMessageSchema,
    presenceMessageSchema,
    leaveMessageSchema,
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
  [broadcastMessageSchema, systemMessageSchema],
)
