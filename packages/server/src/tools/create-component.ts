import type { FigmaClient } from '../figma-client'

type ToolResult = {
  content: { type: 'text'; text: string }[]
}

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
  if (!params.nodeId && !params.nodeIds) {
    return {
      content: [{ type: 'text' as const, text: 'Error: Either nodeId or nodeIds must be provided.' }],
    }
  }

  if (!client.isConnected()) {
    return {
      content: [
        {
          type: 'text',
          text: 'Not connected to Figma. Use connect tool first.',
        },
      ],
    }
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

  if (result === null) {
    return {
      content: [
        {
          type: 'text',
          text: 'Failed to create component.',
        },
      ],
    }
  }

  if (result.error !== undefined) {
    return {
      content: [
        { type: 'text', text: `Error: ${result.error}` },
      ],
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  }
}
