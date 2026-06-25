import { z } from 'zod'

// `connectParamsSchema` is the one schema that lives here: it has its own test
// (connect-params.test.ts), is barrel-exported, and is imported by the live
// server. The M2 read-tool param schemas (get_node/get_nodes/inspect/search/
// list_pages/export) that previously sat alongside it were the green-window
// versions; the live server now imports those from `tool-params.ts` (the
// canonical M2 shapes), so they were retired here in M3-E.
export const connectParamsSchema = z.object({
  channel: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Channel ID to join. Pairs with the Figma plugin. Omit to auto-discover.',
    ),
})
