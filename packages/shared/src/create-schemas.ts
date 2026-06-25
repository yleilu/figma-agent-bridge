import { z } from 'zod'

// `createFromSvgParamsSchema` is the one schema that lives here: it is
// barrel-exported and imported by the live server (create_from_svg tool).
// The former create_node / create_tree / create_component param schemas (and
// their nested node/tree/component-property specs) were the green-window
// versions; the live server now imports the canonical NodeSpec-based shapes
// from `tool-params.ts`, so those were retired here in M3-E.
export const createFromSvgParamsSchema = z.object({
  parentId: z
    .string()
    .describe(
      'Parent node ID where the SVG frame will be appended.',
    ),
  svg: z
    .string()
    .describe(
      'SVG string to import. Must be valid SVG markup.',
    ),
  name: z
    .string()
    .optional()
    .describe(
      'Name for the created frame. Defaults to "SVG".',
    ),
  size: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe(
      'Optional [width, height] to resize the SVG frame after creation.',
    ),
})
