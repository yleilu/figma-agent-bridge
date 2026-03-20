import type { FigmaClient } from '../figma-client'
import { toSearchYaml } from '../parser'

type ToolResult = {
  content: { type: 'text'; text: string }[]
}

export const handleSearch = async (
  params: {
    name?: string
    type?: string
    pageId?: string
    limit?: number
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

  const pluginParams: Record<string, unknown> = {}
  if (params.name !== undefined) {
    pluginParams.name = params.name
  }
  if (params.type !== undefined) {
    pluginParams.type = params.type
  }
  if (params.pageId !== undefined) {
    pluginParams.pageId = params.pageId
  }
  pluginParams.limit = params.limit ?? 50

  const raw = (await client.sendCommand(
    'search_nodes',
    pluginParams,
  )) as {
    results: {
      id: string
      name: string
      type: string
      page: string
      parent: string
      width: number
      height: number
    }[]
    truncated: boolean
  } | null

  if (raw === null) {
    return {
      content: [
        {
          type: 'text',
          text: 'Search failed: no response from plugin.',
        },
      ],
    }
  }

  const mapped = raw.results.map(r => ({
    id: r.id,
    name: r.name,
    type: r.type,
    page: r.page,
    parent: r.parent,
    size: [r.width, r.height] as [number, number],
  }))

  return {
    content: [
      {
        type: 'text',
        text: toSearchYaml(mapped, raw.truncated),
      },
    ],
  }
}
