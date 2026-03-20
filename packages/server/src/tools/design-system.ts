import type { FigmaClient } from '../figma-client'
import { toStylesYaml, toComponentsYaml } from '../parser'

type ToolResult = {
  content: { type: 'text'; text: string }[]
}

export const handleInspectStyles = async (
  { type }: { type?: string },
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
    'get_styles',
    {},
  )) as {
    paint: Record<string, unknown>[]
    text: Record<string, unknown>[]
    effect: Record<string, unknown>[]
    grid: Record<string, unknown>[]
  } | null

  if (raw === null) {
    return {
      content: [
        {
          type: 'text',
          text: 'Failed to get styles from plugin.',
        },
      ],
    }
  }

  if (type !== undefined) {
    const filtered = {
      paint: [],
      text: [],
      effect: [],
      grid: [],
      ...{ [type]: raw[type as keyof typeof raw] },
    }

    return {
      content: [
        { type: 'text', text: toStylesYaml(filtered) },
      ],
    }
  }

  return {
    content: [{ type: 'text', text: toStylesYaml(raw) }],
  }
}

export const handleInspectComponents = async (
  { query }: { query?: string },
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
    'get_local_components',
    {},
  )) as {
    local: Record<string, unknown>[]
    remote: Record<string, unknown>[]
  } | null

  if (raw === null) {
    return {
      content: [
        {
          type: 'text',
          text: 'Failed to get components from plugin.',
        },
      ],
    }
  }

  if (query !== undefined) {
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

    return {
      content: [
        { type: 'text', text: toComponentsYaml(filtered) },
      ],
    }
  }

  return {
    content: [
      { type: 'text', text: toComponentsYaml(raw) },
    ],
  }
}
