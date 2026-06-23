import YAML from 'yaml'
import type { FigmaClient } from '../figma-client'
import {
  parseNode,
  toInspectTree,
  toInspectTreeMulti,
  toPageLayoutTree,
  toFullJson,
  truncateChildren,
} from '../parser'
import {
  type ToolResult,
  textResult,
  requireConnected,
} from './shared'

export const handleInspect = async (
  { nodeId }: { nodeId?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    if (nodeId !== undefined) {
      const raw = (await client.sendCommand('get_node', {
        nodeId,
      })) as Record<string, unknown> | null
      if (raw === null) {
        return textResult(`Node not found: ${nodeId}`)
      }
      const parsed = parseNode(raw)
      const tree = toInspectTree(parsed)
      return textResult(tree)
    }

    const selection = (await client.sendCommand(
      'get_selection',
      {},
    )) as
      | {
          id: string
          name: string
          type: string
        }[]
      | null
    if (selection === null || selection.length === 0) {
      return textResult(
        'No node selected. Select a node in Figma or provide a nodeId.',
      )
    }

    if (selection.length === 1) {
      const raw = (await client.sendCommand('get_node', {
        nodeId: selection[0].id,
      })) as Record<string, unknown> | null
      if (raw === null) {
        return textResult(
          `Node not found: ${selection[0].id}`,
        )
      }
      const parsed = parseNode(raw)
      const tree = toInspectTree(parsed)
      return textResult(tree)
    }

    // Multi-selection: fetch all nodes in parallel
    const raws = await Promise.all(
      selection.map(sel =>
        client.sendCommand('get_node', {
          nodeId: sel.id,
        }),
      ),
    )
    const failedIds = selection
      .filter((_, i) => raws[i] === null)
      .map(sel => sel.id)
    const parsedNodes = raws
      .filter(
        (raw): raw is Record<string, unknown> =>
          raw !== null,
      )
      .map(raw => parseNode(raw))

    const note =
      parsedNodes.length < selection.length
        ? `Note: failed to fetch ${failedIds.length} node(s): ${failedIds.join(', ')}\n\n`
        : ''

    // If only one node resolved, fall back to single-node format
    if (parsedNodes.length === 1) {
      const singleTree = toInspectTree(parsedNodes[0])
      return textResult(note + singleTree)
    }
    if (parsedNodes.length === 0) {
      return textResult(
        'No nodes could be fetched from selection.',
      )
    }

    const tree = toInspectTreeMulti(parsedNodes)
    return textResult(note + tree)
  } catch (err) {
    return textResult(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export const handleInspectPageLayout = async (
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const raw = (await client.sendCommand(
      'get_page_layout',
      {},
    )) as {
      pageName: string
      frames: Record<string, unknown>[]
    } | null
    if (raw === null) {
      return textResult(
        'Failed to get page layout from plugin.',
      )
    }

    const tree = toPageLayoutTree(raw)

    return textResult(tree)
  } catch (err) {
    return textResult(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export const handleGetNode = async (
  { nodeId, depth }: { nodeId: string; depth?: number },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const raw = (await client.sendCommand('get_node', {
      nodeId,
    })) as Record<string, unknown> | null
    if (raw === null) {
      return textResult(`Node not found: ${nodeId}`)
    }

    const json = toFullJson(raw, depth)

    return textResult(json)
  } catch (err) {
    return textResult(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export const handleGetNodes = async (
  { nodeIds, depth }: { nodeIds: string[]; depth?: number },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const raw = (await client.sendCommand('get_nodes', {
      nodeIds,
    })) as Record<string, unknown>[] | null
    if (raw === null) {
      return textResult('Failed to get nodes from plugin.')
    }

    if (!Array.isArray(raw)) {
      return textResult('Unexpected response from plugin')
    }

    const effectiveDepth = depth ?? 3
    const truncated = raw.map(node =>
      truncateChildren(node, effectiveDepth, 0),
    )
    const json = JSON.stringify(truncated, null, 2)

    return textResult(json)
  } catch (err) {
    return textResult(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export const handleListPages = async (
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const raw = (await client.sendCommand(
      'get_pages',
      {},
    )) as
      | {
          id: string
          name: string
          isCurrent: boolean
          childCount: number
        }[]
      | null
    if (raw === null) {
      return textResult('Failed to get pages from plugin.')
    }

    const header = `# ${raw.length} pages\n\n`
    const yamlStr = YAML.stringify(
      raw.map(p => ({
        id: p.id,
        name: p.name,
        current: p.isCurrent,
        frames: p.childCount,
      })),
    )

    return textResult(header + yamlStr)
  } catch (err) {
    return textResult(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
