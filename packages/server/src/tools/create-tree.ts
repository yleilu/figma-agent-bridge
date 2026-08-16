// tools/create-tree.ts — the M3 recursive create (REBUILD, replaces the legacy
// handleCreateTree in tools/create.ts).
//
// Consumes a TreeNodeSpec (a NodeSpec with recursive `children`, a ref-pool
// reference `{ ref }`, or a clone-by-id `{ id }`) plus an optional `refs`
// ref-pool. Converts every plain NodeSpec node on the grammar WRITE FACE via
// specToFigmaForCreate (atom leaves parsed; name ?? type fallback), recursing
// into children. `{ ref }` and `{ id }` nodes pass through as bare markers the
// plugin resolves (ref → re-convert refs[key]; id → clone the existing node).
//
// The CONVERTED tree is forwarded to COMMANDS.CREATE_TREE with { tree, parentId?,
// refs? } where `refs` is the converted ref-pool. The plugin walks the nested
// tree: creates each node by type, appendChild, then applyPostAppendProperties
// (FILL/ABSOLUTE) per level, loadFontAsync before text. Reports through
// formatMutationResult so a plugin {error} surfaces as an error.
//
// REF-POOL + ORDERING:
//   - `{ ref: key }`  → the plugin re-builds refs[key] (a fresh subtree each
//     reuse) — kept as a marker so a ref used N times yields N independent
//     subtrees, not N shared references to one node.
//   - `{ id: x }`     → the plugin clones the existing node x (COMPONENT →
//     INSTANCE, else .clone()).
//   - append-before-FILL ordering is NOT re-implemented here: the converter
//     produces the partitioned payload the plugin's three-phase apply already
//     honors (common props → appendChild → applyPostAppendProperties for
//     sizing FILL / layoutPositioning ABSOLUTE), and loadFontAsync runs before
//     any text write, exactly as create_node does — per level, depth-first.

import { COMMANDS } from '@figma-agent-bridge/shared'
import type {
  TreeNodeSpec,
  RefPool,
  NodeSpec,
} from '@figma-agent-bridge/shared/node-spec'
import type { ScopedFigmaClient } from '../figma-client'
import {
  specToFigmaForCreate,
  type FigmaWritePayload,
} from '../serialize/node-spec-writer'
import { CREATABLE_TYPES } from './create-node'
import { assertContextWithinCap } from '../serialize/context-cap'
import { sendConvertedWrite } from '../serialize/style-refs'
import {
  type ToolResult,
  formatMutationResult,
  isErrorResult,
  toolError,
  textResult,
} from './shared'

/** A `{ ref }` pool reference (re-built fresh on each reuse). */
const isRefNode = (
  spec: TreeNodeSpec,
): spec is { ref: string } =>
  'ref' in spec && typeof spec.ref === 'string'

/** A `{ id }` clone-by-id reference. */
const isCloneNode = (
  spec: TreeNodeSpec,
): spec is { id: string } =>
  'id' in spec &&
  typeof spec.id === 'string' &&
  !('type' in spec)

/**
 * Recursively convert a TreeNodeSpec to a converted FigmaWritePayload tree.
 *
 * - `{ ref }` / `{ id }` markers pass through unchanged (the plugin resolves
 *   them at build time — ref re-builds refs[key], id clones node x).
 * - a plain node is converted via specToFigmaForCreate, then its `children`
 *   are recursively converted and re-attached.
 *
 * `warnings` is an optional sink: lossy conversions anywhere in the tree (e.g.
 * a `var()` wrapper the surface cannot bind) push onto it so the handler can
 * surface them.
 */
export const convertTree = (
  spec: TreeNodeSpec,
  warnings?: string[],
): FigmaWritePayload => {
  if (isRefNode(spec)) {
    return { ref: spec.ref }
  }
  if (isCloneNode(spec)) {
    return { id: spec.id }
  }

  // A plain node: validate its type against the SAME CREATABLE_TYPES list
  // create_node uses (single source of truth — issue #2) so both create APIs
  // accept exactly the same node types. This rejects the unspecced
  // composite-via-children family (BOOLEAN_OPERATION, GROUP, TRANSFORM_GROUP)
  // with one clear error. `{ ref }` / `{ id }` nodes returned ABOVE this guard:
  // they reference/clone existing nodes (not new types) and pass through.
  const node = spec as NodeSpec & {
    children?: TreeNodeSpec[]
  }
  assertContextWithinCap(node)
  if (
    !(CREATABLE_TYPES as readonly string[]).includes(
      node.type,
    )
  ) {
    throw new Error(
      `Unsupported node type "${node.type}" in create_tree. ` +
        `Valid types: ${CREATABLE_TYPES.join(', ')}. ` +
        `(Booleans: create the shapes then use boolean_op.)`,
    )
  }
  const { children, ...flat } = node
  const converted = specToFigmaForCreate(flat, warnings)
  if (children !== undefined && children.length > 0) {
    converted.children = children.map(child =>
      convertTree(child, warnings),
    )
  }
  return converted
}

/** Convert every entry of the ref-pool to its converted payload form. */
const convertRefs = (
  refs: RefPool,
  warnings?: string[],
): Record<string, FigmaWritePayload> => {
  const out: Record<string, FigmaWritePayload> = {}
  for (const [key, value] of Object.entries(refs)) {
    out[key] = convertTree(value, warnings)
  }
  return out
}

/**
 * The tool-surface reply: `{root, ids[]}` (tool-surface.md). The plugin builds
 * N nodes and answers in the create_node family (`{id,name,type}`) plus the
 * `ids[]` it collected as it built; the tool surface is where that becomes the
 * declared shape, so the two cannot disagree about it in two places.
 *
 * `ids[]` is EVERY node this call created — the root first, then depth-first in
 * creation order — which is the whole point: a tree's non-root nodes are
 * otherwise unaddressable without a follow-up read.
 *
 * A plugin that reports no `ids` gets the root alone AND a warning (T7): the
 * agent is told its harvest is incomplete rather than being handed a short list
 * that looks complete.
 */
const shapeReply = (
  result: {
    error?: string
    id?: string
    name?: string
    type?: string
    ids?: string[]
    warnings?: string[]
  } | null,
  warnings: string[],
):
  | (Record<string, unknown> & { error?: string })
  | null => {
  if (
    result === null ||
    result.error !== undefined ||
    result.id === undefined
  ) {
    return result
  }
  // `warnings` is pulled out and dropped here on purpose: the caller has
  // already merged it into the shared list that gets rendered as `Warning:`
  // lines. Leaving it in `rest` would spread it into the JSON body too and
  // report every degrade twice.
  const {
    id,
    name,
    type,
    ids,
    warnings: pluginWarnings,
    ...rest
  } = result
  void pluginWarnings
  if (!Array.isArray(ids)) {
    warnings.push(
      'the plugin reported no created ids — only the root is addressable from this reply; re-read the subtree to address its children',
    )
  }
  return {
    ...rest,
    root: { id, name, type },
    ids: Array.isArray(ids) ? ids : [id],
  }
}

export const handleCreateTree = async (
  {
    tree,
    parentId,
    refs,
  }: {
    tree: TreeNodeSpec
    parentId?: string
    refs?: RefPool
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  try {
    const warnings: string[] = []
    const convertedTree = convertTree(tree, warnings)
    const convertedRefs =
      refs !== undefined
        ? convertRefs(refs, warnings)
        : undefined
    // sendConvertedWrite walks the WHOLE payload — every node of the tree and
    // every ref-pool entry — against one style read, so a reference that
    // resolves to nothing stops the write before the first node is created,
    // not after forty of them.
    const result = (await sendConvertedWrite(
      client,
      COMMANDS.CREATE_TREE,
      {
        tree: convertedTree,
        parentId,
        refs: convertedRefs,
      },
      { warnings },
    )) as {
      error?: string
      id?: string
      name?: string
      type?: string
      ids?: string[]
      warnings?: string[]
    } | null

    // Plugin-side degrades (T7) join the server's own lossy-conversion notes in
    // ONE list. The plugin can only degrade at write time — a `sizing:['FILL',…]`
    // Figma refuses on a child of a SLOT, an x/y the auto-layout parent
    // overwrites — and the caller sees a single reply for the whole subtree, so
    // if these are not merged here they are lost.
    if (Array.isArray(result?.warnings)) {
      warnings.push(...result.warnings)
    }

    const mutation = formatMutationResult(
      shapeReply(result, warnings),
      'Failed to create tree.',
    )
    // Append any lossy-conversion warnings to a SUCCESSFUL result. (On error,
    // formatMutationResult already returned the error envelope — leave it
    // clean.)
    if (warnings.length === 0 || isErrorResult(mutation)) {
      return mutation
    }
    const warningText = warnings
      .map(w => `Warning: ${w}`)
      .join('\n')
    return textResult(
      `${mutation.content[0].text}\n\n${warningText}`,
    )
  } catch (err) {
    return toolError(err)
  }
}
