// tools/selection.ts — the get_selection / set_selection twin.
//
// get_selection (read): COMMANDS.GET_SELECTION → [{id,name,type}] as YAML.
// set_selection (write): COMMANDS.SET_SELECTION with {nodeIds} → {selectedCount}
// reported through formatMutationResult. set_selection is SELECTION ONLY — it
// does not scroll the canvas (pair with set_focus for that).

import YAML from 'yaml'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { ScopedFigmaClient } from '../figma-client'
import {
  type ToolResult,
  textResult,
  formatMutationResult,
  errorMessage,
} from './shared'

export const handleGetSelection = async (
  _params: Record<string, never>,
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  try {
    const raw = (await client.sendCommand(
      COMMANDS.GET_SELECTION,
      {},
    )) as
      | { id: string; name: string; type: string }[]
      | null
    if (raw === null) {
      return textResult(
        'Failed to get selection from plugin.',
      )
    }
    return textResult(YAML.stringify(raw))
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

export const handleSetSelection = async (
  { nodeIds }: { nodeIds: string[] },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  try {
    const result = (await client.sendCommand(
      COMMANDS.SET_SELECTION,
      { nodeIds },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to set selection.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
