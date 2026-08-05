import { describe, expect, it } from 'bun:test'
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
