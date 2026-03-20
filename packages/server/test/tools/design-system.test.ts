import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleInspectStyles,
  handleInspectComponents,
} from '@figma-agent-bridge/server/tools/design-system'
import stylesFixture from '../fixtures/styles-raw.json'
import componentsFixture from '../fixtures/components-raw.json'

describe('handleInspectStyles', () => {
  it('sends get_styles and returns YAML via toStylesYaml', async () => {
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
      'color: "#3B82F6"',
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
      'font: Inter/Bold/32',
    )
    expect(result.content[0].text).not.toContain(
      'color: "#3B82F6"',
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
  it('sends get_local_components and returns YAML via toComponentsYaml', async () => {
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
      '# 2 local components',
    )
    expect(result.content[0].text).toContain('name: Button')
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

    expect(result.content[0].text).toContain('name: Button')
    expect(result.content[0].text).not.toContain(
      'name: Avatar',
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

    const result = await handleInspectComponents(
      {},
      mockClient,
    )

    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })
})
