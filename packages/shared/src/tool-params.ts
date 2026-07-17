// tool-params.ts — per-tool Zod param schemas for the MCP tool surface.
//
// SSOT mixin pattern: the full tree-read tool (`inspect`) spreads
// `treeReadParamsSchema.shape` (depth/budget/fields/profile/match); the
// fidelity-first readers (`get_node`/`get_nodes`) spread the REDUCED
// `fidelityReadParamsSchema.shape` (depth/fields/profile — no budget, no
// match, per D1/T2); and list-read tools spread `listReadParamsSchema.shape`
// (cursor/limit/fields/match). This ensures that schema changes to a mixin
// propagate automatically.
//
// SUBPATH (not barrel-exported): this module is the canonical per-tool param
// surface for the live server, imported via the
// `@figma-agent-bridge/shared/tool-params` subpath. It is deliberately kept off
// the barrel `export *` to avoid re-introducing a name clash with schemas.ts /
// create-schemas.ts, both of which still export ONE barrel-exported schema each
// (connectParamsSchema and createFromSvgParamsSchema). The former green-window
// twins in those modules (the M2 read params + create_node/create_tree/
// create_component) were retired in M3-E; their canonical shapes live here.
//
// `connectParamsSchema` stays in schemas.ts (it has its own test + is barrel
// exported); status/connect for the session is covered by statusParamsSchema
// here + connectParamsSchema there.

import { z } from 'zod'
import { FEEDBACK_CATEGORIES } from './feedback'
import {
  nodeSpecSchema,
  partialNodeSpecSchema,
  treeNodeSpecSchema,
} from './node-spec-schema'
import {
  treeReadParamsSchema,
  fidelityReadParamsSchema,
  listReadParamsSchema,
  cursorSchema,
} from './read-model'

// ---------------------------------------------------------------------------
// Pagination mixin — the limit+cursor pair (T10)
//
// The cheap doc-bounded list reads (get_styles / get_variables / list_fonts /
// get_reactions / get_annotations / list_pages) keep their OWN params but share
// the SERVER-SIDE pagination contract: a default `limit` (100) caps the page
// and an opaque `cursor` continues it (the server slices the plugin's full list
// via `paginateList`). They take JUST these two fields — NOT the full
// `listReadParamsSchema` (which also carries `fields`/`match`), since these
// reads do not project or run the matcher; `search` keeps that fuller mixin.
// ---------------------------------------------------------------------------

/** The limit+cursor pagination pair shared by every bounded list read (T10). */
export const listPaginationParamsSchema = z.object({
  cursor: cursorSchema
    .optional()
    .describe(
      'Opaque continuation token from a prior page (returned only when truncated). Pass it back verbatim to fetch the next page.',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Max results per page (default 100). Results beyond this are truncated; use the returned cursor to continue.',
    ),
})

// ---------------------------------------------------------------------------
// File-target mixin — the per-call `fileKey` every tool takes (B3), plus the
// reserved, server-managed `sessionId` header (request-envelope.md).
//
// Addressing is per-call, not server-stamped from the connection. The non-file
// tools are the exceptions and keep their own schemas: `connect` (discovery),
// `status` (no per-call file), and `record_feedback` (global feedback store, no
// file) — the three registered via registerSessionTool.
// overview.md + request-envelope.md are the source of truth.
// ---------------------------------------------------------------------------

/** The per-call fileKey (required) + reserved sessionId, shared by every file-addressed tool. */
export const fileTargetParamsSchema = z.object({
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
})

// ---------------------------------------------------------------------------
// Read tools — fidelity-first tree readers (depth / fields / profile ONLY)
//
// `get_node` / `get_nodes` are the D1/T2 fidelity exception: they spread the
// REDUCED `fidelityReadParamsSchema` (depth + projection), NOT the full
// `treeReadParamsSchema`. They are NEVER budget-truncated (a budget-capped edit
// read would break the round-trip) and carry NO `match` filter (the edit reader
// returns the node's faithful spec, it does not filter at the source). `inspect`
// (below) keeps the full mixin — it legitimately takes budget + depth + match.
// ---------------------------------------------------------------------------

/** Params for `get_node`: retrieve a single node by ID. */
export const getNodeParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeId: z.string().describe('The node ID to retrieve.'),
  ...fidelityReadParamsSchema.shape,
})

/** Params for `get_nodes`: retrieve multiple nodes by their IDs. */
export const getNodesParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeIds: z
    .array(z.string())
    .describe('Array of node IDs to retrieve.'),
  ...fidelityReadParamsSchema.shape,
})

/**
 * Params for `inspect`: deep-inspect a node or page.
 * Omitting both `nodeId` and `pageId` inspects the current selection: a
 * multi-node selection returns a FOREST under a synthetic
 * { type: 'SELECTION', children: [<node>, …] } root, with depth/budget and the
 * truncation receipt applied across the whole set; a single selected node
 * returns that node's view; an empty selection falls back to the current page.
 */
export const inspectParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeId: z
    .string()
    .optional()
    .describe(
      'Node ID to inspect. Omit to inspect the current selection (a multi-node selection returns a SELECTION forest of all selected nodes).',
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
 * Search scope: where the scan runs.
 *   document  — every page (default)
 *   page      — a single page (requires `pageId`)
 *   node      — a node subtree (requires `nodeId`)
 *   selection — the current selection's subtrees
 */
export const searchScopeSchema = z.enum([
  'document',
  'page',
  'node',
  'selection',
])

/**
 * Params for `search`: flat, paginated node search (Rule A).
 * `scope` selects where the plugin scans; the SERVER applies `match`
 * (the list mixin), `fields` projection, and the opaque cursor + `limit`.
 * `pageId` / `nodeId` qualify the page / node scopes respectively.
 *
 * `depth` bounds the SCAN SCOPE — how deep into each root the plugin
 * traverses — NOT the output shape: results always stay a flat Rule-A list
 * (search is a list read, not a tree read). `-1` (or omitted) scans the whole
 * subtree; `depth=0` scans only the root(s); `depth=N` descends N levels.
 */
export const searchParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  scope: searchScopeSchema
    .optional()
    .describe(
      'Where to scan: document (default) | page | node | selection.',
    ),
  pageId: z
    .string()
    .optional()
    .describe(
      'Page to scan when scope=page (also restricts a document scan).',
    ),
  nodeId: z
    .string()
    .optional()
    .describe('Node subtree to scan when scope=node.'),
  depth: z
    .number()
    .int()
    .optional()
    .describe(
      'Scan-scope depth: how deep the plugin traverses each root. -1 (default) = whole subtree; 0 = root(s) only; N = N levels deep. Results stay a flat list.',
    ),
  ...listReadParamsSchema.shape,
})

// ---------------------------------------------------------------------------
// Session / utility tools
// ---------------------------------------------------------------------------

/** Params for `status`: no params — reads connection/document state. */
export const statusParamsSchema = z.object({})

/** Params for `get_selection`: reads the current selection of the target file. */
export const getSelectionParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
})

/**
 * Params for `list_pages`: document + page enumeration (Rule A; bounded by T10).
 * The page set is server-side paginated through the shared limit+cursor contract
 * (`limit` defaults to 100, `cursor` continues when `truncated`) — `docName`
 * stays on the envelope alongside the bounded page.
 */
export const listPagesParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  ...listPaginationParamsSchema.shape,
})

/** Params for `set_selection`: replace the current Figma selection. */
export const setSelectionParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeIds: z
    .array(z.string())
    .describe(
      'Node IDs to select. Pass an empty array to clear the selection.',
    ),
})

// ---------------------------------------------------------------------------
// Write tools — structure (delete / focus)
// ---------------------------------------------------------------------------

/** Params for `delete_node`: remove a node from the document. */
export const deleteNodeParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeId: z.string().describe('ID of the node to delete.'),
})

/**
 * Params for `set_focus`: scroll and zoom the viewport so the given nodes are
 * in view. set_focus is the viewport WRITER — the viewport is READ via `status`
 * (which now returns the live viewport). This moves the CANVAS only — it does
 * not change the selection (pair with set_selection for that).
 */
export const setFocusParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeIds: z
    .array(z.string())
    .describe(
      'Node IDs to scroll and zoom into view. Ids that do not resolve are skipped.',
    ),
})

/**
 * Params for `clone_node`: duplicate a node, optionally into a parent at an
 * index, optionally `count` times. Returns one entry per clone.
 */
export const cloneNodeParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeId: z.string().describe('ID of the node to clone.'),
  parentId: z
    .string()
    .optional()
    .describe(
      "Parent to append the clone(s) under. Omit to keep the source's parent.",
    ),
  index: z
    .number()
    .int()
    .optional()
    .describe(
      'Insertion index of the clone(s) within the parent. Omit to append last.',
    ),
  count: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'How many clones to make (default 1). Each is a fresh copy.',
    ),
})

/**
 * Params for `reparent_node`: move a node under a new parent (re-flows under
 * the new parent's layout), optionally at a specific index.
 */
export const reparentNodeParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeId: z
    .string()
    .describe('ID of the node to reparent.'),
  parentId: z
    .string()
    .describe(
      'ID of the new parent to move the node into.',
    ),
  index: z
    .number()
    .int()
    .optional()
    .describe(
      'Insertion index within the new parent. Omit to append last.',
    ),
})

/**
 * Params for `reorder_children`: set the child order of a parent. `nodeIds` is
 * the desired full order; the plugin set-equality validates it against the
 * parent's actual children (warns on mismatch, never throws — T7).
 */
export const reorderChildrenParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  parentId: z
    .string()
    .describe(
      'ID of the parent whose children to reorder.',
    ),
  nodeIds: z
    .array(z.string())
    .describe(
      "Child IDs in the desired order. Should be the parent's full child set; mismatches warn.",
    ),
})

/**
 * Params for `boolean_op`: combine ≥2 nodes into a BooleanOperationNode via
 * union/subtract/intersect/exclude.
 */
export const booleanOpParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  op: z
    .enum(['UNION', 'SUBTRACT', 'INTERSECT', 'EXCLUDE'])
    .describe('The boolean operation to apply.'),
  nodeIds: z
    .array(z.string())
    .min(2)
    .describe('Node IDs to combine (at least 2).'),
  parentId: z
    .string()
    .optional()
    .describe(
      "Parent for the result. Omit to use the first node's parent.",
    ),
})

/** Params for `flatten`: flatten one or more nodes into a single vector. */
export const flattenParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeIds: z
    .array(z.string())
    .min(1)
    .describe('Node IDs to flatten into one vector.'),
  parentId: z
    .string()
    .optional()
    .describe(
      "Parent for the result. Omit to use the first node's parent.",
    ),
})

/** Params for `group_nodes`: group ≥1 existing nodes into a GROUP node. */
export const groupNodesParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeIds: z
    .array(z.string())
    .min(1)
    .describe('Node IDs to group (at least 1).'),
  parentId: z
    .string()
    .optional()
    .describe(
      "Parent for the resulting group. Omit to use the first node's parent.",
    ),
})

// ---------------------------------------------------------------------------
// transform_group modifier shapes (LinearRepeatModifier / RadialRepeatModifier)
//
// figma.transformGroup() is typed in @figma/plugin-typings 1.130.0 (repo pins
// 1.123.0 — types not present). Modifier shapes confirmed via live probe
// against real Figma. T8: discriminator + structural fields are plain
// enum/struct (not grammar-routed); numeric scalars are plain z.number()
// (structural op, not an appearance atom).
//
// Confirmed live LINEAR modifier that worked:
//   { type: 'REPEAT', repeatType: 'LINEAR', count: 3, unitType: 'PIXELS', offset: 100, axis: 'HORIZONTAL' }
// ---------------------------------------------------------------------------

const linearRepeatModifierSchema = z
  .object({
    type: z.literal('REPEAT'),
    repeatType: z
      .literal('LINEAR')
      .describe(
        'Linear repeat: replicate nodes in a straight line.',
      ),
    count: z
      .number()
      .int()
      .min(1)
      .describe(
        'Number of repeated copies (including the source).',
      ),
    unitType: z
      .string()
      .describe(
        "Unit for the offset distance (e.g. 'PIXELS').",
      ),
    offset: z
      .number()
      .describe(
        'Distance between repeated instances, in unitType units.',
      ),
    axis: z
      .enum(['HORIZONTAL', 'VERTICAL'])
      .describe('Direction of repetition.'),
  })
  .passthrough()

const radialRepeatModifierSchema = z
  .object({
    type: z.literal('REPEAT'),
    repeatType: z
      .literal('RADIAL')
      .describe(
        'Radial repeat: replicate nodes around a centre point.',
      ),
    count: z
      .number()
      .int()
      .min(1)
      .describe(
        'Number of repeated copies (including the source).',
      ),
  })
  .passthrough()
  .describe(
    'RADIAL modifier shape not live-confirmed; required fields beyond type/repeatType/count pass through to Figma unvalidated.',
  )

/**
 * Discriminated union of supported TransformModifier shapes.
 * Both variants share type:'REPEAT'; discriminated on repeatType.
 *
 * Confirmed live LINEAR example:
 *   { type: 'REPEAT', repeatType: 'LINEAR', count: 3, unitType: 'PIXELS', offset: 100, axis: 'HORIZONTAL' }
 */
export const transformModifierSchema = z.discriminatedUnion(
  'repeatType',
  [linearRepeatModifierSchema, radialRepeatModifierSchema],
)

/**
 * Params for `transform_group`: apply a repeat-pattern transform to ≥1 existing
 * nodes via `figma.transformGroup()` → TransformGroupNode.
 *
 * Ship-gated: the controller must live-verify that `figma.transformGroup` exists
 * in the runtime before shipping this tool. If absent, the tool row is reverted
 * and the count returns to 50. The plugin handler feature-detects (T7) and
 * returns a clear error if the function is unavailable.
 *
 * Batch op-set member — same operation-over-existing-ids shape as
 * `boolean_op`, `flatten`, and `group_nodes`.
 */
export const transformGroupParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeIds: z
    .array(z.string())
    .min(1)
    .describe(
      'Node IDs to include in the transform group (at least 1).',
    ),
  parentId: z
    .string()
    .optional()
    .describe(
      "Parent for the result. Omit to use the first node's parent.",
    ),
  modifiers: z
    .array(transformModifierSchema)
    .min(1)
    .describe(
      "One or more repeat-pattern modifiers. Each has type:'REPEAT' and repeatType:'LINEAR'|'RADIAL'. Confirmed LINEAR shape: {type:'REPEAT',repeatType:'LINEAR',count,unitType:'PIXELS',offset,axis:'HORIZONTAL'|'VERTICAL'}.",
    ),
})

// ---------------------------------------------------------------------------
// Write tools — pages
// ---------------------------------------------------------------------------

/** Params for `create_page`: add a new page to the document. */
export const createPageParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  name: z.string().describe('Name for the new page.'),
})

/** Params for `set_current_page`: switch the active page. */
export const setCurrentPageParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  pageId: z
    .string()
    .describe('ID of the page to make current.'),
})

/** Params for `duplicate_page`: clone an existing page, optionally renaming it. */
export const duplicatePageParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  pageId: z
    .string()
    .describe('ID of the page to duplicate.'),
  name: z
    .string()
    .optional()
    .describe(
      'Name for the duplicated page. Defaults to the clone name Figma assigns.',
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
  ...fileTargetParamsSchema.shape,
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
  ...fileTargetParamsSchema.shape,
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
  ...fileTargetParamsSchema.shape,
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

/**
 * Params for `create_image`: register an image and return its hash. Supply
 * EXACTLY ONE of `url` (fetched by the plugin via createImageAsync) or `bytes`
 * (raw image bytes as a number array, passed to createImage). The handler
 * validates that exactly one is present.
 */
export const createImageParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  url: z
    .string()
    .optional()
    .describe(
      'Image URL to fetch (plugin uses createImageAsync). Provide this OR bytes, not both.',
    ),
  bytes: z
    .array(z.number())
    .optional()
    .describe(
      'Raw image bytes as a number array (plugin uses createImage). Provide this OR url, not both.',
    ),
})

// ---------------------------------------------------------------------------
// Variable tools
// ---------------------------------------------------------------------------

/** Params for `bind_variable`: bind a variable to a node field and/or pin a frame to a variable-collection mode. */
export const bindVariableParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeId: z
    .string()
    .describe('ID of the node to bind the variable to.'),
  variableId: z
    .string()
    .optional()
    .describe(
      'ID of the variable to bind. Required when `field` is present.',
    ),
  field: z
    .string()
    .optional()
    .describe(
      'Node field to bind (e.g. "fills", "opacity", "itemSpacing"). Required when `variableId` is present.',
    ),
  /**
   * M13 — per-collection explicit mode pin. Keys are collection IDs; values
   * specify which mode to pin by `modeId` (raw id) or `modeName` (resolved
   * plugin-side against the collection's modes list), or `clearMode: true` to
   * clear the pin. The read-back shape (`explicitVariableModes` on NodeSpec)
   * is a `{collectionId: modeId}` map; to re-apply it pass each entry here.
   *
   * Must supply at least one of: `field`+`variableId` OR `mode` (enforced in
   * the handler because .refine() breaks .shape access).
   */
  mode: z
    .record(
      z.object({
        modeId: z.string().optional(),
        modeName: z.string().optional(),
        clearMode: z.boolean().optional(),
      }),
    )
    .optional()
    .describe(
      'Map of collectionId → mode entry. Each entry pins the node to render that collection in the given mode.',
    ),
})

/**
 * Params for `get_variables`: list variables, optionally filtered by
 * collection. Bounded by T10 — server-side paginated over the collections list
 * via the shared limit+cursor contract (`limit` defaults to 100, `cursor`
 * continues when `truncated`).
 */
export const getVariablesParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  collectionId: z
    .string()
    .optional()
    .describe(
      'Variable collection ID to filter by. Omit to return all collections.',
    ),
  ...listPaginationParamsSchema.shape,
})

/** The four resolved variable data types. */
export const variableTypeSchema = z.enum([
  'COLOR',
  'FLOAT',
  'STRING',
  'BOOLEAN',
])

/**
 * One variable to create inside the collection. `valuesByMode` maps a MODE NAME
 * (matched against the collection's modes) to a value. COLOR values are hex
 * atoms (parsed via the grammar paint face); FLOAT/STRING/BOOLEAN are literals.
 * `aliases` / `scopes` / `codeSyntax` / `hiddenFromPublishing` may also be set on
 * create (parity with update_variables — applied through the same per-variable
 * path, each feature-detected + T7-degraded).
 */
export const createVariableSpecSchema = z.object({
  name: z
    .string()
    .describe('Variable name (e.g. "Brand/Primary").'),
  type: variableTypeSchema.describe(
    'Resolved variable type. COLOR values are hex atoms; others are literals.',
  ),
  valuesByMode: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .describe(
      'Map of mode NAME → value. COLOR values are hex atoms (e.g. "#3B82F6"); FLOAT/STRING/BOOLEAN are literals. Modes not present in the collection are reported as warnings.',
    ),
  aliases: z
    .record(z.string())
    .optional()
    .describe(
      'Map of mode NAME → target variable ID — sets that mode to a VARIABLE_ALIAS of the target (feature-detected + T7-degraded).',
    ),
  scopes: z
    .array(z.string())
    .optional()
    .describe('Variable scopes (e.g. ["ALL_SCOPES"]).'),
  codeSyntax: z
    .record(z.string())
    .optional()
    .describe(
      'Code syntax per platform (keys: WEB | ANDROID | iOS).',
    ),
  hiddenFromPublishing: z
    .boolean()
    .optional()
    .describe(
      'Whether to hide the variable from publishing.',
    ),
})

/**
 * Params for `create_variables`: create a collection (with optional extra
 * modes), then its variables with per-mode values. Returns
 * { collectionId, modes, variables:[{id,name}] }.
 */
export const createVariablesParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  collection: z
    .string()
    .describe('Name for the new variable collection.'),
  modes: z
    .array(z.string())
    .optional()
    .describe(
      'Additional mode names to add beyond the default mode. The default mode is renamed to the first entry when given.',
    ),
  variables: z
    .array(createVariableSpecSchema)
    .describe('Variables to create in the collection.'),
})

/** A single per-variable edit for `update_variables`. */
export const updateVariableSpecSchema = z.object({
  id: z.string().describe('ID of the variable to edit.'),
  valuesByMode: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      'Map of mode NAME → new value (COLOR = hex atom; else literal).',
    ),
  aliases: z
    .record(z.string())
    .optional()
    .describe(
      'Map of mode NAME → target variable ID — sets that mode to a VARIABLE_ALIAS of the target (feature-detected + T7-degraded). Mirrors createVariableSpecSchema for round-trip parity (T2).',
    ),
  scopes: z
    .array(z.string())
    .optional()
    .describe('Variable scopes (e.g. ["ALL_SCOPES"]).'),
  codeSyntax: z
    .record(z.string())
    .optional()
    .describe(
      'Code syntax per platform (keys: WEB | ANDROID | iOS).',
    ),
  hiddenFromPublishing: z
    .boolean()
    .optional()
    .describe(
      'Whether to hide the variable from publishing.',
    ),
})

/**
 * Params for `update_variables`: mode lifecycle on an existing collection
 * (addModes / removeModes / renameModes) plus per-variable edits (values,
 * scopes, codeSyntax, hiddenFromPublishing). Each gated member degrades with a
 * warning (T7). Returns { collectionId, modes, warnings[] }.
 */
export const updateVariablesParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  collectionId: z
    .string()
    .describe('ID of the variable collection to update.'),
  addModes: z
    .array(z.string())
    .optional()
    .describe('Mode names to add to the collection.'),
  removeModes: z
    .array(z.string())
    .optional()
    .describe(
      'Mode names (or IDs) to remove from the collection.',
    ),
  renameModes: z
    .array(
      z.object({
        from: z
          .string()
          .describe(
            'Existing mode name (or ID) to rename.',
          ),
        to: z.string().describe('New mode name.'),
      }),
    )
    .optional()
    .describe('Modes to rename.'),
  variables: z
    .array(updateVariableSpecSchema)
    .optional()
    .describe('Per-variable edits.'),
})

/**
 * Params for `delete_variables`: remove variables AND/OR collections by id.
 * Collections are processed first (removing a collection cascades its variables).
 * Partial success (T5): one bad id never sinks the rest. Returns
 * { results:[{id, kind:'variable'|'collection'}], errors:[{id, error}] }.
 *
 * Note: the "at least one of variables/collections must be non-empty" constraint
 * is enforced in the handler (INVALID_PARAM) rather than via .refine() so the
 * schema retains .shape for registerFileTool / MCP SDK registration.
 */
export const deleteVariablesParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  variables: z
    .array(z.string())
    .optional()
    .describe('IDs of variables to remove.'),
  collections: z
    .array(z.string())
    .optional()
    .describe(
      'IDs of variable collections to remove (cascades their variables).',
    ),
})

// ---------------------------------------------------------------------------
// Write tools — styles
// ---------------------------------------------------------------------------

/** The four style categories. */
export const styleTypeSchema = z.enum([
  'paint',
  'text',
  'effect',
  'grid',
])

/**
 * One style to create: a paint/text/effect/grid style from a grammar atom value.
 * paint → atomToPaint, text → atomToFont (+loadFont in the plugin), effect →
 * atomToEffect, grid → the grid head.
 */
export const createStyleSpecSchema = z.object({
  type: styleTypeSchema.describe(
    'Style category: paint | text | effect | grid.',
  ),
  name: z.string().describe('Name for the style.'),
  value: z
    .string()
    .describe(
      'The style VALUE as a grammar atom (paint hex/gradient, font(...), shadow(...), columns(...)).',
    ),
  description: z
    .string()
    .optional()
    .describe('Optional style description.'),
})

/**
 * Params for `create_styles`: BATCH-create paint/text/effect/grid styles from
 * grammar atom values with PARTIAL SUCCESS — one entry's failure does not abort
 * the rest. Returns { results:[{id,key,name,type,index}], errors:[{index,error}] }.
 */
export const createStylesParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  styles: z
    .array(createStyleSpecSchema)
    .describe('The styles to create (partial success).'),
})

/**
 * One style to edit: looked up by `id` OR by `name` + `type`. A supplied `value`
 * is parsed per the style's category; `newName`/`description` apply directly.
 */
export const updateStyleSpecSchema = z.object({
  id: z
    .string()
    .optional()
    .describe(
      'ID of the style to update (or look it up by name + type).',
    ),
  name: z
    .string()
    .optional()
    .describe(
      'Style name to look up (with `type`) when no `id` is given.',
    ),
  type: styleTypeSchema
    .optional()
    .describe(
      'Style category for name lookup: paint | text | effect | grid.',
    ),
  value: z
    .string()
    .optional()
    .describe(
      'New style VALUE as a grammar atom (parsed per the style category).',
    ),
  newName: z
    .string()
    .optional()
    .describe('New name for the style.'),
  description: z
    .string()
    .optional()
    .describe('New description for the style.'),
})

/**
 * Params for `update_styles`: BATCH-edit existing styles' parsed value, name,
 * and/or description with PARTIAL SUCCESS — one entry's failure does not abort
 * the rest. Returns { results:[{id,index}], errors:[{index,error}] }.
 */
export const updateStylesParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  styles: z
    .array(updateStyleSpecSchema)
    .describe('The styles to edit (partial success).'),
})

/**
 * One style entry for `delete_styles`: addressed by `id` OR by `name` + `type`.
 * Mirrors the update_styles entry shape minus value/newName/description.
 */
export const deleteStyleSpecSchema = z.object({
  id: z
    .string()
    .optional()
    .describe(
      'ID of the style to delete (or look it up by name + type).',
    ),
  name: z
    .string()
    .optional()
    .describe(
      'Style name to look up (with `type`) when no `id` is given.',
    ),
  type: styleTypeSchema
    .optional()
    .describe(
      'Style category for name lookup: paint | text | effect | grid.',
    ),
})

/**
 * Params for `delete_styles`: BATCH-delete paint/text/effect/grid styles by id
 * OR by name+type (same addressing as update_styles). Partial success (T5): one
 * entry's failure does not abort the rest. No value-convert (T8 — deletes carry
 * no grammar). Returns { results:[{id,index}], errors:[{index,error}] }.
 *
 * Per-entry validation (id OR name+type) is enforced in the handler so the schema
 * retains .shape for registerFileTool / MCP SDK registration (avoids the ZodEffects
 * .shape-spreading caveat hit in M1a).
 */
export const deleteStylesParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  styles: z
    .array(deleteStyleSpecSchema)
    .describe('The styles to delete (partial success).'),
})

/**
 * Params for `apply_style`: bind a style to a node field via
 * setFillStyleIdAsync / setStrokeStyleIdAsync / setTextStyleIdAsync /
 * setEffectStyleIdAsync / setGridStyleIdAsync. Returns { id, warnings[] }.
 */
export const applyStyleParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeId: z
    .string()
    .describe('ID of the node to apply the style to.'),
  styleId: z.string().describe('ID of the style to apply.'),
  field: z
    .enum(['fill', 'stroke', 'text', 'effect', 'grid'])
    .describe(
      'Which field to bind: fill | stroke | text | effect | grid.',
    ),
})

// ---------------------------------------------------------------------------
// Read tools — design system (styles / components / fonts)
// ---------------------------------------------------------------------------

/**
 * Params for `get_styles`: list local styles, optionally narrowed to one
 * category or a single style ID. Bounded by T10 — server-side paginated via the
 * shared limit+cursor contract (`limit` defaults to 100, `cursor` continues when
 * `truncated`).
 */
export const getStylesParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  type: z
    .enum(['paint', 'text', 'effect', 'grid'])
    .optional()
    .describe(
      'Filter to one style category. Omit for all.',
    ),
  id: z
    .string()
    .optional()
    .describe('A specific style ID to fetch.'),
  ...listPaginationParamsSchema.shape,
})

/**
 * Params for `get_components`: list local + remote components, optionally
 * filtered by a name substring. Bounded by T10 — the flattened list is paged
 * server-side via the shared limit+cursor mixin. `includeRemote` (default
 * **false**) gates the O(document) all-instances remote-discovery scan that
 * timed out live on a real UI-kit document; default false returns only the
 * cheap LOCAL component/set scan.
 */
export const getComponentsParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  query: z
    .string()
    .optional()
    .describe(
      'Case-insensitive substring filter on component/set name.',
    ),
  includeRemote: z
    .boolean()
    .optional()
    .describe(
      'Also discover library/remote components by scanning every instance (O(document) — can be slow on large docs). Defaults to false: only LOCAL components are scanned.',
    ),
  ...listPaginationParamsSchema.shape,
})

/**
 * Params for `list_fonts`: enumerate available fonts grouped by family,
 * optionally filtered by a family-name substring. Bounded by T10 — the host
 * font list is large, so this read is server-side paginated (over the
 * post-`query` list) via the shared limit+cursor contract (`limit` defaults to
 * 100, `cursor` continues when `truncated`).
 */
export const listFontsParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  query: z
    .string()
    .optional()
    .describe(
      'Case-insensitive substring filter on font family name.',
    ),
  ...listPaginationParamsSchema.shape,
})

// ---------------------------------------------------------------------------
// Read tools — node metadata & prototype
// ---------------------------------------------------------------------------

/**
 * Params for `get_reactions`: read a node's prototype reactions. Bounded by
 * T10 — server-side paginated via the shared limit+cursor contract (`limit`
 * defaults to 100, `cursor` continues when `truncated`); the T7 degrade
 * `warnings` still ride on the success envelope.
 */
export const getReactionsParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeId: z
    .string()
    .describe(
      'The node whose prototype reactions to read.',
    ),
  ...listPaginationParamsSchema.shape,
})

/** Params for `get_plugin_data`: read a node's plugin data. */
export const getPluginDataParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeId: z
    .string()
    .describe('The node to read plugin data from.'),
  namespace: z
    .string()
    .optional()
    .describe(
      "Shared plugin-data namespace. Omit to read this plugin's own data only.",
    ),
})

/** Params for `set_plugin_data`: write a single plugin-data key on a node. */
export const setPluginDataParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeId: z
    .string()
    .describe('The node to write plugin data to.'),
  key: z.string().describe('The plugin-data key to set.'),
  value: z
    .string()
    .describe(
      'The value to store. Pass an empty string to clear the key.',
    ),
  namespace: z
    .string()
    .optional()
    .describe(
      "Shared plugin-data namespace. Omit to write this plugin's own data.",
    ),
})

/** Params for `set_reactions`: replace a node's prototype reactions. */
export const setReactionsParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeId: z
    .string()
    .describe('The node whose prototype reactions to set.'),
  reactions: z
    .array(z.any())
    .describe(
      'Prototype reactions to set: opaque reaction objects matching the get_reactions output shape.',
    ),
})

// ---------------------------------------------------------------------------
// Handoff — annotations
// ---------------------------------------------------------------------------

/**
 * Params for `get_annotations`: read a node's (or the selection's) annotations.
 * Bounded by T10 — server-side paginated via the shared limit+cursor contract
 * (`limit` defaults to 100, `cursor` continues when `truncated`); the
 * editorType-gated T7 degrade `warnings` still ride on the success envelope.
 */
export const getAnnotationsParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeId: z
    .string()
    .optional()
    .describe(
      "Node whose annotations to read. Omit to read the current selection's annotations.",
    ),
  ...listPaginationParamsSchema.shape,
})

/** Params for `set_annotations`: replace a node's annotations. */
export const setAnnotationsParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeId: z
    .string()
    .describe('The node whose annotations to set.'),
  annotations: z
    .array(z.any())
    .describe(
      'Annotations to set: objects matching the get_annotations output shape.',
    ),
})

// ---------------------------------------------------------------------------
// Read tools — export
// ---------------------------------------------------------------------------

/** Params for `export`: render a node to PNG/JPG/SVG/PDF. */
export const exportParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeId: z.string().describe('The node to export.'),
  format: z
    .enum(['PNG', 'JPG', 'SVG', 'PDF'])
    .optional()
    .describe('Export format (default PNG).'),
  scale: z
    .number()
    .positive()
    .optional()
    .describe(
      'Raster scale factor (default 1; ignored for SVG/PDF).',
    ),
})

// ---------------------------------------------------------------------------
// Write tools — components & instances
// ---------------------------------------------------------------------------

/**
 * Params for `create_component`: PROMOTE-ONLY (un-overloaded per the spec's
 * single-node-promote decision). Componentizes an existing node via
 * createComponentFromNode(); optionally renames / sets its description. To build
 * a node first, use create_node / create_tree, then promote the returned id.
 */
export const createComponentParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  nodeId: z
    .string()
    .describe(
      'Existing node to componentize via createComponentFromNode().',
    ),
  name: z
    .string()
    .optional()
    .describe('Name for the resulting component.'),
  description: z
    .string()
    .optional()
    .describe('Description for the resulting component.'),
})

/** A single component-property definition to add (BOOLEAN/TEXT/INSTANCE_SWAP/SLOT). */
export const componentPropertyDefSchema = z.object({
  name: z.string().describe('Property name.'),
  type: z
    .enum(['BOOLEAN', 'TEXT', 'INSTANCE_SWAP', 'SLOT'])
    .describe('Property type.'),
  defaultValue: z
    .union([z.string(), z.boolean()])
    .describe(
      'Default value (boolean for BOOLEAN, string for TEXT, component key for INSTANCE_SWAP, "" for SLOT).',
    ),
})

/** A single component-property edit (rename / change default). */
export const componentPropertyEditSchema = z.object({
  name: z
    .string()
    .describe('Existing property name to edit.'),
  newName: z
    .string()
    .optional()
    .describe('Rename the property.'),
  defaultValue: z
    .union([z.string(), z.boolean()])
    .optional()
    .describe('New default value.'),
})

/**
 * Params for `update_component`: add/edit/delete componentPropertyDefinitions,
 * set the description, and (T7-gated) expose nested instances.
 */
export const updateComponentParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  componentId: z
    .string()
    .describe(
      'ID of the component (or component set) to update.',
    ),
  add: z
    .array(componentPropertyDefSchema)
    .optional()
    .describe('Property definitions to add.'),
  edit: z
    .array(componentPropertyEditSchema)
    .optional()
    .describe(
      'Property definitions to edit (rename / new default).',
    ),
  delete: z
    .array(z.string())
    .optional()
    .describe('Property names to delete.'),
  description: z
    .string()
    .optional()
    .describe('New description for the component.'),
  expose: z
    .array(z.string())
    .optional()
    .describe(
      'Nested instance node IDs to expose (T7-gated: degrades with a warning if unsupported).',
    ),
  slots: z
    .array(z.string())
    .optional()
    .describe(
      'Names of slots to CREATE inside this component. Each becomes a new empty SLOT node (named accordingly) that instances fill per-screen. T7-gated: degrades with a warning if createSlot is unavailable.',
    ),
})

/** Params for `combine_variants`: combine ≥2 components into a variant set. */
export const combineVariantsParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  componentIds: z
    .array(z.string())
    .min(2)
    .describe('Component IDs to combine (at least 2).'),
  parentId: z
    .string()
    .optional()
    .describe(
      "Parent for the resulting set. Omit to use the first component's parent.",
    ),
  name: z
    .string()
    .optional()
    .describe('Name for the resulting component set.'),
})

/**
 * Params for `swap_component`: point an instance at a different main component.
 * Remote-capable: provide EITHER `mainComponentId` (a LOCAL component node id —
 * resolved directly) OR `key` (a component KEY — resolved via
 * importComponentByKeyAsync, T7-gated: if the import fails the swap degrades with
 * a warning). At least one is required. If BOTH are given the LOCAL
 * `mainComponentId` WINS (it needs no async import).
 */
export const swapComponentParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  instanceId: z
    .string()
    .describe('ID of the instance to swap.'),
  mainComponentId: z
    .string()
    .optional()
    .describe(
      'LOCAL component node id to swap to. Wins over `key` if both are given.',
    ),
  key: z
    .string()
    .optional()
    .describe(
      'Component KEY to swap to (remote/library) — resolved via importComponentByKeyAsync (T7-gated). Used when `mainComponentId` is absent.',
    ),
})

/**
 * Params for `set_instance`: set instance properties (variant + BOOLEAN / TEXT /
 * INSTANCE_SWAP) and/or apply per-node overrides.
 */
export const setInstanceParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  instanceId: z
    .string()
    .describe('ID of the instance to configure.'),
  properties: z
    .record(z.union([z.string(), z.boolean()]))
    .optional()
    .describe(
      'Property values to set via setProperties (variant + BOOLEAN/TEXT/INSTANCE_SWAP).',
    ),
  overrides: z
    .array(
      z.object({
        path: z
          .string()
          .describe('Override target node id / path.'),
        field: z.string().describe('Field to override.'),
        value: z
          .string()
          .describe('Override value (atom string).'),
      }),
    )
    .optional()
    .describe(
      'Per-node overrides (NOT YET APPLIED — currently degrades with a warning).',
    ),
})

// ---------------------------------------------------------------------------
// The one generic batch (D3) — N WRITE ops over existing targets, in order
// ---------------------------------------------------------------------------

/**
 * The WRITE commands `batch` can fan out over. These are the existing
 * mutation tools (D3: "N ops over EXISTING targets"). New-node creation
 * (create_node / create_tree / create_from_svg / create_image /
 * create_component) is deliberately EXCLUDED — chaining new nodes stays
 * create_tree's job (ref-pool). The strings match COMMANDS exactly so a
 * heterogeneous entry's `op` dispatches straight through the plugin's
 * command switch.
 */
export const batchOpSchema = z.enum([
  'update_node',
  'delete_node',
  'set_selection',
  'set_focus',
  'reparent_node',
  'reorder_children',
  'clone_node',
  'boolean_op',
  'flatten',
  'group_nodes',
  'transform_group',
  'apply_style',
  'update_component',
  'combine_variants',
  'swap_component',
  'set_instance',
  'bind_variable',
  'create_styles',
  'update_styles',
  'create_variables',
  'update_variables',
  'delete_variables',
  'set_plugin_data',
  'set_reactions',
  'set_annotations',
  'create_page',
  'set_current_page',
  'duplicate_page',
])

/**
 * One batch entry. `op` (optional) overrides the top-level default for THIS
 * entry; if omitted it falls back to the top-level `op`. The remaining fields
 * are that op's own params (`nodeId`/`instanceId`/`patch`/…), validated by the
 * op's individual handler — so this schema is permissive (passthrough) and the
 * per-op param shape is enforced where each command already enforces it.
 */
export const batchEntrySchema = z
  .object({
    op: batchOpSchema
      .optional()
      .describe(
        'Op for this entry. Overrides the top-level op; falls back to it when omitted.',
      ),
  })
  .passthrough()

/**
 * Params for `batch`: one or mixed WRITE ops over N existing targets, executed
 * in array order with PARTIAL SUCCESS (D3). A top-level `op` sets the default
 * op for every entry (homogeneous: same op, N targets); each entry may override
 * it with its own `op` (heterogeneous). Returns
 * `{ results: [{index, op, ok, result|error}], errors: [{index, op, error}] }`
 * — one entry's failure does NOT abort the rest.
 */
export const batchParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  op: batchOpSchema
    .optional()
    .describe(
      'Default op applied to every entry that does not set its own `op` (homogeneous batch).',
    ),
  ops: z
    .array(batchEntrySchema)
    .min(1)
    .describe(
      "Entries to execute in order. Each is the op's params; set a per-entry `op` to override the default.",
    ),
})

// ---------------------------------------------------------------------------
// Component index tools
// ---------------------------------------------------------------------------

export const searchComponentsParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
  query: z
    .string()
    .describe(
      'Search text matched against component name/description.',
    ),
  type: z
    .enum(['COMPONENT', 'COMPONENT_SET'])
    .optional()
    .describe('Filter by node type.'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max results (default 25).'),
})

export const reindexParamsSchema = z.object({
  ...fileTargetParamsSchema.shape,
})

// ---------------------------------------------------------------------------
// Feedback tool
// ---------------------------------------------------------------------------

/**
 * Params for `record_feedback`: record a piece of friction or a proposal into
 * the local feedback queue.
 */
export const recordFeedbackParamsSchema = z.object({
  category: z
    .enum(FEEDBACK_CATEGORIES)
    .describe(
      "Which feedback stream this belongs to. Routes to that stream's GitHub issue.",
    ),
  title: z
    .string()
    .describe(
      'One-line summary of the friction. Becomes the GitHub comment heading.',
    ),
  description: z
    .string()
    .describe(
      'What happened, in natural language — what you did, what you expected, what you got.',
    ),
  tool: z
    .string()
    .optional()
    .describe(
      'The tool/command involved, if this is tool-specific (e.g. "resize_node").',
    ),
})
