import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import { handleExport } from '@figma-agent-bridge/server/tools/export'

describe('handleExport', () => {
  it('sends export_node and returns MCP image content for PNG', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'export_node') {
          return Promise.resolve({
            format: 'PNG',
            scale: 1,
            data: 'iVBORw0KGgoAAAANS',
          })
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
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

    expect(item.type).toBe('image')
    expect(item.data).toBe('iVBORw0KGgoAAAANS')
    expect(item.mimeType).toBe('image/png')
  })

  it('returns MCP image content for JPG', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'export_node') {
          return Promise.resolve({
            format: 'JPG',
            scale: 2,
            data: '/9j/4AAQSkZJRg',
          })
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
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
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'export_node') {
          return Promise.resolve({
            format: 'SVG',
            scale: 1,
            data: svgString,
          })
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
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
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd, params) => {
        if (cmd === 'export_node') {
          sentParams.push(params as Record<string, unknown>)

          return Promise.resolve({
            format: 'PNG',
            scale: 1,
            data: 'abc',
          })
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    await handleExport({ nodeId: '1:42' }, mockClient)

    expect(sentParams[0].format).toBe('PNG')
    expect(sentParams[0].scale).toBe(1)
  })

  it('returns error when not connected', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleExport(
      { nodeId: '1:42' },
      mockClient,
    )
    const item = result.content[0] as {
      type: string
      text: string
    }

    expect(item.text).toContain('Not connected')
  })

  it('maps a thrown plugin error to a tool-formatted message', async () => {
    const client: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () =>
        Promise.reject(new Error('plugin exploded')),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleExport(
      { nodeId: '1:42' },
      client,
    )

    expect(
      (result.content[0] as { text: string }).text,
    ).toBe('Error: plugin exploded')
  })

  it('returns Unexpected response when data is not a string', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () =>
        Promise.resolve({
          format: 'PNG',
          scale: 1,
          data: 123,
        }),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }
    const result = await handleExport(
      { nodeId: '1:42' },
      mockClient,
    )
    expect(
      (result.content[0] as { text: string }).text,
    ).toBe('Unexpected response from plugin')
  })
})
