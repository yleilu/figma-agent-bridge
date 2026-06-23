import type { FigmaClient } from '../figma-client'
import { toStylesTree, toComponentsTree } from '../parser'
import {
  type ToolResult,
  textResult,
  requireConnected,
} from './shared'

export const handleInspectStyles = async (
  { type }: { type?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  const raw = (await client.sendCommand(
    'get_styles',
    {},
  )) as {
    paint: Record<string, unknown>[]
    text: Record<string, unknown>[]
    effect: Record<string, unknown>[]
    grid: Record<string, unknown>[]
  } | null

  if (raw === null) {
    return textResult('Failed to get styles from plugin.')
  }

  if (type !== undefined) {
    const validTypes = ['paint', 'text', 'effect', 'grid']
    if (!validTypes.includes(type)) {
      return textResult(
        `Invalid style type: "${type}". Must be one of: ${validTypes.join(', ')}`,
      )
    }

    const filtered = {
      paint: [] as Record<string, unknown>[],
      text: [] as Record<string, unknown>[],
      effect: [] as Record<string, unknown>[],
      grid: [] as Record<string, unknown>[],
      [type]: raw[type as keyof typeof raw],
    }

    return textResult(toStylesTree(filtered))
  }

  return textResult(toStylesTree(raw))
}

export const handleInspectComponents = async (
  { query }: { query?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  const raw = (await client.sendCommand(
    'get_local_components',
    {},
  )) as {
    local: Record<string, unknown>[]
    remote: Record<string, unknown>[]
  } | null

  if (raw === null) {
    return textResult(
      'Failed to get components from plugin.',
    )
  }

  if (query !== undefined) {
    if (
      !Array.isArray(raw.local) ||
      !Array.isArray(raw.remote)
    ) {
      return textResult('Unexpected response from plugin')
    }
    const escaped = query
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
    const regex = new RegExp(escaped, 'i')
    const filtered = {
      local: raw.local.filter(c =>
        regex.test(c.name as string),
      ),
      remote: raw.remote.filter(c =>
        regex.test(c.name as string),
      ),
    }

    return textResult(toComponentsTree(filtered))
  }

  return textResult(toComponentsTree(raw))
}
