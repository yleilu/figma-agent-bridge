import type { FigmaClient } from '../figma-client'
import { requireConnected } from './shared'

type ExportParams = {
  nodeId: string
  format?: 'PNG' | 'SVG' | 'PDF' | 'JPG'
  scale?: number
}

const MIME_MAP: Record<string, string> = {
  PNG: 'image/png',
  JPG: 'image/jpeg',
  PDF: 'application/pdf',
}

export const handleExport = async (
  params: ExportParams,
  client: FigmaClient,
) => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  const format = params.format ?? 'PNG'
  const scale = params.scale ?? 1

  try {
    const result = (await client.sendCommand(
      'export_node',
      {
        nodeId: params.nodeId,
        format,
        scale,
      },
    )) as {
      format: string
      scale: number
      data: string
    } | null

    if (result === null) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Export failed: no response from plugin.',
          },
        ],
      }
    }

    if (typeof result.data !== 'string') {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Unexpected response from plugin',
          },
        ],
      }
    }

    if (format === 'SVG') {
      return {
        content: [
          { type: 'text' as const, text: result.data },
        ],
      }
    }

    const mimeType =
      MIME_MAP[format] ?? 'application/octet-stream'

    return {
      content: [
        {
          type: 'image' as const,
          data: result.data,
          mimeType,
        },
      ],
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    }
  }
}
