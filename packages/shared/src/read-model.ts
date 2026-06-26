// read-model.ts — PARAM/CONTRACT schemas for the read model.
//
// These are the param/contract schemas ONLY: the request shapes for
// tree/list reads (D1 cursor/budget/receipt, D2 projection via
// fields/profile) plus the `match` filter. They validate the SHAPE of
// what an agent sends; downstream tools import these names directly.
//
// The read/* runtime infra — cursor encode/decode, truncate-tree,
// budget enforcement, projection, and the match predicate — is a LATER
// step and lives elsewhere. Nothing here touches runtime read logic.
//
// Where a hand-written type accompanies a schema, the inferred type is
// asserted to match it at compile time in test/read-model.test.ts via
// the Equal<> guard (`bun run typecheck` is the gate).

import { z } from 'zod'
import type { NodeSpecOrStub } from './node-spec'

// An opaque, self-contained resume token. The agent receives it from a
// read response and passes it back verbatim; the server decodes it (the
// decoded payload shape is `Cursor` below). Never empty.
export const cursorSchema = z.string().min(1)

// A field allow-list (projection). At least one field; an empty list is
// rejected (an empty projection is meaningless — omit `fields` instead).
export const fieldsSchema = z.array(z.string()).min(1)

// A named projection preset. `full` is the widest; the others narrow to
// a concern (layout/style/text) or the bare identity set (`minimal`).
export const profileSchema = z.enum([
  'minimal',
  'layout',
  'style',
  'text',
  'full',
])

// A node filter. All fields optional; an empty match (`{}`) matches
// everything. `type` accepts a single string or an array (any-of).
export const matchSchema = z.object({
  name: z.string().optional(),
  // `regex` is compile-checked here so a malformed pattern is rejected as a
  // typed validation error at parse time (not later as a raw SyntaxError, and
  // never silently degraded to match-all). The runtime matcher
  // (read/match.ts) also guards defensively for callers that bypass the schema.
  regex: z
    .string()
    .refine(
      pattern => {
        try {
          // Compile-check only — the value is discarded.
          void new RegExp(pattern)
          return true
        } catch {
          return false
        }
      },
      { message: 'invalid regex pattern' },
    )
    .optional(),
  type: z
    .union([z.string(), z.array(z.string())])
    .optional(),
  componentKey: z.string().optional(),
  styleId: z.string().optional(),
  variableId: z.string().optional(),
  instancesOf: z.string().optional(),
})

// Params for a tree (subtree) read. All optional — an empty object is a
// valid "read with server defaults" request.
export const treeReadParamsSchema = z.object({
  depth: z.number().int().optional(),
  budget: z.number().int().positive().optional(),
  fields: fieldsSchema.optional(),
  profile: profileSchema.optional(),
  match: matchSchema.optional(),
})

// Params for the FIDELITY-FIRST tree readers (`get_node` / `get_nodes`, D1/T2).
// A REDUCED tree-read mixin: depth + projection ONLY — deliberately NO `budget`
// (these reads are NEVER size-truncated, or the round-trip would break) and NO
// `match` (the edit reader returns the node's faithful spec; it does not filter
// at the source). This is the documented exception to the full tree-read mixin
// — `inspect` keeps the full mixin (budget + depth + match) per spec.
export const fidelityReadParamsSchema = z.object({
  depth: z.number().int().optional(),
  fields: fieldsSchema.optional(),
  profile: profileSchema.optional(),
})

// Params for a list (flat, paginated) read. All optional.
export const listReadParamsSchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.number().int().positive().optional(),
  fields: fieldsSchema.optional(),
  match: matchSchema.optional(),
})

// A truncation receipt: which nodes were collapsed (depth/wide) and how
// many children each hid, so the agent knows what it didn't get.
export type TruncationReceipt = {
  id: string
  childCount: number
}[]

// The decoded cursor payload. Encodes a resume position plus a
// tree-version hash (so a stale cursor against a mutated tree can be
// detected). The agent never constructs this — it round-trips the
// encoded token (cursorSchema) verbatim.
export type Cursor = { pos: number; treeVersion: string }

export type Match = z.infer<typeof matchSchema>
export type Profile = z.infer<typeof profileSchema>
export type TreeReadParams = z.infer<
  typeof treeReadParamsSchema
>
export type FidelityReadParams = z.infer<
  typeof fidelityReadParamsSchema
>
export type ListReadParams = z.infer<
  typeof listReadParamsSchema
>

// The result of a truncated-tree read: the view (root with stubs at
// the depth/budget boundary) plus the receipt of what was cut.
export type TreeResult = {
  view: NodeSpecOrStub
  truncated: TruncationReceipt
}

// The result of a flat, paginated list read. `cursor` is present only
// when there are more results after this page.
export type ListResult<T> = {
  results: T[]
  truncated: boolean
  cursor?: string
}
