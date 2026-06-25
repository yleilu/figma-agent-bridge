// tools/update.ts — the single mutation: update_node.
//
// Consumes a Partial<NodeSpec> patch, converts it on the grammar WRITE FACE
// via specToFigma (PURE — only supplied keys, no defaults → omitted-untouched
// partial semantics), forwards it to the plugin, and reports through
// formatMutationResult so a plugin-side {error} is surfaced as an error and
// any warnings[] (e.g. the auto-layout x/y no-op) ride along on success.

import { COMMANDS } from '@figma-agent-bridge/shared'
import type { NodeSpec } from '@figma-agent-bridge/shared/node-spec'
import type { FigmaClient } from '../figma-client'
import { specToFigma } from '../serialize/node-spec-writer'
import {
  type ToolResult,
  requireConnected,
  formatMutationResult,
  errorMessage,
  textResult,
} from './shared'

export const handleUpdateNode = async (
  {
    nodeId,
    patch,
  }: { nodeId: string; patch: Partial<NodeSpec> },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    // The writer pushes lossy-conversion notes (e.g. per-side stroke collapse)
    // onto `warnings`.
    const warnings: string[] = []
    const spec = specToFigma(patch, warnings)
    const result = (await client.sendCommand(
      COMMANDS.UPDATE_NODE,
      { nodeId, spec },
    )) as { error?: string } | null
    const mutation = formatMutationResult(
      result,
      `Failed to update node: ${nodeId}`,
    )
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
