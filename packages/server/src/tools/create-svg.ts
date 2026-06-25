import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '../figma-client'
import {
  type ToolResult,
  textResult,
  requireConnected,
  formatMutationResult,
  errorMessage,
} from './shared'

export const handleCreateFromSvg = async (
  params: {
    parentId: string
    svg: string
    name?: string
    size?: [number, number]
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

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
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
