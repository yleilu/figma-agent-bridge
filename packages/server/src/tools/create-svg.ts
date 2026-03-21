import type { FigmaClient } from '../figma-client'

type ToolResult = {
  content: { type: 'text'; text: string }[]
}

export const handleCreateFromSvg = async (
  params: {
    parentId: string
    svg: string
    name?: string
    size?: [number, number]
  },
  client: FigmaClient,
): Promise<ToolResult> => {
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
    'create_from_svg',
    {
      parentId: params.parentId,
      svg: params.svg,
      name: params.name,
      size: params.size,
    },
  )) as Record<string, unknown> | null

  if (result === null) {
    return {
      content: [
        {
          type: 'text',
          text: 'Failed to create from SVG.',
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
