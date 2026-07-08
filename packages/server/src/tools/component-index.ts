import YAML from 'yaml'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '../figma-client'
import type { IndexManager } from '../component-index/manager'
import {
  requireConnected,
  textResult,
  errorMessage,
  type ToolResult,
} from './shared'

const DEFAULT_LIMIT = 25

const getComponentsVia =
  (client: FigmaClient) => async () => {
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
    fileId,
    query,
    type,
    limit,
  }: {
    fileId: string
    query: string
    type?: string
    limit?: number
  },
  client: FigmaClient,
  manager: IndexManager,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }
  try {
    const out = await manager.search(
      fileId,
      query,
      limit ?? DEFAULT_LIMIT,
      getComponentsVia(client),
    )
    const filtered = type
      ? out.results.filter(r => r.type === type)
      : out.results
    return textResult(
      YAML.stringify({
        results: filtered,
        indexState: out.indexState,
        truncated: out.truncated,
      }),
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

export const handleReindex = async (
  { fileId }: { fileId: string },
  client: FigmaClient,
  manager: IndexManager,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }
  try {
    const out = await manager.reindex(
      fileId,
      getComponentsVia(client),
    )
    return textResult(YAML.stringify(out))
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
