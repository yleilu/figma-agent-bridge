// tools/structure.ts — write-structure tools.
//
// delete_node: COMMANDS.DELETE_NODE with {nodeId} → {id,name,type} (captured
//   before removal). A node-not-found plugin {error} surfaces as an error.
// set_focus: COMMANDS.SET_FOCUS with {nodeIds} → {viewport}. This moves the
//   CANVAS only (scroll + zoom) — it does NOT change the selection (pair with
//   set_selection for that).
// clone_node: COMMANDS.CLONE_NODE with {nodeId,parentId?,index?,count?} →
//   [{id,…}] (one entry per clone). Plugin node.clone() + optional reparent/
//   index/count.
// reparent_node: COMMANDS.REPARENT_NODE with {nodeId,parentId,index?} →
//   {id,…,parentId}. Plugin appendChild / insertChild (re-flows under the new
//   parent).
// reorder_children: COMMANDS.REORDER_CHILDREN with {parentId,nodeIds[]} →
//   {parentId,order,warnings[]}. Plugin reorders via insertChild; the id-set is
//   set-equality validated (warn on mismatch, T7 — never throw).
// boolean_op: COMMANDS.BOOLEAN_OP with {op,nodeIds[],parentId?} → {id,…}.
//   Plugin figma.union/subtract/intersect/exclude → BooleanOperationNode.
// flatten: COMMANDS.FLATTEN with {nodeIds[],parentId?} → {id,…}. Plugin
//   figma.flatten.
//
// All route through formatMutationResult: null → failure text, {error} → an
// error, otherwise JSON.stringify of the plugin reply.

import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '../figma-client'
import {
  type ToolResult,
  textResult,
  requireConnected,
  formatMutationResult,
  errorMessage,
} from './shared'

export const handleDeleteNode = async (
  { nodeId }: { nodeId: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.DELETE_NODE,
      { nodeId },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to delete node.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

export const handleSetFocus = async (
  { nodeIds }: { nodeIds: string[] },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.SET_FOCUS,
      { nodeIds },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to set focus.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

export const handleCloneNode = async (
  {
    nodeId,
    parentId,
    index,
    count,
  }: {
    nodeId: string
    parentId?: string
    index?: number
    count?: number
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.CLONE_NODE,
      { nodeId, parentId, index, count },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to clone node.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

export const handleReparentNode = async (
  {
    nodeId,
    parentId,
    index,
  }: {
    nodeId: string
    parentId: string
    index?: number
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.REPARENT_NODE,
      { nodeId, parentId, index },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to reparent node.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

export const handleReorderChildren = async (
  {
    parentId,
    nodeIds,
  }: { parentId: string; nodeIds: string[] },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.REORDER_CHILDREN,
      { parentId, nodeIds },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to reorder children.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

export const handleBooleanOp = async (
  {
    op,
    nodeIds,
    parentId,
  }: {
    op: 'UNION' | 'SUBTRACT' | 'INTERSECT' | 'EXCLUDE'
    nodeIds: string[]
    parentId?: string
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.BOOLEAN_OP,
      { op, nodeIds, parentId },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to perform boolean operation.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

export const handleFlatten = async (
  {
    nodeIds,
    parentId,
  }: { nodeIds: string[]; parentId?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.FLATTEN,
      { nodeIds, parentId },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to flatten nodes.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
