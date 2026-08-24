// identity-headers.ts — the three RESERVED, server-managed request headers
// (request-envelope.md), in one place.
//
// The PreToolUse identity hook (plugin/hooks/identity) stamps `sessionId` on
// EVERY figma-bridge tool call, and `agentId`/`agentType` on every subagent
// call. It does not know which tools are file-addressed, so the connection-
// addressed tools (`connect`, `status`, the six feedback/auth tools) receive
// them too. Zod used to strip them there and nobody noticed.
//
// M22b removed that silence: a tool schema now REJECTS a key it does not
// declare. So every tool has to DECLARE the headers it is stamped with, or the
// hook would break the call it was meant to annotate. This mixin is that
// declaration, spread by `fileTargetParamsSchema` (tool-params.ts), by
// `connectParamsSchema` (schemas.ts) and by `createFromSvgParamsSchema`
// (create-schemas.ts) alike — one definition, one set of descriptions.
//
// It imports zod and nothing else, so the two barrel-exported schema modules
// can reach it without a barrel cycle.

import { z } from 'zod'

/** The reserved identity headers every tool call may carry (request-envelope.md). */
export const identityHeadersSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe(
      'Reserved — server-managed. Do NOT set. Injected by the identity PreToolUse hook (request-envelope.md); the server remembers it once and keys the change-feed count file on it (change-feed.md).',
    ),
  agentId: z
    .string()
    .optional()
    .describe(
      'Reserved — server-managed. Do NOT set. Injected by the identity PreToolUse hook for subagent calls (request-envelope.md); the server forwards it as the key of the agent status row for this call (status-monitor.md).',
    ),
  agentType: z
    .string()
    .optional()
    .describe(
      'Reserved — server-managed. Do NOT set. Injected by the identity PreToolUse hook for subagent calls (request-envelope.md); the server forwards it as the display label on that agent status row (status-monitor.md).',
    ),
})
