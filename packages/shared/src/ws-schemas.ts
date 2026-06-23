// packages/shared/src/ws-schemas.ts
import { z } from 'zod'

export const commandMessageSchema = z.object({
  id: z.string(),
  command: z.string(),
  params: z.record(z.unknown()).optional(),
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
})

export const relayIncomingSchema = z.discriminatedUnion('type', [
  joinMessageSchema,
  channelMessageSchema,
  registerMessageSchema,
])

export const broadcastMessageSchema = z.object({
  type: z.literal('broadcast'),
  message: commandMessageSchema,
})

export const systemMessageSchema = z.object({
  type: z.literal('system'),
  message: z.object({ id: z.string(), result: z.string() }),
})

export const relayOutgoingSchema = z.discriminatedUnion('type', [
  broadcastMessageSchema,
  systemMessageSchema,
])
