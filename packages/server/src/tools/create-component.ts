import type { FigmaClient } from '../figma-client'
import {
  type ToolResult,
  textResult,
  requireConnected,
  formatMutationResult,
} from './shared'

export const handleCreateComponent = async (
  params: {
    nodeId?: string
    nodeIds?: string[]
    combineAsVariants?: boolean
    slots?: string[]
    componentProperties?: {
      name: string
      type: string
      default: string | boolean
    }[]
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  if (
    !params.nodeId &&
    (!params.nodeIds || params.nodeIds.length === 0)
  ) {
    return textResult(
      'Error: Either nodeId or nodeIds must be provided.',
    )
  }

  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  const result = (await client.sendCommand(
    'create_component',
    {
      nodeId: params.nodeId,
      nodeIds: params.nodeIds,
      combineAsVariants: params.combineAsVariants,
      slots: params.slots,
      componentProperties: params.componentProperties,
    },
  )) as Record<string, unknown> | null

  return formatMutationResult(
    result,
    'Failed to create component.',
  )
}
