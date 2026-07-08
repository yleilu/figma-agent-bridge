// packages/shared/src/ws-schemas.ts
import { z } from 'zod'

// `command` is present on a REQUEST (server -> plugin) but omitted on a
// RESPONSE (plugin -> server), which carries only { id, result|error }. The
// relay is a forwarder and must accept both, so `command` is optional. (The
// crash guard from review finding #5 is preserved by `id` + `message` being
// required.)
export const commandMessageSchema = z.object({
  id: z.string(),
  command: z.string().optional(),
  params: z.record(z.unknown()).optional(),
  // Stamped by the server on every REQUEST (server -> plugin) to address the
  // command to exactly one file (principle B3); null when no target is bound.
  // Optional because the same envelope also carries plugin RESPONSES
  // ({ id, result|error }), which have no target.
  targetFileKey: z.string().nullable().optional(),
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
})

export const relayIncomingSchema = z.discriminatedUnion(
  'type',
  [
    joinMessageSchema,
    channelMessageSchema,
    registerMessageSchema,
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
