// strict-params.ts — the ONE way a tool params schema is built (M22b).
//
// A plain `z.object` STRIPS an unknown key before the handler ever sees it, so
// a param the caller invented answers `ok` with an unchanged document and an
// empty `warnings[]`. That is the silent-failure class T7 forbids:
// `update_component {remove:[…]}` returned ok and removed nothing, because the
// param did not exist and nothing said so (M22). B52 hit the sharper version of
// the same strip — a mis-nested `search` filter vanished and inverted the reply
// into a match-all.
//
// So every tool params schema is `.strict()`. `strictParams` is the single
// constructor: it keeps the message identical across the surface, and it makes
// a new tool strict by default rather than by memory.
//
// This module imports zod and nothing else. schemas.ts and create-schemas.ts
// are barrel-exported and cannot import tool-params.ts (cycle), so the shared
// constructor lives here where all three can reach it.

import { z } from 'zod'
import type { ZodRawShape } from 'zod'

/**
 * What an unknown TOP-LEVEL key on any tool is told. zod's `unrecognized_keys`
 * issue already carries a `keys` array and ZodError renders the issue list
 * verbatim, so the reply NAMES the key; this message says what to do about it.
 */
export const TOOL_UNKNOWN_KEY =
  'This tool does not take the parameter(s) this issue names, so it rejects the call ' +
  'rather than dropping them in silence (T7). Check the spelling against the tool schema, ' +
  'and check whether the field belongs inside a nested object — `update_node` takes node ' +
  'fields inside `patch`, `create_node` inside `spec`, and `search` its filters inside `match`.'

/**
 * Build a tool params schema. Identical to `z.object(shape)` except that an
 * undeclared top-level key is REJECTED, not stripped. Pass `message` to give
 * one tool a sharper explanation (as `search` does for its mis-nested filters).
 */
export const strictParams = <S extends ZodRawShape>(
  shape: S,
  message: string = TOOL_UNKNOWN_KEY,
) => z.object(shape).strict(message)
