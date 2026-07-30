// tools/update.ts — the single mutation: update_node.
//
// Consumes a NodeSpecPatch (a partial NodeSpec, `text` struct included),
// converts it on the grammar WRITE FACE
// via specToFigma (PURE — only supplied keys, no defaults → omitted-untouched
// partial semantics), forwards it to the plugin, and reports through
// formatMutationResult so a plugin-side {error} is surfaced as an error and
// any warnings[] (e.g. the auto-layout x/y no-op) ride along on success.

import { COMMANDS } from '@figma-agent-bridge/shared'
import type { NodeSpecPatch } from '@figma-agent-bridge/shared/node-spec'
import type { ScopedFigmaClient } from '../figma-client'
import {
  specToFigma,
  unknownPatchKeyWarnings,
} from '../serialize/node-spec-writer'
import { assertContextWithinCap } from '../serialize/context-cap'
import {
  type ToolResult,
  formatMutationResult,
  toolError,
  isErrorResult,
  textResult,
} from './shared'

export const handleUpdateNode = async (
  {
    nodeId,
    patch,
  }: { nodeId: string; patch: NodeSpecPatch },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  try {
    assertContextWithinCap(patch)
    // The writer pushes lossy-conversion notes (e.g. per-side stroke collapse)
    // onto `warnings`.
    const warnings: string[] = []
    const spec = specToFigma(patch, warnings)
    // A key the write face does not know is DROPPED, not applied — say so
    // rather than reporting a success that moved nothing (T7).
    warnings.push(...unknownPatchKeyWarnings(patch, spec))
    const result = (await client.sendCommand(
      COMMANDS.UPDATE_NODE,
      { nodeId, spec },
    )) as { error?: string; warnings?: string[] } | null
    const mutation = formatMutationResult(
      result,
      `Failed to update node: ${nodeId}`,
    )
    if (warnings.length === 0 || isErrorResult(mutation)) {
      return mutation
    }
    // Merge the server-side writer warnings INTO the reply's structured
    // warnings[] (one concept, one surface) rather than appending loose text
    // after the JSON. The success reply is always a JSON object here.
    const merged = {
      ...result,
      warnings: [...(result?.warnings ?? []), ...warnings],
    }
    return textResult(JSON.stringify(merged, null, 2))
  } catch (err) {
    return toolError(err)
  }
}
