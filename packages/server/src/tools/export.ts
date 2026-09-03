// tools/export.ts — render a node, inline or to disk (I82).
//
// The inline reply is an MCP content block: a HOST renders it, and the agent
// that asked for it never sees the bytes. That is right for "show me this
// frame" and useless for every workflow whose deliverable IS the file.
// `workflow.md` calls the exports *"the reviewer phase's entire input"*, and
// the dashboard fixture opens its §5 with one `export` per screen — so the
// documented QA loop could not be run from the tool surface at all. Both the
// operator and the judge of the 2026-09-01 round left the surface, imported
// `handleExport` directly and opened a SECOND relay client, which the
// single-relay constraint otherwise warns against.
//
// `outPath` closes that: the server holds the bytes already, and writing them
// is the one thing the caller cannot do. Absent, the behaviour is byte-for-byte
// what it was.

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { ScopedFigmaClient } from '../figma-client'
import {
  toolError,
  textResult,
  pluginError,
  errorEnvelope,
} from './shared'

type ExportParams = {
  nodeId: string
  format?: 'PNG' | 'SVG' | 'PDF' | 'JPG'
  scale?: number
  outPath?: string
}

const MIME_MAP: Record<string, string> = {
  PNG: 'image/png',
  JPG: 'image/jpeg',
  PDF: 'application/pdf',
}

const EXTENSION: Record<string, string> = {
  PNG: 'png',
  JPG: 'jpg',
  SVG: 'svg',
  PDF: 'pdf',
}

/** Whether `path` names a directory the caller wants the file put INTO. */
const isDirectoryTarget = async (
  path: string,
): Promise<boolean> => {
  if (path.endsWith(sep) || path.endsWith('/')) {
    return true
  }
  try {
    return (await stat(path)).isDirectory()
  } catch {
    // It does not exist yet, so it is the file the caller means.
    return false
  }
}

/**
 * The absolute file the bytes go to.
 *
 * A directory target is named after the NODE, because that is the only name
 * the caller and the file both know — and a compound instance id carries
 * characters (`:` and `;`) a filename should not, so they are folded.
 */
export const exportFilePath = async (
  outPath: string,
  nodeId: string,
  format: string,
): Promise<string> => {
  const absolute = resolve(outPath)
  if (!(await isDirectoryTarget(outPath))) {
    return absolute
  }
  const safe = nodeId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return join(
    absolute,
    safe + '.' + (EXTENSION[format] ?? 'bin'),
  )
}

export const handleExport = async (
  params: ExportParams,
  client: ScopedFigmaClient,
) => {
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
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Export failed: no response from plugin.',
      )
    }

    // The plugin resolves (does not reject) a genuine not-found as {error};
    // surface it honestly (T7) rather than masking it as "Unexpected response".
    if (typeof result.error === 'string') {
      return pluginError(result.error)
    }

    if (typeof result.data !== 'string') {
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Unexpected response from plugin',
      )
    }

    if (params.outPath !== undefined) {
      // SVG crosses as text and everything else as base64 — the same split the
      // inline replies make, one line apart.
      const bytes =
        format === 'SVG'
          ? Buffer.from(result.data, 'utf8')
          : Buffer.from(result.data, 'base64')
      const file = await exportFilePath(
        params.outPath,
        params.nodeId,
        format,
      )
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, bytes)
      } catch (err) {
        // The render succeeded and only the write failed, so the caller can
        // retry with another path — which needs the path AND the reason, not
        // a generic failure. Refusing beats answering with the inline block
        // the caller did not ask for: one call, one reply shape.
        return errorEnvelope(
          'INVALID_PARAM',
          'export: rendered ' +
            params.nodeId +
            ' but could not write ' +
            file +
            ': ' +
            (err instanceof Error
              ? err.message
              : String(err)),
        )
      }
      return textResult(
        JSON.stringify(
          {
            path: file,
            format,
            scale,
            bytes: bytes.byteLength,
          },
          null,
          2,
        ),
      )
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
    return toolError(err)
  }
}
