// errors.ts — the server-owned typed error contract (overview.md, "Error
// envelope"). ONE place turns a failure into an ErrorCode: a ToolError already
// carries its own; everything else is classified from the message the plugin or
// the transport produced.
//
// A LEAF by design — it imports only PluginDisconnectedError — so serialize/
// and tools/ can both use it with no import cycle.

import { PluginDisconnectedError } from './figma-client'

export type ErrorCode =
  | 'NODE_NOT_FOUND'
  | 'INVALID_PARAM'
  | 'FONT_LOAD_FAILED'
  | 'DISCONNECTED'
  | 'TIMEOUT'
  | 'UNSUPPORTED_NODE_TYPE'
  | 'API_UNAVAILABLE'
  | 'WRONG_EDITOR'
  | 'LIBRARY_UNPUBLISHED'
  | 'WRONG_FILE'
  | 'INCOMPATIBLE'
  | 'PLUGIN_ERROR'

/** A failure that already knows its own code — classification skips matching. */
export class ToolError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

// Ordered — FIRST match wins, so a specific rule must precede a general one.
// Every pattern here is a string this repo or the Figma runtime actually
// produces; strings were observed live, not guessed.
const RULES: [RegExp, ErrorCode][] = [
  // Transport, before anything else.
  [/\bnot connected\b/i, 'DISCONNECTED'],
  [/\bnot joined to file\b/i, 'DISCONNECTED'],
  [/\btimed out\b/i, 'TIMEOUT'],
  // Editor gate BEFORE the generic unavailable, or it would be swallowed.
  [/\bin this editor\b/i, 'WRONG_EDITOR'],
  [/\bwrong editor\b/i, 'WRONG_EDITOR'],
  // Feature-detect misses.
  [/\bis unavailable\b/i, 'API_UNAVAILABLE'],
  [/\bapi unavailable\b/i, 'API_UNAVAILABLE'],
  // Library import — code.ts:3002.
  [
    /importComponentByKeyAsync failed/i,
    'LIBRARY_UNPUBLISHED',
  ],
  [/\bnot published\b/i, 'LIBRARY_UNPUBLISHED'],
  // Fonts — the message is Figma's own, observed live.
  [/could not be loaded/i, 'FONT_LOAD_FAILED'],
  [/\bunloaded font\b/i, 'FONT_LOAD_FAILED'],
  // Not-found family.
  [/\bnot found\b/i, 'NODE_NOT_FOUND'],
  // Type mismatches.
  [/\bis not an? [a-z_]+:/i, 'UNSUPPORTED_NODE_TYPE'],
  [/\bunsupported node type\b/i, 'UNSUPPORTED_NODE_TYPE'],
  // Explicit argument guards, server- or plugin-side.
  [/\brequires\b/i, 'INVALID_PARAM'],
  [/\bmust be\b/i, 'INVALID_PARAM'],
  [/\bneed at least\b/i, 'INVALID_PARAM'],
  [/\bexceeds\b/i, 'INVALID_PARAM'],
]

/**
 * Message → code. Falls back to PLUGIN_ERROR — the honest "Figma failed and the
 * server cannot say more" — never to INVALID_PARAM, which would blame the
 * agent's parameters for a fault that was not theirs.
 */
export const classifyMessage = (
  message: string,
): ErrorCode => {
  for (const [re, code] of RULES) {
    if (re.test(message)) {
      return code
    }
  }
  return 'PLUGIN_ERROR'
}

export const classify = (err: unknown): ErrorCode => {
  if (err instanceof ToolError) {
    return err.code
  }
  if (err instanceof PluginDisconnectedError) {
    return 'DISCONNECTED'
  }
  return classifyMessage(errorMessage(err))
}
