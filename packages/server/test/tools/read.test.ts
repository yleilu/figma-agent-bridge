// read.test.ts — unit tests for the read handlers that the M2 slice LEAVES
// INTACT: handleInspectPageLayout, handleGetNodes, handleListPages.
//
// handleGetNode and handleInspect are rebuilt by the slice; their NEW-contract
// tests live in get-node.test.ts and inspect.test.ts respectively.

import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleInspectPageLayout,
  handleGetNodes,
  handleListPages,
} from '@figma-agent-bridge/server/tools/read'
import cardFixture from '../fixtures/card-node-raw.json'
import pageLayoutFixture from '../fixtures/page-layout-raw.json'

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

  it('returns Unexpected response when plugin returns a non-array', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () =>
        Promise.resolve({ not: 'an array' }),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }
    const result = await handleGetNodes(
      { nodeIds: ['1:42'] },
      mockClient,
    )
    expect(result.content[0].text).toBe(
      'Unexpected response from plugin',
    )
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
