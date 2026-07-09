// list-pages.test.ts — the rebuilt handleListPages (Rule A list read).
//
// list_pages sends COMMANDS.LIST_PAGES; the plugin returns
// { docName, results:[{id,name,isCurrent,childCount}] }. The server emits the
// Rule A shape { docName, results, truncated, cursor? } as YAML. The page set
// is naturally bounded, so truncated is false and no cursor is emitted.

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'
import { handleListPages } from '@figma-agent-bridge/server/tools/read'
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

const reply = {
  docName: 'My Doc',
  results: [
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
  ],
}

describe('handleListPages (rebuilt — Rule A)', () => {
  it('sends COMMANDS.LIST_PAGES', async () => {
    const sent: Sent[] = []
    await handleListPages({}, stubClient({ sent, reply }))
    expect(sent[0].command).toBe(COMMANDS.LIST_PAGES)
  })

  it('emits { docName, results, truncated } with the page shape', async () => {
    const result = await handleListPages(
      {},
      stubClient({ reply }),
    )
    const out = YAML.parse(result.content[0].text) as {
      docName: string
      results: {
        id: string
        name: string
        isCurrent: boolean
        childCount: number
      }[]
      truncated: boolean
    }
    expect(out.docName).toBe('My Doc')
    expect(out.results).toHaveLength(2)
    expect(out.results[0]).toEqual({
      id: '0:1',
      name: 'Homepage',
      isCurrent: true,
      childCount: 3,
    })
    expect(out.truncated).toBe(false)
  })

  it('does not emit a cursor for a page set within the limit', async () => {
    const result = await handleListPages(
      {},
      stubClient({ reply }),
    )
    const out = YAML.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(out).not.toHaveProperty('cursor')
  })

  it('returns a failure message when the plugin returns null', async () => {
    const result = await handleListPages(
      {},
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toContain('Failed')
  })

  // T10 — server-side pagination. list_pages keeps `docName` on the envelope
  // alongside the bounded page.
  const manyPages = (n: number) => ({
    docName: 'My Doc',
    results: Array.from({ length: n }, (_, i) => ({
      id: `0:${i}`,
      name: `Page ${i}`,
      isCurrent: i === 0,
      childCount: i,
    })),
  })

  it('paginates with limit: page 1 truncated + cursor, docName preserved', async () => {
    const result = await handleListPages(
      { limit: 2 },
      stubClient({ reply: manyPages(5) }),
    )
    const out = YAML.parse(result.content[0].text) as {
      docName: string
      results: { id: string }[]
      truncated: boolean
      cursor?: string
    }
    expect(out.docName).toBe('My Doc')
    expect(out.results).toHaveLength(2)
    expect(out.results[0].id).toBe('0:0')
    expect(out.truncated).toBe(true)
    expect(typeof out.cursor).toBe('string')
  })

  it('resumes from a cursor on the next page', async () => {
    const page1 = await handleListPages(
      { limit: 2 },
      stubClient({ reply: manyPages(4) }),
    )
    const out1 = YAML.parse(page1.content[0].text) as {
      cursor: string
    }
    const page2 = await handleListPages(
      { limit: 2, cursor: out1.cursor },
      stubClient({ reply: manyPages(4) }),
    )
    const out2 = YAML.parse(page2.content[0].text) as {
      docName: string
      results: { id: string }[]
      truncated: boolean
      cursor?: string
    }
    expect(out2.docName).toBe('My Doc')
    expect(out2.results).toHaveLength(2)
    expect(out2.results[0].id).toBe('0:2')
    expect(out2.truncated).toBe(false)
    expect(out2).not.toHaveProperty('cursor')
  })

  it('reports a STALE cursor without throwing when the set changed', async () => {
    const page1 = await handleListPages(
      { limit: 2 },
      stubClient({ reply: manyPages(5) }),
    )
    const out1 = YAML.parse(page1.content[0].text) as {
      cursor: string
    }
    const stale = await handleListPages(
      { limit: 2, cursor: out1.cursor },
      stubClient({ reply: manyPages(2) }),
    )
    const { text } = stale.content[0]
    expect(text).toContain('Cursor rejected (STALE)')
    expect(text.toLowerCase()).toContain('re-run')
  })
})
