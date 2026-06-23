import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleInspect,
  handleInspectPageLayout,
  handleGetNode,
  handleGetNodes,
  handleListPages,
} from '@figma-agent-bridge/server/tools/read'
import cardFixture from '../fixtures/card-node-raw.json'
import pageLayoutFixture from '../fixtures/page-layout-raw.json'

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
      '- Card [1:42] FRAME 320×200 V:',
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
  it('returns compact tree with page name and frames', async () => {
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
    expect(result.content[0].text).toContain('3 items')
    expect(result.content[0].text).toContain(
      '- Header [2:1] FRAME 1440×80 @ 0,0',
    )
  })

  it('uses multi-selection when multiple nodes selected', async () => {
    const secondFixture = JSON.parse(
      JSON.stringify(cardFixture),
    )
    secondFixture.id = '2:1'
    secondFixture.name = 'Card2'

    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd, params) => {
        if (cmd === 'get_selection') {
          return Promise.resolve([
            { id: '1:42', name: 'Card', type: 'FRAME' },
            { id: '2:1', name: 'Card2', type: 'FRAME' },
          ])
        }
        if (cmd === 'get_node') {
          const p = params as { nodeId: string }
          if (p.nodeId === '2:1') {
            return Promise.resolve(secondFixture)
          }
          return Promise.resolve(cardFixture)
        }
        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspect({}, mockClient)

    expect(result.content[0].text).toContain('# 2 selected')
  })

  it('skips nodes that fail to fetch in multi-selection', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd, params) => {
        if (cmd === 'get_selection') {
          return Promise.resolve([
            { id: '1:42', name: 'Card', type: 'FRAME' },
            {
              id: '9:99',
              name: 'Missing',
              type: 'FRAME',
            },
          ])
        }
        if (cmd === 'get_node') {
          const p = params as { nodeId: string }
          if (p.nodeId === '9:99') {
            return Promise.resolve(null)
          }
          return Promise.resolve(cardFixture)
        }
        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspect({}, mockClient)

    // Should fall back to single-node tree since only one resolved
    expect(result.content[0].text).toContain(
      '# Card [1:42]',
    )
    expect(result.content[0].text).not.toContain('Missing')
  })
})

describe('handleGetNode', () => {
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

    const result = await handleGetNode(
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

    const result = await handleGetNode(
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

    const result = await handleGetNode(
      { nodeId: '1:42' },
      mockClient,
    )

    expect(result.content[0].text).toContain(
      'Not connected',
    )
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

    const result = await handleGetNode(
      { nodeId: '1:42' },
      client,
    )

    expect(result.content[0].text).toBe(
      'Error: plugin exploded',
    )
  })
})

describe('handleGetNodes', () => {
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

    const result = await handleGetNodes(
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
