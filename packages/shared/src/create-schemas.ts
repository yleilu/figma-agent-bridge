import { z } from 'zod'
import { identityHeadersSchema } from './identity-headers'
import { strictParams } from './strict-params'

// `createFromSvgParamsSchema` is the one schema that lives here: it is
// barrel-exported and imported by the live server (create_from_svg tool).
// The former create_node / create_tree / create_component param schemas (and
// their nested node/tree/component-property specs) were the green-window
// versions; the live server now imports the canonical NodeSpec-based shapes
// from `tool-params.ts`, so those were retired here in M3-E.
//
// STRICT (M22b): an undeclared top-level key is rejected, not stripped.
export const createFromSvgParamsSchema = strictParams({
  // fileKey MIRRORS fileTargetParamsSchema (tool-params.ts); it is inlined here
  // rather than spread because this module is barrel-exported and importing
  // tool-params.ts would reintroduce a barrel-export cycle. The three reserved
  // identity headers no longer need mirroring — identity-headers.ts holds the
  // one definition both modules spread.
  fileKey: z
    .string()
    .min(1)
    .describe(
      'Stable Figma fileKey of the file this call operates on (from status/connect available[]). Required — the server never guesses which file (B3).',
    ),
  ...identityHeadersSchema.shape,
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
