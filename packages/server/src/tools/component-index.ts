import { COMMANDS } from '@figma-agent-bridge/shared'
import type { ScopedFigmaClient } from '../figma-client'
import type { IndexManager } from '../component-index/manager'
import {
  textResult,
  errorMessage,
  type ToolResult,
} from './shared'

const DEFAULT_LIMIT = 25

const getComponentsVia =
  (client: ScopedFigmaClient) => async () => {
    const raw = (await client.sendCommand(
      COMMANDS.GET_COMPONENTS,
      { includeRemote: false },
    )) as {
      local?: unknown
      remote?: unknown
      error?: string
    } | null
    if (raw === null) {
      throw new Error(
        'Failed to get components from plugin.',
      )
    }
    if (raw.error !== undefined) {
      throw new Error(raw.error)
    }
    return { local: raw.local, remote: raw.remote }
  }

export const handleSearchComponents = async (
  {
    query,
    type,
    limit,
  }: {
    query: string
    type?: string
    limit?: number
  },
  client: ScopedFigmaClient,
  manager: IndexManager,
): Promise<ToolResult> => {
  try {
    const validType =
      type === 'COMPONENT' || type === 'COMPONENT_SET'
        ? type
        : undefined
    const out = await manager.search(
      client.fileKey,
      query,
      limit ?? DEFAULT_LIMIT,
      getComponentsVia(client),
      validType,
    )
    return textResult(
      JSON.stringify(
        {
          results: out.results,
          indexState: out.indexState,
          truncated: out.truncated,
        },
        null,
        2,
      ),
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

export const handleReindex = async (
  _params: Record<string, never>,
  client: ScopedFigmaClient,
  manager: IndexManager,
): Promise<ToolResult> => {
  try {
    const out = await manager.reindex(
      client.fileKey,
      getComponentsVia(client),
    )
    return textResult(JSON.stringify(out, null, 2))
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
