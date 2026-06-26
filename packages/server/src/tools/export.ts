import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '../figma-client'
import {
  requireConnected,
  textResult,
  errorMessage,
} from './shared'

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
      COMMANDS.EXPORT,
      {
        nodeId: params.nodeId,
        format,
        scale,
      },
    )) as {
      format: string
      scale: number
      data: string
      error?: string
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

    // The plugin resolves (does not reject) a genuine not-found as {error};
    // surface it honestly (T7) rather than masking it as "Unexpected response".
    if (typeof result.error === 'string') {
      return textResult(`Error: ${result.error}`)
    }

    if (typeof result.data !== 'string') {
      return textResult('Unexpected response from plugin')
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
          text: `Error: ${errorMessage(err)}`,
        },
      ],
    }
  }
}
