// selection.test.ts — get_selection (read) + set_selection (write).
//
// get_selection sends COMMANDS.GET_SELECTION → [{id,name,type}] as YAML.
// set_selection sends COMMANDS.SET_SELECTION with {nodeIds} → {selectedCount}
// reported through formatMutationResult (a plugin {error} surfaces as an error).

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'
import {
  handleGetSelection,
  handleSetSelection,
} from '@figma-agent-bridge/server/tools/selection'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { ScopedFigmaClient } from '@figma-agent-bridge/server/figma-client'

type Sent = {
  command: string
  params?: Record<string, unknown>
}

const stubClient = (opts: {
  reply?: unknown
  sent?: Sent[]
}): ScopedFigmaClient => ({
  fileKey: 'fk-test',
  sendCommand: async (
    command: string,
    params?: Record<string, unknown>,
  ) => {
    opts.sent?.push({ command, params })
    return opts.reply ?? null
  },
})

describe('handleGetSelection', () => {
  it('sends COMMANDS.GET_SELECTION', async () => {
    const sent: Sent[] = []
    await handleGetSelection(
      {},
      stubClient({ sent, reply: [] }),
    )
    expect(sent[0].command).toBe(COMMANDS.GET_SELECTION)
  })

  it('emits the [{id,name,type}] list as YAML', async () => {
    const result = await handleGetSelection(
      {},
      stubClient({
        reply: [
          { id: '1:1', name: 'Card', type: 'FRAME' },
          { id: '1:2', name: 'Title', type: 'TEXT' },
        ],
      }),
    )
    const out = YAML.parse(result.content[0].text) as {
      id: string
      name: string
      type: string
    }[]
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      id: '1:1',
      name: 'Card',
      type: 'FRAME',
    })
  })

  it('returns a failure message when the plugin returns null', async () => {
    const result = await handleGetSelection(
      {},
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toContain('Failed')
  })
})

describe('handleSetSelection', () => {
  it('sends COMMANDS.SET_SELECTION with {nodeIds}', async () => {
    const sent: Sent[] = []
    await handleSetSelection(
      { nodeIds: ['1:1', '1:2'] },
      stubClient({ sent, reply: { selectedCount: 2 } }),
    )
    expect(sent[0].command).toBe(COMMANDS.SET_SELECTION)
    expect(sent[0].params?.nodeIds).toEqual(['1:1', '1:2'])
  })

  it('reports {selectedCount} on success', async () => {
    const result = await handleSetSelection(
      { nodeIds: ['1:1', '1:2'] },
      stubClient({ reply: { selectedCount: 2 } }),
    )
    const out = JSON.parse(result.content[0].text) as {
      selectedCount: number
    }
    expect(out.selectedCount).toBe(2)
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleSetSelection(
      { nodeIds: ['nope'] },
      stubClient({
        reply: { error: 'Node not found: nope' },
      }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'Node not found',
    )
  })

  // Empty array is the documented CLEAR-selection path: still sends the command
  // and reports selectedCount:0.
  it('forwards an empty nodeIds array (clear selection) and reports selectedCount:0', async () => {
    const sent: Sent[] = []
    const result = await handleSetSelection(
      { nodeIds: [] },
      stubClient({ sent, reply: { selectedCount: 0 } }),
    )
    expect(sent[0].command).toBe(COMMANDS.SET_SELECTION)
    expect(sent[0].params?.nodeIds).toEqual([])
    const out = JSON.parse(result.content[0].text) as {
      selectedCount: number
    }
    expect(out.selectedCount).toBe(0)
  })

  // Dropped/unresolved ids ride back in warnings[] (surfaced through the JSON).
  it('surfaces dropped ids reported by the plugin in warnings[]', async () => {
    const result = await handleSetSelection(
      { nodeIds: ['1:1', 'missing:1'] },
      stubClient({
        reply: {
          selectedCount: 1,
          warnings: [
            'skipped 1 unresolved id(s): missing:1',
          ],
        },
      }),
    )
    expect(result.content[0].text).not.toContain('Error:')
    const out = JSON.parse(result.content[0].text) as {
      selectedCount: number
      warnings: string[]
    }
    expect(out.selectedCount).toBe(1)
    expect(
      out.warnings.some(w => w.includes('missing:1')),
    ).toBe(true)
  })
})
