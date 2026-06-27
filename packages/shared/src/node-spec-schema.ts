// node-spec-schema.ts — Zod mirrors of node-spec.ts.
//
// The inferred types MUST match node-spec.ts exactly (asserted at
// compile time in test/node-spec-schema.test.ts via the Equal<> guard —
// `bun run typecheck` is the gate). Every leaf is a string atom; the
// grammar of those strings is validated by the server-side parser, not
// here (the schema validates SHAPE, the parser validates VALUE).

import { z } from 'zod'
import type {
  NodeSpec,
  NodeSpecOrStub,
  TreeNodeSpec,
} from './node-spec'

// An atom is any string in the expression grammar (validated downstream).
const atomSchema = z.string()

export const layoutSpecSchema = z.object({
  mode: z.enum(['H', 'V', 'NONE']),
  gap: z.number().optional(),
  pad: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .optional(),
  align: z.tuple([z.string(), z.string()]).optional(),
  wrap: z.boolean().optional(),
})

export const textRunSchema = z.object({
  at: z.tuple([z.number(), z.number()]),
  font: atomSchema.optional(),
  color: atomSchema.optional(),
})

// lh/ls are canonical on the font(...) atom — no top-level lh/ls keys
// (review finding #3).
export const textSpecSchema = z.object({
  content: z.string(),
  font: atomSchema,
  color: atomSchema.optional(),
  align: z.string().optional(),
  valign: z.string().optional(),
  decoration: z.string().optional(),
  case: z.string().optional(),
  paragraphSpacing: z.number().optional(),
  runs: z.array(textRunSchema).optional(),
})

export const exportSettingSchema = z.object({
  format: z.enum(['PNG', 'JPG', 'SVG', 'PDF']),
  suffix: z.string().optional(),
  constraint: z
    .tuple([
      z.enum(['SCALE', 'WIDTH', 'HEIGHT']),
      z.number(),
    ])
    .optional(),
})

export const overrideEntrySchema = z.object({
  path: z.string(),
  field: z.string(),
  value: z.string(),
})

export const idStubSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  size: z.tuple([z.number(), z.number()]),
  childCount: z.number(),
})

// The NodeSpec field set, sans `children` (added per-variant below so
// the read shape (NodeSpecOrStub[]) and the write shape (TreeNodeSpec[])
// can diverge while sharing one field block).
const nodeSpecBase = {
  // identity
  type: z.string(),
  name: z.string().optional(),
  id: z.string().optional(),

  // geometry
  size: z.tuple([z.number(), z.number()]).optional(),
  position: z.tuple([z.number(), z.number()]).optional(),
  layoutPositioning: z
    .enum(['AUTO', 'ABSOLUTE'])
    .optional(),

  // layout
  layout: layoutSpecSchema.optional(),
  sizing: z.tuple([z.string(), z.string()]).optional(),
  constraints: z.tuple([z.string(), z.string()]).optional(),
  minWidth: z.number().nullable().optional(),
  maxWidth: z.number().nullable().optional(),
  minHeight: z.number().nullable().optional(),
  maxHeight: z.number().nullable().optional(),

  // visual — all atoms
  fills: z.array(atomSchema).optional(),
  strokes: z.array(atomSchema).optional(),
  stroke: atomSchema.optional(),
  effects: z.array(atomSchema).optional(),
  radius: atomSchema.optional(),
  opacity: z.number().optional(),
  rotation: z.number().optional(),
  blend: z.string().optional(),
  visible: z.boolean().optional(),
  clipsContent: z.boolean().optional(),
  grids: z.array(atomSchema).optional(),

  // text
  text: textSpecSchema.optional(),

  // export presets
  exportSettings: z.array(exportSettingSchema).optional(),

  // component / instance
  componentProperties: z
    .record(z.union([z.string(), z.boolean()]))
    .optional(),
  variantProperties: z.record(z.string()).optional(),
  overrides: z.array(overrideEntrySchema).optional(),
} as const

// NodeSpec — read/edit shape. `children` is NodeSpecOrStub[] (a child is
// a full spec or a depth/wide-collapse stub). Recursive via z.lazy; the
// child union is inlined so the two recursive schemas have no
// forward-reference cycle (defined before nodeSpecOrStubSchema below).
export const nodeSpecSchema: z.ZodType<NodeSpec> = z.lazy(
  () =>
    z.object({
      ...nodeSpecBase,
      children: z
        .array(
          z.lazy(() =>
            z.union([nodeSpecSchema, idStubSchema]),
          ) as z.ZodType<NodeSpecOrStub>,
        )
        .optional(),
    }),
)

// NodeSpecOrStub — a child node is a full spec or a depth/wide stub.
export const nodeSpecOrStubSchema: z.ZodType<NodeSpecOrStub> =
  z.lazy(() => z.union([nodeSpecSchema, idStubSchema]))

// partialNodeSpecSchema — every field optional (for update_node, where a
// supplied field is replaced wholesale and an omitted field is left
// untouched). `type` is optional here (a patch need not restate it).
export const partialNodeSpecSchema = z.object({
  ...nodeSpecBase,
  type: z.string().optional(),
  children: z.array(nodeSpecOrStubSchema).optional(),
})

// treeNodeSpecSchema — create_tree shape: a NodeSpec with recursive
// TreeNodeSpec children, a { ref } pool reference, or an { id } clone.
export const treeNodeSpecSchema: z.ZodType<TreeNodeSpec> =
  z.lazy(() =>
    z.union([
      z.object({
        ...nodeSpecBase,
        children: z.array(treeNodeSpecSchema).optional(),
      }),
      z.object({ ref: z.string() }),
      z.object({ id: z.string() }),
    ]),
  )
