import { z } from 'zod'

// `createFromSvgParamsSchema` is the one schema that lives here: it is
// barrel-exported and imported by the live server (create_from_svg tool).
// The former create_node / create_tree / create_component param schemas (and
// their nested node/tree/component-property specs) were the green-window
// versions; the live server now imports the canonical NodeSpec-based shapes
// from `tool-params.ts`, so those were retired here in M3-E.
export const createFromSvgParamsSchema = z.object({
  // fileKey + sessionId + agentId/agentType MIRROR fileTargetParamsSchema
  // (tool-params.ts); inlined here rather than spread because this module is
  // barrel-exported and importing tool-params.ts would reintroduce a
  // barrel-export cycle. Keep the describe() strings in sync with the mixin's.
  fileKey: z
    .string()
    .min(1)
    .describe(
      'Stable Figma fileKey of the file this call operates on (from status/connect available[]). Required — the server never guesses which file (B3).',
    ),
  sessionId: z
    .string()
    .optional()
    .describe(
      'Reserved — server-managed. Do NOT set. Injected by the session PreToolUse hook (request-envelope.md); ignored by this surface today.',
    ),
  agentId: z
    .string()
    .optional()
    .describe(
      'Reserved — server-managed. Do NOT set. Injected by the identity PreToolUse hook for subagent calls (request-envelope.md); ignored by this surface today.',
    ),
  agentType: z
    .string()
    .optional()
    .describe(
      'Reserved — server-managed. Do NOT set. Injected by the identity PreToolUse hook for subagent calls (request-envelope.md); ignored by this surface today.',
    ),
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
