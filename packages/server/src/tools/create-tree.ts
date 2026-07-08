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
import type { FigmaClient } from '../figma-client'
import {
  specToFigmaForCreate,
  type FigmaWritePayload,
} from '../serialize/node-spec-writer'
import { CREATABLE_TYPES } from './create-node'
import { assertContextWithinCap } from '../serialize/context-cap'
import {
  type ToolResult,
  requireConnected,
  formatMutationResult,
  errorMessage,
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
 * a per-side stroke collapse) push onto it so the handler can surface them.
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
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const warnings: string[] = []
    const convertedTree = convertTree(tree, warnings)
    const convertedRefs =
      refs !== undefined
        ? convertRefs(refs, warnings)
        : undefined

    const result = (await client.sendCommand(
      COMMANDS.CREATE_TREE,
      {
        tree: convertedTree,
        parentId,
        refs: convertedRefs,
      },
    )) as { error?: string } | null

    const mutation = formatMutationResult(
      result,
      'Failed to create tree.',
    )
    // Append any lossy-conversion warnings to a SUCCESSFUL result. (On error,
    // formatMutationResult already returned an Error: text — leave it clean.)
    if (
      warnings.length === 0 ||
      mutation.content[0].text.startsWith('Error')
    ) {
      return mutation
    }
    const warningText = warnings
      .map(w => `Warning: ${w}`)
      .join('\n')
    return textResult(
      `${mutation.content[0].text}\n\n${warningText}`,
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
