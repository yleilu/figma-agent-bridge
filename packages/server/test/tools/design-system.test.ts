import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleInspectStyles,
  handleInspectComponents,
} from '@figma-agent-bridge/server/tools/design-system'
import stylesFixture from '../fixtures/styles-raw.json'
import componentsFixture from '../fixtures/components-raw.json'

describe('handleInspectStyles', () => {
  it('sends get_styles and returns compact tree via toStylesTree', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'get_styles') {
          return Promise.resolve(stylesFixture)
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspectStyles({}, mockClient)

    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('# 5 styles')
    expect(result.content[0].text).toContain(
      'paint #3B82F6',
    )
  })

  it('filters by type when provided', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'get_styles') {
          return Promise.resolve(stylesFixture)
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspectStyles(
      { type: 'text' },
      mockClient,
    )

    expect(result.content[0].text).toContain(
      'text Inter/Bold/32',
    )
    expect(result.content[0].text).not.toContain(
      'paint #3B82F6',
    )
  })

  it('returns error for invalid type filter', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'get_styles') {
          return Promise.resolve(stylesFixture)
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspectStyles(
      { type: 'bogus' },
      mockClient,
    )

    expect(result.content[0].text).toContain(
      'Invalid style type',
    )
  })

  it('returns error when not connected', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleInspectStyles({}, mockClient)

    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })
})

describe('handleInspectComponents', () => {
  it('returns Unexpected response when local is not an array (with query)', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () =>
        Promise.resolve({ local: null, remote: [] }),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }
    const result = await handleInspectComponents(
      { query: 'Button' },
      mockClient,
    )
    expect(result.content[0].text).toBe(
      'Unexpected response from plugin',
    )
  })

  it('returns Unexpected response when local is not an array (no query)', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () =>
        Promise.resolve({ local: null, remote: [] }),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }
    const result = await handleInspectComponents(
      {},
      mockClient,
    )
    expect(result.content[0].text).toBe(
      'Unexpected response from plugin',
    )
  })

  it('returns Unexpected response when remote is not an array', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () =>
        Promise.resolve({ local: [], remote: null }),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }
    const result = await handleInspectComponents(
      {},
      mockClient,
    )
    expect(result.content[0].text).toBe(
      'Unexpected response from plugin',
    )
  })

  it('sends get_local_components and returns compact tree via toComponentsTree', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'get_local_components') {
          return Promise.resolve(componentsFixture)
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspectComponents(
      {},
      mockClient,
    )

    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain(
      '# 2 local, 1 remote',
    )
    expect(result.content[0].text).toContain('- Button [')
  })

  it('filters by query when provided', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'get_local_components') {
          return Promise.resolve(componentsFixture)
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspectComponents(
      { query: 'Button' },
      mockClient,
    )

    expect(result.content[0].text).toContain('- Button [')
    expect(result.content[0].text).not.toContain('Avatar')
  })

  it('matches query as a case-insensitive substring', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'get_local_components') {
          return Promise.resolve({
            local: [
              {
                name: 'Primary Button',
                id: '1:1',
                key: 'k1',
              },
              { name: 'Avatar', id: '1:2', key: 'k2' },
              { name: 123, id: '1:3', key: 'k3' },
            ],
            remote: [],
          })
        }
        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspectComponents(
      { query: 'tton' },
      mockClient,
    )

    expect(result.content[0].text).toContain(
      'Primary Button',
    )
    expect(result.content[0].text).not.toContain('Avatar')
  })

  it('returns error when not connected', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleInspectComponents(
      {},
      mockClient,
    )

    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })
})
