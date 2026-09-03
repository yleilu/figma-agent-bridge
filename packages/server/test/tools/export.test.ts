import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { ScopedFigmaClient } from '@figma-agent-bridge/server/figma-client'
import { handleExport } from '@figma-agent-bridge/server/tools/export'

describe('handleExport', () => {
  it('sends COMMANDS.EXPORT and returns MCP image content for PNG', async () => {
    let sent = ''
    const mockClient: ScopedFigmaClient = {
      fileKey: 'fk-test',
      sendCommand: cmd => {
        sent = cmd
        if (cmd === COMMANDS.EXPORT) {
          return Promise.resolve({
            format: 'PNG',
            scale: 1,
            data: 'iVBORw0KGgoAAAANS',
          })
        }

        return Promise.resolve(null)
      },
    }

    const result = await handleExport(
      { nodeId: '1:42' },
      mockClient,
    )
    const item = result.content[0] as {
      type: string
      data: string
      mimeType: string
    }

    expect(sent).toBe(COMMANDS.EXPORT)
    expect(item.type).toBe('image')
    expect(item.data).toBe('iVBORw0KGgoAAAANS')
    expect(item.mimeType).toBe('image/png')
  })

  it('returns MCP image content for JPG', async () => {
    const mockClient: ScopedFigmaClient = {
      fileKey: 'fk-test',
      sendCommand: cmd => {
        if (cmd === COMMANDS.EXPORT) {
          return Promise.resolve({
            format: 'JPG',
            scale: 2,
            data: '/9j/4AAQSkZJRg',
          })
        }

        return Promise.resolve(null)
      },
    }

    const result = await handleExport(
      { nodeId: '1:42', format: 'JPG', scale: 2 },
      mockClient,
    )
    const item = result.content[0] as {
      type: string
      data: string
      mimeType: string
    }

    expect(item.type).toBe('image')
    expect(item.data).toBe('/9j/4AAQSkZJRg')
    expect(item.mimeType).toBe('image/jpeg')
  })

  it('returns MCP text content for SVG', async () => {
    const svgString =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="red"/></svg>'
    const mockClient: ScopedFigmaClient = {
      fileKey: 'fk-test',
      sendCommand: cmd => {
        if (cmd === COMMANDS.EXPORT) {
          return Promise.resolve({
            format: 'SVG',
            scale: 1,
            data: svgString,
          })
        }

        return Promise.resolve(null)
      },
    }

    const result = await handleExport(
      { nodeId: '1:42', format: 'SVG' },
      mockClient,
    )
    const item = result.content[0] as {
      type: string
      text: string
    }

    expect(item.type).toBe('text')
    expect(item.text).toBe(svgString)
  })

  it('defaults to PNG format and scale 1', async () => {
    const sentParams: Record<string, unknown>[] = []
    const mockClient: ScopedFigmaClient = {
      fileKey: 'fk-test',
      sendCommand: (cmd, params) => {
        if (cmd === COMMANDS.EXPORT) {
          sentParams.push(params as Record<string, unknown>)

          return Promise.resolve({
            format: 'PNG',
            scale: 1,
            data: 'abc',
          })
        }

        return Promise.resolve(null)
      },
    }

    await handleExport({ nodeId: '1:42' }, mockClient)

    expect(sentParams[0].format).toBe('PNG')
    expect(sentParams[0].scale).toBe(1)
  })

  it('maps a thrown plugin error to a tool-formatted message', async () => {
    const client: ScopedFigmaClient = {
      fileKey: 'fk-test',
      sendCommand: () =>
        Promise.reject(new Error('plugin exploded')),
    }

    const result = await handleExport(
      { nodeId: '1:42' },
      client,
    )

    const { text } = result.content[0] as { text: string }
    expect(JSON.parse(text)).toEqual({
      error: 'plugin exploded',
      code: 'PLUGIN_ERROR',
    })
  })

  it('surfaces a plugin-side {error} (not-found) instead of the generic mask', async () => {
    const mockClient: ScopedFigmaClient = {
      fileKey: 'fk-test',
      sendCommand: () =>
        Promise.resolve({ error: 'Node not found: 1:99' }),
    }
    const result = await handleExport(
      { nodeId: '1:99' },
      mockClient,
    )
    const { text } = result.content[0] as { text: string }
    const data = JSON.parse(text) as {
      error: string
      code: string
    }
    expect(data.error).toContain('Node not found: 1:99')
    expect(data.code).toBe('NODE_NOT_FOUND')
    expect(text).not.toContain(
      'Unexpected response from plugin',
    )
  })

  it('returns Unexpected response when data is not a string', async () => {
    const mockClient: ScopedFigmaClient = {
      fileKey: 'fk-test',
      sendCommand: () =>
        Promise.resolve({
          format: 'PNG',
          scale: 1,
          data: 123,
        }),
    }
    const result = await handleExport(
      { nodeId: '1:42' },
      mockClient,
    )
    const { text } = result.content[0] as { text: string }
    expect(JSON.parse(text)).toEqual({
      error: 'Unexpected response from plugin',
      code: 'PLUGIN_ERROR',
    })
  })
})

// I82 — the render has a route to disk.
//
// The inline reply is a content block a HOST renders; the agent that asked for
// it never sees the bytes. `workflow.md` calls the exports "the reviewer
// phase's entire input" and the dashboard fixture's §5 opens with one `export`
// per screen, so the documented loop could not run from the tool surface at
// all: on 2026-09-01 the operator AND the judge each left the surface, imported
// this handler directly and opened a second relay client to write the PNGs.
describe('handleExport — outPath', () => {
  // 1×1 PNG, so the bytes on disk can be compared against a known value.
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="red"/></svg>'

  const clientFor = (
    format: string,
    data: string,
  ): ScopedFigmaClient => ({
    fileKey: 'fk-test',
    sendCommand: cmd =>
      cmd === COMMANDS.EXPORT
        ? Promise.resolve({ format, scale: 1, data })
        : Promise.resolve(null),
  })

  const dirs: string[] = []
  const tempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'fab-export-'))
    dirs.push(dir)
    return dir
  }

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes the PNG and answers with its path, not the bytes', async () => {
    const dir = await tempDir()
    const file = join(dir, 'overview.png')
    const result = await handleExport(
      { nodeId: '1:42', outPath: file },
      clientFor('PNG', PNG_B64),
    )
    const { text } = result.content[0] as { text: string }
    const out = JSON.parse(text) as {
      path: string
      bytes: number
      format: string
    }
    expect(result.content[0].type).toBe('text')
    expect(out.path).toBe(file)
    expect(out.format).toBe('PNG')
    const written = await readFile(file)
    expect(written).toEqual(Buffer.from(PNG_B64, 'base64'))
    expect(out.bytes).toBe(written.byteLength)
  })

  it('writes SVG as text, not as decoded base64', async () => {
    const dir = await tempDir()
    const file = join(dir, 'icon.svg')
    await handleExport(
      { nodeId: '1:42', format: 'SVG', outPath: file },
      clientFor('SVG', SVG),
    )
    expect(await readFile(file, 'utf8')).toBe(SVG)
  })

  it('creates the parent directories the caller named', async () => {
    const dir = await tempDir()
    const file = join(dir, 'exports', 'deep', 'shot.png')
    await handleExport(
      { nodeId: '1:42', outPath: file },
      clientFor('PNG', PNG_B64),
    )
    expect(
      (await readFile(file)).byteLength,
    ).toBeGreaterThan(0)
  })

  it('names the file after the node when given a directory', async () => {
    const dir = await tempDir()
    const result = await handleExport(
      {
        nodeId: 'I549:17459;549:17078',
        outPath: dir + sep,
      },
      clientFor('PNG', PNG_B64),
    )
    const { text } = result.content[0] as { text: string }
    const out = JSON.parse(text) as { path: string }
    // A compound id carries `:` and `;`, which a filename should not.
    expect(out.path).toBe(
      join(dir, 'I549_17459_549_17078.png'),
    )
    expect((await readFile(out.path)).byteLength).toBe(70)
  })

  it('refuses with the path and the reason when the write fails', async () => {
    const dir = await tempDir()
    // A file where a directory would have to be: the write cannot succeed.
    const blocker = join(dir, 'blocked')
    await handleExport(
      { nodeId: '1:1', outPath: blocker },
      clientFor('PNG', PNG_B64),
    )
    const result = await handleExport(
      { nodeId: '1:42', outPath: join(blocker, 'x.png') },
      clientFor('PNG', PNG_B64),
    )
    const { text } = result.content[0] as { text: string }
    const err = JSON.parse(text) as {
      error: string
      code: string
    }
    expect(err.code).toBe('INVALID_PARAM')
    expect(err.error).toContain('x.png')
    expect(err.error).toContain('1:42')
  })

  it('is byte-for-byte the old reply when outPath is absent', async () => {
    const result = await handleExport(
      { nodeId: '1:42' },
      clientFor('PNG', PNG_B64),
    )
    const item = result.content[0] as {
      type: string
      data: string
    }
    expect(item.type).toBe('image')
    expect(item.data).toBe(PNG_B64)
  })
})
