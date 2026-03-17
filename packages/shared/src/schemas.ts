import { z } from 'zod'

export const connectParamsSchema = z.object({
  channel: z
    .string()
    .min(1)
    .describe(
      'Channel ID to join. Pairs with the Figma plugin.',
    ),
})

export const statusParamsSchema = z.object({}).optional()
