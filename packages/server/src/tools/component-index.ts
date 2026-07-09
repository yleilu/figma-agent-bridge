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

/**
 * B3 — every command is addressed to exactly one file, never guessed. The
 * index is keyed by the file the plugin commands actually reach: the client's
 * connected file. So the caller's `fileId` MUST match `currentFileKey()`; a
 * mismatch means the agent should connect to that file first (we never key
 * data under the wrong file).
 */
const resolveTarget = (
  fileId: string,
  client: FigmaClient,
):
  | { ok: true; fileKey: string }
  | { ok: false; result: ToolResult } => {
  const current = client.currentFileKey()
  if (current === null) {
    return {
      ok: false,
      result: textResult(
        'Not connected to a specific file. Connect to a file first, then retry.',
      ),
    }
  }
  if (fileId !== current) {
    return {
      ok: false,
      result: textResult(
        `This tool operates on the connected file (${current}). ` +
          `To operate on ${fileId}, connect to that file first.`,
      ),
    }
  }
  return { ok: true, fileKey: current }
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
  const target = resolveTarget(fileId, client)
  if (!target.ok) {
    return target.result
  }
  try {
    const validType =
      type === 'COMPONENT' || type === 'COMPONENT_SET'
        ? type
        : undefined
    const out = await manager.search(
      target.fileKey,
      query,
      limit ?? DEFAULT_LIMIT,
      getComponentsVia(client),
      validType,
    )
    return textResult(
      YAML.stringify({
        results: out.results,
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
  const target = resolveTarget(fileId, client)
  if (!target.ok) {
    return target.result
  }
  try {
    const out = await manager.reindex(
      target.fileKey,
      getComponentsVia(client),
    )
    return textResult(YAML.stringify(out))
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
