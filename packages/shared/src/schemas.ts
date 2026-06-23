import { z } from 'zod'

export const connectParamsSchema = z.object({
  channel: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Channel ID to join. Pairs with the Figma plugin. Omit to auto-discover.',
    ),
})

export const statusParamsSchema = z.object({}).optional()

// --- M2 tool schemas ---

export const inspectParamsSchema = z.object({
  nodeId: z
    .string()
    .optional()
    .describe(
      'Node ID to inspect. If omitted, inspects current selection.',
    ),
})

export const inspectPageLayoutParamsSchema = z.object({})

export const inspectStylesParamsSchema = z.object({
  type: z
    .enum(['paint', 'text', 'effect', 'grid'])
    .optional()
    .describe(
      'Filter styles by type. If omitted, returns all styles.',
    ),
})

export const inspectComponentsParamsSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      'Filter components by name (case-insensitive substring match).',
    ),
})

export const searchParamsSchema = z.object({
  name: z
    .string()
    .optional()
    .describe(
      'Name pattern to search for. Supports * wildcards.',
    ),
  type: z
    .string()
    .optional()
    .describe(
      'Filter by node type (e.g. FRAME, TEXT, INSTANCE).',
    ),
  pageId: z
    .string()
    .optional()
    .describe('Restrict search to a specific page by ID.'),
  limit: z
    .number()
    .optional()
    .default(50)
    .describe('Max results to return (default 50).'),
})

export const getNodeParamsSchema = z.object({
  nodeId: z.string().describe('The node ID to retrieve.'),
  depth: z
    .number()
    .optional()
    .describe(
      'Depth of children to include. 0 = stubs only, 3 = default, -1 = unlimited.',
    ),
})

export const getNodesParamsSchema = z.object({
  nodeIds: z
    .array(z.string())
    .describe('Array of node IDs to retrieve.'),
  depth: z
    .number()
    .optional()
    .describe(
      'Depth of children to include. 0 = stubs only, 3 = default, -1 = unlimited.',
    ),
})

export const listPagesParamsSchema = z.object({})

export const exportParamsSchema = z.object({
  nodeId: z.string().describe('The node ID to export.'),
  format: z
    .enum(['PNG', 'SVG', 'PDF', 'JPG'])
    .optional()
    .describe('Export format. Defaults to PNG.'),
  scale: z
    .number()
    .optional()
    .describe(
      'Scale factor for raster exports. Defaults to 1.',
    ),
})
