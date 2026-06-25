// tools/structure.ts — write-structure tools.
//
// delete_node: COMMANDS.DELETE_NODE with {nodeId} → {id,name,type} (captured
//   before removal). A node-not-found plugin {error} surfaces as an error.
// set_focus: COMMANDS.SET_FOCUS with {nodeIds} → {viewport}. This moves the
//   CANVAS only (scroll + zoom) — it does NOT change the selection (pair with
//   set_selection for that).
//
// Both route through formatMutationResult: null → failure text, {error} → an
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
