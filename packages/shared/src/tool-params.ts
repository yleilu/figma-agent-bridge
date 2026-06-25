// tool-params.ts — per-tool Zod param schemas for the MCP tool surface.
//
// SSOT mixin pattern: tree-read tools spread `treeReadParamsSchema.shape`
// (depth/budget/fields/profile/match) and list-read tools spread
// `listReadParamsSchema.shape` (cursor/limit/fields/match). This ensures
// that schema changes to the mixin propagate automatically.
//
// GREEN-WINDOW: this module is NOT barrel-exported from index.ts. Some of
// its names (getNode/getNodes/inspect/search/createNode/createTree params)
// deliberately shadow the legacy schemas.ts / create-schemas.ts versions
// still imported by the live server. New tool code imports these via the
// `@figma-agent-bridge/shared/tool-params` subpath; the legacy modules are
// deleted (and these promoted to the barrel) at their last importer.
//
// Deferred to when their tool is built (params not needed by the slice or
// the core-CRUD step yet): export, create_from_svg, create_image, clone_node,
// delete_node, reparent_node, reorder_children, set_focus, the page tools,
// the component/style tools, annotations, reactions, plugin-data, batch.
// `connectParamsSchema` stays in schemas.ts (it has its own test + is barrel
// exported); status/connect for the session is covered by statusParamsSchema
// here + connectParamsSchema there.

import { z } from 'zod'
import {
  nodeSpecSchema,
  partialNodeSpecSchema,
  treeNodeSpecSchema,
} from './node-spec-schema'
import {
  treeReadParamsSchema,
  listReadParamsSchema,
} from './read-model'

// ---------------------------------------------------------------------------
// Read tools — tree read mixin (depth / budget / fields / profile / match)
// ---------------------------------------------------------------------------

/** Params for `get_node`: retrieve a single node by ID. */
export const getNodeParamsSchema = z.object({
  nodeId: z.string().describe('The node ID to retrieve.'),
  ...treeReadParamsSchema.shape,
})

/** Params for `get_nodes`: retrieve multiple nodes by their IDs. */
export const getNodesParamsSchema = z.object({
  nodeIds: z
    .array(z.string())
    .describe('Array of node IDs to retrieve.'),
  ...treeReadParamsSchema.shape,
})

/**
 * Params for `inspect`: deep-inspect a node or page.
 * Omitting both `nodeId` and `pageId` inspects the current selection/page.
 */
export const inspectParamsSchema = z.object({
  nodeId: z
    .string()
    .optional()
    .describe(
      'Node ID to inspect. Omit to inspect current selection.',
    ),
  pageId: z
    .string()
    .optional()
    .describe(
      'Page ID to inspect. Omit to use the current page.',
    ),
  ...treeReadParamsSchema.shape,
})

// ---------------------------------------------------------------------------
// Read tools — list read mixin (cursor / limit / fields / match)
// ---------------------------------------------------------------------------

/**
 * Params for `search`: flat, paginated node search.
 * Filtering is via the `match` field from the list mixin plus an optional
 * `pageId` to restrict the search to one page.
 */
export const searchParamsSchema = z.object({
  pageId: z
    .string()
    .optional()
    .describe('Restrict search to a specific page by ID.'),
  ...listReadParamsSchema.shape,
})

// ---------------------------------------------------------------------------
// Session / utility tools
// ---------------------------------------------------------------------------

/** Params for `status`: no params — reads connection/document state. */
export const statusParamsSchema = z.object({})

/** Params for `set_selection`: replace the current Figma selection. */
export const setSelectionParamsSchema = z.object({
  nodeIds: z
    .array(z.string())
    .describe(
      'Node IDs to select. Pass an empty array to clear the selection.',
    ),
})

// ---------------------------------------------------------------------------
// Write tools — node mutation
// ---------------------------------------------------------------------------

/**
 * Params for `update_node`: patch an existing node.
 * `patch` is a partial NodeSpec — only supplied fields are updated;
 * omitted fields are left untouched.
 */
export const updateNodeParamsSchema = z.object({
  nodeId: z.string().describe('ID of the node to update.'),
  patch: partialNodeSpecSchema.describe(
    'Partial NodeSpec. Only supplied fields are replaced; omitted fields are left unchanged.',
  ),
})

/**
 * Params for `create_node`: create one node from a full NodeSpec,
 * optionally appended under `parentId` (else the current page).
 *
 * This is the M2 NodeSpec-based shape. It shadows the green-window
 * `create-schemas.ts` version of the same name on purpose; both coexist
 * (this module is NOT barrel-exported) until the create path migrates.
 */
export const createNodeParamsSchema = z.object({
  spec: nodeSpecSchema.describe(
    'The NodeSpec to create. Its `type` selects the Figma node kind.',
  ),
  parentId: z
    .string()
    .optional()
    .describe(
      'ID of the parent to append under. Omit to append to the current page.',
    ),
})

/**
 * Params for `create_tree`: create a recursive tree of nodes.
 * `tree` is a TreeNodeSpec (a NodeSpec with recursive children, or a
 * `{ ref }` pool reference, or an `{ id }` clone-by-id). `refs` is the
 * ref-pool the `{ ref }` nodes resolve against.
 */
export const createTreeParamsSchema = z.object({
  tree: treeNodeSpecSchema.describe(
    'The root TreeNodeSpec (recursive children, { ref } reuse, or { id } clone).',
  ),
  parentId: z
    .string()
    .optional()
    .describe(
      'ID of the parent to append under. Omit to append to the current page.',
    ),
  refs: z
    .record(treeNodeSpecSchema)
    .optional()
    .describe(
      'Ref-pool: named TreeNodeSpecs that { ref } children resolve against.',
    ),
})

// ---------------------------------------------------------------------------
// Variable tools
// ---------------------------------------------------------------------------

/** Params for `bind_variable`: bind a variable to a node field. */
export const bindVariableParamsSchema = z.object({
  nodeId: z
    .string()
    .describe('ID of the node to bind the variable to.'),
  variableId: z
    .string()
    .describe('ID of the variable to bind.'),
  field: z
    .string()
    .describe(
      'Node field to bind (e.g. "fills", "opacity", "itemSpacing").',
    ),
})

/**
 * Params for `get_variables`: list variables, optionally filtered by
 * collection. Cursor/pagination is deferred (P4 concern).
 */
export const getVariablesParamsSchema = z.object({
  collectionId: z
    .string()
    .optional()
    .describe(
      'Variable collection ID to filter by. Omit to return all collections.',
    ),
})
