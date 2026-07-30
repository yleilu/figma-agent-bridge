import { COMMANDS } from '@figma-agent-bridge/shared'
import type { ScopedFigmaClient } from '../figma-client'
import {
  type ToolResult,
  formatMutationResult,
  toolError,
} from './shared'

export const handleCreateFromSvg = async (
  params: {
    parentId: string
    svg: string
    name?: string
    size?: [number, number]
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  try {
    const result = (await client.sendCommand(
      COMMANDS.CREATE_FROM_SVG,
      {
        parentId: params.parentId,
        svg: params.svg,
        name: params.name,
        size: params.size,
      },
    )) as Record<string, unknown> | null

    return formatMutationResult(
      result,
      'Failed to create from SVG.',
    )
  } catch (err) {
    return toolError(err)
  }
}
