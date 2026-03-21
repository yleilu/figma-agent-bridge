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

type ToolResult = {
  content: { type: 'text'; text: string }[]
}

export const handleInspect = async (
  { nodeId }: { nodeId?: string },
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

  if (nodeId !== undefined) {
    const raw = (await client.sendCommand('get_node', {
      nodeId,
    })) as Record<string, unknown> | null
    if (raw === null) {
      return {
        content: [
          {
            type: 'text',
            text: `Node not found: ${nodeId}`,
          },
        ],
      }
    }
    const parsed = parseNode(raw)
    const tree = toInspectTree(parsed)
    return { content: [{ type: 'text', text: tree }] }
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
    return {
      content: [
        {
          type: 'text',
          text: 'No node selected. Select a node in Figma or provide a nodeId.',
        },
      ],
    }
  }

  if (selection.length === 1) {
    const raw = (await client.sendCommand('get_node', {
      nodeId: selection[0].id,
    })) as Record<string, unknown> | null
    if (raw === null) {
      return {
        content: [
          {
            type: 'text',
            text: `Node not found: ${selection[0].id}`,
          },
        ],
      }
    }
    const parsed = parseNode(raw)
    const tree = toInspectTree(parsed)
    return { content: [{ type: 'text', text: tree }] }
  }

  // Multi-selection: fetch all nodes in parallel
  const raws = await Promise.all(
    selection.map(sel =>
      client.sendCommand('get_node', {
        nodeId: sel.id,
      }),
    ),
  )
  const parsedNodes = raws
    .filter(
      (raw): raw is Record<string, unknown> => raw !== null,
    )
    .map(raw => parseNode(raw))

  // If only one node resolved, fall back to single-node format
  if (parsedNodes.length === 1) {
    const singleTree = toInspectTree(parsedNodes[0])
    return {
      content: [{ type: 'text', text: singleTree }],
    }
  }
  if (parsedNodes.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'No nodes could be fetched from selection.',
        },
      ],
    }
  }

  const tree = toInspectTreeMulti(parsedNodes)
  return { content: [{ type: 'text', text: tree }] }
}

export const handleInspectPageLayout = async (
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

  const raw = (await client.sendCommand(
    'get_page_layout',
    {},
  )) as {
    pageName: string
    frames: Record<string, unknown>[]
  } | null
  if (raw === null) {
    return {
      content: [
        {
          type: 'text',
          text: 'Failed to get page layout from plugin.',
        },
      ],
    }
  }

  const tree = toPageLayoutTree(raw)

  return { content: [{ type: 'text', text: tree }] }
}

export const handleGetNode = async (
  { nodeId, depth }: { nodeId: string; depth?: number },
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

  const raw = (await client.sendCommand('get_node', {
    nodeId,
  })) as Record<string, unknown> | null
  if (raw === null) {
    return {
      content: [
        { type: 'text', text: `Node not found: ${nodeId}` },
      ],
    }
  }

  const json = toFullJson(raw, depth)

  return { content: [{ type: 'text', text: json }] }
}

export const handleGetNodes = async (
  { nodeIds, depth }: { nodeIds: string[]; depth?: number },
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

  const raw = (await client.sendCommand('get_nodes', {
    nodeIds,
  })) as Record<string, unknown>[] | null
  if (raw === null) {
    return {
      content: [
        {
          type: 'text',
          text: 'Failed to get nodes from plugin.',
        },
      ],
    }
  }

  const effectiveDepth = depth ?? 3
  const truncated = raw.map(node =>
    truncateChildren(node, effectiveDepth, 0),
  )
  const json = JSON.stringify(truncated, null, 2)

  return { content: [{ type: 'text', text: json }] }
}

export const handleListPages = async (
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
    return {
      content: [
        {
          type: 'text',
          text: 'Failed to get pages from plugin.',
        },
      ],
    }
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

  return {
    content: [{ type: 'text', text: header + yamlStr }],
  }
}
