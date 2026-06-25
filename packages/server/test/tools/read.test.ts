// read.test.ts — unit tests for the read handler that chunk B LEAVES INTACT:
// handleInspectPageLayout.
//
// handleGetNode / handleInspect were rebuilt by the slice; handleGetNodes /
// handleListPages are rebuilt by chunk B. Their NEW-contract tests live in
// get-node.test.ts, inspect.test.ts, get-nodes.test.ts and list-pages.test.ts.

import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import { handleInspectPageLayout } from '@figma-agent-bridge/server/tools/read'
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
