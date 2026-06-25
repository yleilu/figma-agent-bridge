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
// pointing the agent at create_tree (M3). This REPLACES the legacy create_node
// handler in tools/create.ts; that module stays intact because its sibling
// handleCreateTree (and the create-component / DS tools) still import the
// expression-parser path for M3.

import { COMMANDS } from '@figma-agent-bridge/shared'
import type { NodeSpec } from '@figma-agent-bridge/shared/node-spec'
import type { FigmaClient } from '../figma-client'
import { specToFigmaForCreate } from '../serialize/node-spec-writer'
import {
  type ToolResult,
  requireConnected,
  formatMutationResult,
  errorMessage,
  textResult,
} from './shared'

const CHILDREN_WARNING =
  'spec.children ignored — create_node creates a SINGLE node in M2; ' +
  'use create_tree for nested creation (M3).'

export const handleCreateNode = async (
  { spec, parentId }: { spec: NodeSpec; parentId?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    // M2 single-node: never recurse. Strip children before converting and
    // surface a warning so the agent knows nested creation is create_tree.
    const hasChildren =
      Array.isArray(spec.children) &&
      spec.children.length > 0
    const flat: NodeSpec = { ...spec }
    delete flat.children
    const payload = specToFigmaForCreate(flat)

    const result = (await client.sendCommand(
      COMMANDS.CREATE_NODE,
      { spec: payload, parentId },
    )) as { error?: string } | null

    const mutation = formatMutationResult(
      result,
      'Failed to create node.',
    )
    if (!hasChildren) {
      return mutation
    }
    // Append the children warning to a SUCCESSFUL mutation result. (If the
    // mutation errored, formatMutationResult already returned an Error: text —
    // do not muddy it with the children note.)
    if (mutation.content[0].text.startsWith('Error')) {
      return mutation
    }
    return textResult(
      `${mutation.content[0].text}\n\nWarning: ${CHILDREN_WARNING}`,
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
