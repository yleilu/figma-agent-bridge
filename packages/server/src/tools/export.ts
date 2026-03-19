import type { FigmaClient } from '../figma-client'

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
  if (!client.isConnected()) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Not connected to Figma. Use connect tool first.',
        },
      ],
    }
  }

  const format = params.format ?? 'PNG'
  const scale = params.scale ?? 1

  const result = (await client.sendCommand('export_node', {
    nodeId: params.nodeId,
    format,
    scale,
  })) as {
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
}
