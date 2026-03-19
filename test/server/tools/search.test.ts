import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '../../../packages/server/src/figma-client'
import { handleSearch } from '../../../packages/server/src/tools/search'

describe('handleSearch', () => {
  it('sends search_nodes with name/type/pageId params', async () => {
    const sentParams: Record<string, unknown>[] = []
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd, params) => {
        if (cmd === 'search_nodes') {
          sentParams.push(params as Record<string, unknown>)

          return Promise.resolve({
            results: [
              {
                id: '1:42',
                name: 'Card',
                type: 'FRAME',
                page: 'Homepage',
                parent: 'Root [0:1]',
                width: 320,
                height: 200,
              },
            ],
            truncated: false,
          })
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleSearch(
      { name: 'Card', type: 'FRAME' },
      mockClient,
    )

    expect(sentParams[0]).toEqual({
      name: 'Card',
      type: 'FRAME',
      limit: 50,
    })
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('Card')
  })

  it('passes limit param to plugin command', async () => {
    const sentParams: Record<string, unknown>[] = []
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd, params) => {
        if (cmd === 'search_nodes') {
          sentParams.push(params as Record<string, unknown>)

          return Promise.resolve({
            results: [],
            truncated: false,
          })
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    await handleSearch({ name: '*', limit: 10 }, mockClient)

    expect(sentParams[0]).toEqual({ name: '*', limit: 10 })
  })

  it('includes truncated warning in output when results truncated', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'search_nodes') {
          return Promise.resolve({
            results: [
              {
                id: '1:1',
                name: 'Node',
                type: 'FRAME',
                page: 'Page',
                parent: 'Root [0:1]',
                width: 100,
                height: 100,
              },
            ],
            truncated: true,
          })
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleSearch(
      { name: '*' },
      mockClient,
    )

    expect(result.content[0].text).toContain('truncated')
  })

  it('handles empty results gracefully', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'search_nodes') {
          return Promise.resolve({
            results: [],
            truncated: false,
          })
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleSearch(
      { name: 'nonexistent' },
      mockClient,
    )

    expect(result.content[0].text).toContain('0')
  })

  it('returns error when not connected', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleSearch(
      { name: 'Card' },
      mockClient,
    )

    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })
})
