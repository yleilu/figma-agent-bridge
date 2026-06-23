import type { FigmaClient } from '../figma-client'
import { toSearchYaml } from '../parser'
import {
  type ToolResult,
  textResult,
  requireConnected,
} from './shared'

export const handleSearch = async (
  params: {
    name?: string
    type?: string
    pageId?: string
    limit?: number
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
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

  try {
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
      return textResult(
        'Search failed: no response from plugin.',
      )
    }

    const mapped = raw.results.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      page: r.page,
      parent: r.parent,
      size: [r.width, r.height] as [number, number],
    }))

    return textResult(toSearchYaml(mapped, raw.truncated))
  } catch (err) {
    return textResult(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
