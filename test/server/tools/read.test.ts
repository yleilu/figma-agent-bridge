import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '../../../packages/server/src/figma-client'
import {
  handleInspect,
  handleInspectPageLayout,
  handleGetNodeInfo,
  handleGetNodesInfo,
  handleListPages,
} from '../../../packages/server/src/tools/read'
import cardFixture from '../../fixtures/card-node-raw.json'
import pageLayoutFixture from '../../fixtures/page-layout-raw.json'

describe('handleInspect', () => {
  it('returns YAML for a specific node', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'get_node') {
          return Promise.resolve(cardFixture)
        }
        if (cmd === 'get_selection') {
          return Promise.resolve([
            { id: '1:42', name: 'Card', type: 'FRAME' },
          ])
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspect(
      { nodeId: '1:42' },
      mockClient,
    )

    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain(
      '# Card [1:42]',
    )
    expect(result.content[0].text).toContain(
      'auto-layout: V',
    )
    expect(result.content[0].text).toContain(
      'font: Inter/SemiBold/18',
    )
  })

  it('uses current selection when no nodeId', async () => {
    const calls: string[] = []
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        calls.push(cmd)
        if (cmd === 'get_selection') {
          return Promise.resolve([
            { id: '1:42', name: 'Card', type: 'FRAME' },
          ])
        }
        if (cmd === 'get_node') {
          return Promise.resolve(cardFixture)
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    await handleInspect({}, mockClient)

    expect(calls).toContain('get_selection')
    expect(calls).toContain('get_node')
  })

  it('returns error when not connected', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleInspect({}, mockClient)

    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })
})

describe('handleInspectPageLayout', () => {
  it('returns YAML with page name and frames', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'get_page_layout') {
          return Promise.resolve(pageLayoutFixture)
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspectPageLayout(mockClient)

    expect(result.content[0].text).toContain('# Homepage')
    expect(result.content[0].text).toContain(
      '3 top-level frames',
    )
    expect(result.content[0].text).toContain('name: Header')
    expect(result.content[0].text).toContain(
      'children_count: 8',
    )
  })
})

describe('handleGetNodeInfo', () => {
  it('sends get_node command and returns JSON via toFullJson', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'get_node') {
          return Promise.resolve(cardFixture)
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleGetNodeInfo(
      { nodeId: '1:42' },
      mockClient,
    )

    expect(result.content[0].type).toBe('text')
    const json = JSON.parse(result.content[0].text)
    expect(json.id).toBe('1:42')
    expect(json.layoutMode).toBe('VERTICAL')
  })

  it('respects depth parameter', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'get_node') {
          return Promise.resolve(cardFixture)
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleGetNodeInfo(
      { nodeId: '1:42', depth: 0 },
      mockClient,
    )
    const json = JSON.parse(result.content[0].text)

    expect(json.children[0]).toEqual({
      id: '1:43',
      name: 'Title',
      type: 'TEXT',
    })
  })

  it('returns error when not connected', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve(null),
      disconnect: () => undefined,
      isConnected: () => false,
      currentChannel: () => null,
    }

    const result = await handleGetNodeInfo(
      { nodeId: '1:42' },
      mockClient,
    )

    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })
})

describe('handleGetNodesInfo', () => {
  it('sends get_nodes command and returns JSON array', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'get_nodes') {
          return Promise.resolve([cardFixture])
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleGetNodesInfo(
      { nodeIds: ['1:42'] },
      mockClient,
    )

    expect(result.content[0].type).toBe('text')
    const json = JSON.parse(result.content[0].text)
    expect(Array.isArray(json)).toBe(true)
    expect(json[0].id).toBe('1:42')
  })
})

describe('handleListPages', () => {
  it('sends get_pages command and returns YAML', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'get_pages') {
          return Promise.resolve([
            {
              id: '0:1',
              name: 'Homepage',
              isCurrent: true,
              childCount: 3,
            },
            {
              id: '0:2',
              name: 'Components',
              isCurrent: false,
              childCount: 15,
            },
          ])
        }

        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleListPages(mockClient)

    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('Homepage')
    expect(result.content[0].text).toContain('Components')
  })
})
