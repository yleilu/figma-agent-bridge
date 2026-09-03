import { z } from 'zod'
import { identityHeadersSchema } from './identity-headers'
import { strictParams } from './strict-params'

// `connectParamsSchema` is the one schema that lives here: it has its own test
// (connect-params.test.ts), is barrel-exported, and is imported by the live
// server. The M2 read-tool param schemas (get_node/get_nodes/inspect/search/
// list_pages/export) that previously sat alongside it were the green-window
// versions; the live server now imports those from `tool-params.ts` (the
// canonical M2 shapes), so they were retired here in M3-E.
//
// STRICT (M22b): an undeclared top-level key is rejected, not stripped. That is
// why the reserved identity headers are spread in — the PreToolUse hook stamps
// `sessionId` on `connect` too, and a strict schema that did not declare it
// would reject every hooked call.
export const connectParamsSchema = strictParams({
  ...identityHeadersSchema.shape,
  fileKey: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Stable Figma fileKey of the file to target (from status/connect available[]). The precise way to address exactly one file (B3).',
    ),
  fileName: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Figma file NAME to target when the fileKey is unknown. Rejected as ambiguous if two open files share a name — pass fileKey instead.',
    ),
  channel: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Explicit relay channel to join (escape hatch). Omit and pass fileKey/fileName to target by file. Omit all three and the server lists the connected files and asks you to choose one by fileKey — it never auto-joins, even if only one file is open (B3).',
    ),
})
