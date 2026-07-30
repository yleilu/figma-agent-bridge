// tools/create-node.ts — the M2 single-node create.
//
// Consumes a full NodeSpec, converts it on the grammar WRITE FACE via
// specToFigmaForCreate (atom leaves parsed; name ?? type fallback), forwards
// it to COMMANDS.CREATE_NODE with an optional parentId, and reports through
// formatMutationResult so a plugin {error} surfaces as an error and any
// warnings[] ride along on success.
//
// Children are OUT OF SCOPE for M2 (single-node). When spec.children is
// present we strip it before converting (no recursion) and append a warning
// pointing the agent at create_tree (M3). This is the canonical create_node
// handler (the legacy tools/create.ts was retired in M3-E). Lossy conversions
// in the writer (e.g. per-side stroke weights collapsing) push onto the same
// warnings sink, so the agent sees them alongside the children note.

import { COMMANDS } from '@figma-agent-bridge/shared'
import type { NodeSpec } from '@figma-agent-bridge/shared/node-spec'
import type { ScopedFigmaClient } from '../figma-client'
import { specToFigmaForCreate } from '../serialize/node-spec-writer'
import { assertContextWithinCap } from '../serialize/context-cap'
import {
  type ToolResult,
  formatMutationResult,
  toolError,
  errorEnvelope,
  isErrorResult,
  textResult,
} from './shared'

const CHILDREN_WARNING =
  'spec.children ignored — create_node creates a SINGLE node in M2; ' +
  'use create_tree for nested creation (M3).'

// The node types create_node can build (mirrors the plugin's createSingleNode
// switch). Validated at the SERVER boundary so an unsupported type returns a
// clean {error} listing the valid surface, not a deep generic plugin throw.
// EXPORTED as the single source of truth: create_tree imports the SAME array so
// the two create APIs accept exactly the same node types (issue #2). This also
// rejects the unspecced composite-via-children family (BOOLEAN_OPERATION, GROUP,
// TRANSFORM_GROUP) consistently — booleans are made via the boolean_op tool.
// TEXT_PATH is likewise excluded (issue #3): figma.createTextPath is real but its
// fields (vectorNodeId/startSegment/startPosition) were never specced/wired, so it
// is honest-rejected here pending the spec-completeness phase — see
// docs/deferred-capabilities.md.
export const CREATABLE_TYPES = [
  'FRAME',
  'RECTANGLE',
  'ELLIPSE',
  'TEXT',
  'LINE',
  'POLYGON',
  'STAR',
  'VECTOR',
  'SECTION',
  'SLICE',
  'INSTANCE',
  'SLOT',
] as const

export const handleCreateNode = async (
  { spec, parentId }: { spec: NodeSpec; parentId?: string },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  if (
    !(CREATABLE_TYPES as readonly string[]).includes(
      spec.type,
    )
  ) {
    return errorEnvelope(
      'UNSUPPORTED_NODE_TYPE',
      `Unsupported node type "${spec.type}". Valid types: ${CREATABLE_TYPES.join(', ')}.`,
    )
  }

  try {
    assertContextWithinCap(spec)
    // M2 single-node: never recurse. Strip children before converting and
    // surface a warning so the agent knows nested creation is create_tree.
    const warnings: string[] = []
    const hasChildren =
      Array.isArray(spec.children) &&
      spec.children.length > 0
    if (hasChildren) {
      warnings.push(CHILDREN_WARNING)
    }
    const flat: NodeSpec = { ...spec }
    delete flat.children
    // The writer pushes lossy-conversion notes (e.g. per-side stroke collapse)
    // onto `warnings`.
    const payload = specToFigmaForCreate(flat, warnings)

    const result = (await client.sendCommand(
      COMMANDS.CREATE_NODE,
      { spec: payload, parentId },
    )) as { error?: string } | null

    const mutation = formatMutationResult(
      result,
      'Failed to create node.',
    )
    if (warnings.length === 0) {
      return mutation
    }
    // Append the warnings to a SUCCESSFUL mutation result. (If the mutation
    // errored, formatMutationResult already returned the error envelope — do
    // not muddy it with the warning notes.)
    if (isErrorResult(mutation)) {
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
