// search.test.ts — the rebuilt handleSearch (Rule A; server-side match + fields
// + cursor + limit).
//
// search sends COMMANDS.SEARCH with {scope, pageId?, nodeId?}; the plugin scans
// and returns candidate nodes ({results:[…]}). The SERVER then applies the
// buildMatcher predicate (incl. type array), the fields projection, and the
// opaque cursor + limit, emitting { results, truncated, cursor? } as YAML.

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'
import { handleSearch } from '@figma-agent-bridge/server/tools/search'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'

type Sent = {
  command: string
  params?: Record<string, unknown>
}

// A candidate-node fixture as the plugin scan returns it (flat NodeSpec-ish).
const candidates = [
  {
    id: '1:1',
    name: 'Card',
    type: 'FRAME',
    size: [320, 200],
  },
  {
    id: '1:2',
    name: 'Title',
    type: 'TEXT',
    size: [200, 24],
  },
  {
    id: '1:3',
    name: 'Body',
    type: 'TEXT',
    size: [200, 48],
  },
  {
    id: '1:4',
    name: 'Icon',
    type: 'VECTOR',
    size: [24, 24],
  },
]

const stubClient = (opts: {
  connected?: boolean
  results?: unknown[]
  sent?: Sent[]
}): FigmaClient => ({
  joinChannel: async () => 'ch',
  sendCommand: async (
    command: string,
    params?: Record<string, unknown>,
  ) => {
    opts.sent?.push({ command, params })
    return { results: opts.results ?? candidates }
  },
  disconnect: () => {},
  isConnected: () => opts.connected ?? true,
  currentChannel: () => 'ch',
})

describe('handleSearch (rebuilt — Rule A)', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleSearch(
      {},
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('sends COMMANDS.SEARCH with scope/pageId/nodeId', async () => {
    const sent: Sent[] = []
    await handleSearch(
      { scope: 'page', pageId: '0:1', nodeId: '1:9' },
      stubClient({ sent }),
    )
    expect(sent[0].command).toBe(COMMANDS.SEARCH)
    expect(sent[0].params?.scope).toBe('page')
    expect(sent[0].params?.pageId).toBe('0:1')
    expect(sent[0].params?.nodeId).toBe('1:9')
  })

  it('applies the match predicate server-side (name glob)', async () => {
    const result = await handleSearch(
      { match: { name: 'Card' } },
      stubClient({}),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { name: string }[]
    }
    expect(out.results).toHaveLength(1)
    expect(out.results[0].name).toBe('Card')
  })

  it('applies a match.type ARRAY (any-of) server-side', async () => {
    const result = await handleSearch(
      { match: { type: ['TEXT', 'VECTOR'] } },
      stubClient({}),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { type: string }[]
    }
    expect(out.results).toHaveLength(3)
    for (const r of out.results) {
      expect(['TEXT', 'VECTOR']).toContain(r.type)
    }
  })

  it('applies a fields projection to each result', async () => {
    const result = await handleSearch(
      { fields: ['id', 'name'] },
      stubClient({}),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: Record<string, unknown>[]
    }
    expect(out.results[0]).toHaveProperty('id')
    expect(out.results[0]).toHaveProperty('name')
    expect(out.results[0]).not.toHaveProperty('type')
    expect(out.results[0]).not.toHaveProperty('size')
  })

  it('paginates with limit + cursor: page 1 is truncated and emits a cursor', async () => {
    const result = await handleSearch(
      { limit: 2 },
      stubClient({}),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { id: string }[]
      truncated: boolean
      cursor?: string
    }
    expect(out.results).toHaveLength(2)
    expect(out.results[0].id).toBe('1:1')
    expect(out.results[1].id).toBe('1:2')
    expect(out.truncated).toBe(true)
    expect(typeof out.cursor).toBe('string')
    expect((out.cursor as string).length).toBeGreaterThan(0)
  })

  it('resumes from a cursor on the next page (no cursor at the end)', async () => {
    const page1 = await handleSearch(
      { limit: 2 },
      stubClient({}),
    )
    const out1 = YAML.parse(page1.content[0].text) as {
      cursor: string
    }
    const page2 = await handleSearch(
      { limit: 2, cursor: out1.cursor },
      stubClient({}),
    )
    const out2 = YAML.parse(page2.content[0].text) as {
      results: { id: string }[]
      truncated: boolean
      cursor?: string
    }
    expect(out2.results).toHaveLength(2)
    expect(out2.results[0].id).toBe('1:3')
    expect(out2.results[1].id).toBe('1:4')
    expect(out2.truncated).toBe(false)
    expect(out2).not.toHaveProperty('cursor')
  })

  it('does not emit a cursor when results fit within the limit', async () => {
    const result = await handleSearch(
      { limit: 50 },
      stubClient({}),
    )
    const out = YAML.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(out.truncated).toBe(false)
    expect(out).not.toHaveProperty('cursor')
  })

  it('reports a stale cursor without throwing', async () => {
    // A cursor from a different result set (different treeVersion) must be
    // rejected as stale rather than silently resuming at a wrong position.
    const page1 = await handleSearch(
      { limit: 2 },
      stubClient({}),
    )
    const out1 = YAML.parse(page1.content[0].text) as {
      cursor: string
    }
    const stale = await handleSearch(
      { limit: 2, cursor: out1.cursor },
      // Different candidate set → different treeVersion → stale.
      stubClient({ results: candidates.slice(0, 1) }),
    )
    expect(stale.content[0].text.toLowerCase()).toContain(
      'stale',
    )
  })

  it('handles empty results gracefully', async () => {
    const result = await handleSearch(
      { match: { name: 'nonexistent' } },
      stubClient({}),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: unknown[]
      truncated: boolean
    }
    expect(out.results).toHaveLength(0)
    expect(out.truncated).toBe(false)
  })

  it('surfaces a plugin-side {error} (unresolvable scope) instead of empty results (T7)', async () => {
    const errorClient: FigmaClient = {
      joinChannel: async () => 'ch',
      sendCommand: async () => ({
        error: 'Node not found: 1:99',
      }),
      disconnect: () => {},
      isConnected: () => true,
      currentChannel: () => 'ch',
    }
    const result = await handleSearch(
      { scope: 'node', nodeId: '1:99' },
      errorClient,
    )
    const { text } = result.content[0]
    expect(text).toContain('Error')
    expect(text).toContain('Node not found: 1:99')
    // A typo'd id must not read as a clean zero-match.
    expect(text).not.toContain('results: []')
  })
})
