import type { FigmaClient } from '../figma-client'

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
}

export const handleConnect = async (
  params: { channel: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const { channel } = params

  try {
    await client.joinChannel(channel)

    return {
      content: [
        {
          type: 'text',
          text: `Connected to channel: ${channel}`,
        },
      ],
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err)

    return {
      content: [
        {
          type: 'text',
          text: `Error: ${message}`,
        },
      ],
    }
  }
}

export const handleStatus = async (
  client: FigmaClient,
): Promise<ToolResult> => {
  if (!client.isConnected()) {
    return {
      content: [
        {
          type: 'text',
          text: 'disconnected',
        },
      ],
    }
  }

  const channel = client.currentChannel()

  return {
    content: [
      {
        type: 'text',
        text: `connected to channel: ${channel}`,
      },
    ],
  }
}
