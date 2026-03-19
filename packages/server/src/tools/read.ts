import YAML from 'yaml'
import type { FigmaClient } from '../figma-client'
import {
  parseNode,
  toInspectYaml,
  toPageLayoutYaml,
  toFullJson,
} from '../parser'

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
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

  let targetId = nodeId

  if (targetId === undefined) {
    const selection = (await client.sendCommand(
      'get_selection',
      {},
    )) as Array<{
      id: string
      name: string
      type: string
    }> | null
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
    targetId = selection[0].id
  }

  const raw = (await client.sendCommand('get_node', {
    nodeId: targetId,
  })) as Record<string, unknown> | null
  if (raw === null) {
    return {
      content: [
        {
          type: 'text',
          text: `Node not found: ${targetId}`,
        },
      ],
    }
  }

  const parsed = parseNode(raw)
  const yaml = toInspectYaml(parsed)

  return { content: [{ type: 'text', text: yaml }] }
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
    frames: Array<Record<string, unknown>>
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

  const yaml = toPageLayoutYaml(raw)

  return { content: [{ type: 'text', text: yaml }] }
}

export const handleGetNodeInfo = async (
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

export const handleGetNodesInfo = async (
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
  })) as Array<Record<string, unknown>> | null
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

  const json = JSON.stringify(
    raw.map(node => JSON.parse(toFullJson(node, depth))),
    null,
    2,
  )

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
  )) as Array<{
    id: string
    name: string
    isCurrent: boolean
    childCount: number
  }> | null
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
