// pages.test.ts — handleCreatePage / handleSetCurrentPage / handleDuplicatePage.
//
// All three are mutation handlers routed through formatMutationResult. Asserts
// on REAL handler output (JSON.parse of the emitted text).

import { describe, expect, it } from 'bun:test'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleCreatePage,
  handleSetCurrentPage,
  handleDuplicatePage,
} from '@figma-agent-bridge/server/tools/pages'

type Sent = {
  command: string
  params?: Record<string, unknown>
}

const stubClient = (opts: {
  connected?: boolean
  reply?: unknown
  sent?: Sent[]
}): FigmaClient => ({
  joinChannel: async () => 'ch',
  sendCommand: async (
    command: string,
    params?: Record<string, unknown>,
  ) => {
    opts.sent?.push({ command, params })
    return opts.reply ?? null
  },
  disconnect: () => {},
  isConnected: () => opts.connected ?? true,
  currentChannel: () => 'ch',
})

describe('handleCreatePage', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleCreatePage(
      { name: 'New' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.CREATE_PAGE and emits {id,name}', async () => {
    const sent: Sent[] = []
    const result = await handleCreatePage(
      { name: 'Specs' },
      stubClient({
        sent,
        reply: { id: 'page:new', name: 'Specs' },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.CREATE_PAGE)
    expect(sent[0].params).toEqual({ name: 'Specs' })
    const out = JSON.parse(result.content[0].text) as {
      id: string
      name: string
    }
    expect(out).toEqual({ id: 'page:new', name: 'Specs' })
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleCreatePage(
      { name: 'New' },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to create page.',
    )
  })
})

describe('handleSetCurrentPage', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleSetCurrentPage(
      { pageId: 'page:1' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.SET_CURRENT_PAGE and emits {currentPage}', async () => {
    const sent: Sent[] = []
    const result = await handleSetCurrentPage(
      { pageId: 'page:2' },
      stubClient({
        sent,
        reply: {
          currentPage: { id: 'page:2', name: 'Switched' },
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.SET_CURRENT_PAGE)
    expect(sent[0].params).toEqual({ pageId: 'page:2' })
    const out = JSON.parse(result.content[0].text) as {
      currentPage: { id: string; name: string }
    }
    expect(out.currentPage.id).toBe('page:2')
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleSetCurrentPage(
      { pageId: 'nope' },
      stubClient({
        reply: { error: 'Page not found: nope' },
      }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'Page not found',
    )
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleSetCurrentPage(
      { pageId: 'page:1' },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to set current page.',
    )
  })
})

describe('handleDuplicatePage', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleDuplicatePage(
      { pageId: 'page:1' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.DUPLICATE_PAGE with optional name', async () => {
    const sent: Sent[] = []
    await handleDuplicatePage(
      { pageId: 'page:1', name: 'Copy A' },
      stubClient({
        sent,
        reply: { id: 'page:dup', name: 'Copy A' },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.DUPLICATE_PAGE)
    expect(sent[0].params).toEqual({
      pageId: 'page:1',
      name: 'Copy A',
    })
  })

  it('emits {id,name}', async () => {
    const result = await handleDuplicatePage(
      { pageId: 'page:1' },
      stubClient({
        reply: { id: 'page:dup', name: 'Page 1 Copy' },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      id: string
      name: string
    }
    expect(out.id).toBe('page:dup')
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleDuplicatePage(
      { pageId: 'page:1' },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to duplicate page.',
    )
  })
})
