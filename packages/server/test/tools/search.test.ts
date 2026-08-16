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
import type { ScopedFigmaClient } from '@figma-agent-bridge/server/figma-client'

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
  results?: unknown[]
  sent?: Sent[]
}): ScopedFigmaClient => ({
  fileKey: 'fk-test',
  sendCommand: async (
    command: string,
    params?: Record<string, unknown>,
  ) => {
    opts.sent?.push({ command, params })
    return { results: opts.results ?? candidates }
  },
})

describe('handleSearch (rebuilt — Rule A)', () => {
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

  // B2 — depth threads through to the plugin scan (bounds the scan SCOPE; the
  // result still comes back as a flat Rule-A list). The server passes it
  // verbatim; the plugin limits its descent.
  it('threads depth through to the plugin SEARCH command', async () => {
    const sent: Sent[] = []
    await handleSearch({ depth: 2 }, stubClient({ sent }))
    expect(sent[0].params?.depth).toBe(2)
  })

  it('omits depth when not given (plugin applies its scan-all default)', async () => {
    const sent: Sent[] = []
    await handleSearch({}, stubClient({ sent }))
    expect(sent[0].params).not.toHaveProperty('depth')
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

  // B4 — characters projection: when fields requests `characters`, the plugin
  // has collected TEXT .characters onto the candidate and the server projects
  // it. TEXT → its string; non-text → absent (undefined).
  it('projects characters (text-copy inventory) when fields requests it', async () => {
    const withChars = [
      {
        id: '1:1',
        name: 'Card',
        type: 'FRAME',
      },
      {
        id: '1:2',
        name: 'Title',
        type: 'TEXT',
        characters: 'Hello world',
      },
    ]
    const result = await handleSearch(
      { fields: ['id', 'type', 'characters'] },
      stubClient({ results: withChars }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: Record<string, unknown>[]
    }
    // TEXT node carries its content; FRAME node has no characters field.
    expect(out.results[1].characters).toBe('Hello world')
    expect(out.results[0]).not.toHaveProperty('characters')
  })

  // B4 — the server hints the plugin to collect characters only when needed.
  it('hints collectCharacters to the plugin when fields includes characters', async () => {
    const sent: Sent[] = []
    await handleSearch(
      { fields: ['id', 'characters'] },
      stubClient({ sent }),
    )
    expect(sent[0].params?.collectCharacters).toBe(true)
  })

  it('does NOT hint collectCharacters when characters is not requested', async () => {
    const sent: Sent[] = []
    await handleSearch(
      { fields: ['id', 'name'] },
      stubClient({ sent }),
    )
    expect(sent[0].params).not.toHaveProperty(
      'collectCharacters',
    )
  })

  // B3 — reverse-lookup match keys trigger conditional metadata collection
  // hints (only when the match actually needs them).
  it('hints collectComponentRef for an instancesOf match', async () => {
    const sent: Sent[] = []
    await handleSearch(
      { match: { instancesOf: 'Button' } },
      stubClient({ sent }),
    )
    expect(sent[0].params?.collectComponentRef).toBe(true)
  })

  it('hints collectComponentRef for a componentKey match', async () => {
    const sent: Sent[] = []
    await handleSearch(
      { match: { componentKey: 'abc' } },
      stubClient({ sent }),
    )
    expect(sent[0].params?.collectComponentRef).toBe(true)
  })

  it('hints collectStyleId / collectVariableId per the match key', async () => {
    const sentS: Sent[] = []
    await handleSearch(
      { match: { styleId: 'S:1' } },
      stubClient({ sent: sentS }),
    )
    expect(sentS[0].params?.collectStyleId).toBe(true)

    const sentV: Sent[] = []
    await handleSearch(
      { match: { variableId: 'V:1' } },
      stubClient({ sent: sentV }),
    )
    expect(sentV[0].params?.collectVariableId).toBe(true)
  })

  it('does NOT hint any collection for a plain name/type match', async () => {
    const sent: Sent[] = []
    await handleSearch(
      { match: { name: 'Card', type: 'FRAME' } },
      stubClient({ sent }),
    )
    expect(sent[0].params).not.toHaveProperty(
      'collectComponentRef',
    )
    expect(sent[0].params).not.toHaveProperty(
      'collectStyleId',
    )
    expect(sent[0].params).not.toHaveProperty(
      'collectVariableId',
    )
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

  it('emits contextSummary on a candidate, never full context (post-projection)', async () => {
    const result = await handleSearch(
      { match: { name: 'Card' } },
      stubClient({
        results: [
          {
            id: '1:1',
            name: 'Card',
            type: 'FRAME',
            size: [320, 200],
            context:
              '---\npurpose: CTA\n---\n## Notes\nlong body',
          },
        ],
      }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: {
        context?: string
        contextSummary?: string
      }[]
    }
    expect(out.results[0].contextSummary).toBe(
      'purpose: CTA',
    )
    expect(out.results[0].context).toBeUndefined()
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
    const errorClient: ScopedFigmaClient = {
      fileKey: 'fk-test',
      sendCommand: async () => ({
        error: 'Node not found: 1:99',
      }),
    }
    const result = await handleSearch(
      { scope: 'node', nodeId: '1:99' },
      errorClient,
    )
    const { text } = result.content[0]
    const data = JSON.parse(text) as {
      error: string
      code: string
    }
    expect(data.error).toContain('Node not found: 1:99')
    expect(data.code).toBe('NODE_NOT_FOUND')
    // A typo'd id must not read as a clean zero-match.
    expect(text).not.toContain('results: []')
  })

  it('returns a typed envelope when the plugin returns null (defensive path)', async () => {
    const nullClient: ScopedFigmaClient = {
      fileKey: 'fk-test',
      sendCommand: async () => null,
    }
    const result = await handleSearch({}, nullClient)
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'Search failed: no response from plugin.',
      code: 'PLUGIN_ERROR',
    })
  })

  it('returns a typed envelope when results is not an array (defensive path)', async () => {
    const malformedClient: ScopedFigmaClient = {
      fileKey: 'fk-test',
      sendCommand: async () => ({ results: 'not-array' }),
    }
    const result = await handleSearch({}, malformedClient)
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'Unexpected response from plugin',
      code: 'PLUGIN_ERROR',
    })
  })

  // B31 — a candidate the plugin could not read is skipped THERE and named
  // HERE. The scan that crossed it still returns everything else: before this,
  // one stale slot-child killed a whole document-wide search.
  it('surfaces the plugin scan warnings on the success envelope (T7)', async () => {
    const degradedClient: ScopedFigmaClient = {
      fileKey: 'fk-test',
      sendCommand: async () => ({
        results: candidates,
        warnings: [
          'search: skipped I3:1;4:5;6:7: in get_name: The node (instance sublayer or table cell) with id "I3:1;4:5;6:7" does not exist',
        ],
      }),
    }
    const result = await handleSearch({}, degradedClient)
    const out = YAML.parse(result.content[0].text) as {
      results: unknown[]
      warnings?: string[]
    }
    expect(out.results).toHaveLength(4)
    expect(out.warnings?.[0]).toContain(
      'search: skipped I3:1;4:5;6:7',
    )
  })

  it('omits warnings entirely when the scan was clean', async () => {
    const result = await handleSearch({}, stubClient({}))
    expect(
      YAML.parse(result.content[0].text),
    ).not.toHaveProperty('warnings')
  })
})

// ---------------------------------------------------------------------------
// B50 — search honours the SAME `fields` vocabulary the fidelity readers serve
// ---------------------------------------------------------------------------
//
// The plugin's scan row is cheap by design (id/name/type/size, plus
// `characters` on request) because it crosses the whole document. Projecting
// `fills` over that row therefore returned NOTHING — no key, no warning — and
// a dropped field is indistinguishable from a negative result, so a sweep for
// white frames came back clean on frames that were white. D2 is one contract
// on every node-returning read, so the missing fields are FETCHED, over the
// page that `match` + `limit` have already bounded.
describe('handleSearch — projection past the scan row (B50)', () => {
  // Raw JSON_REST_V1 exports, keyed by id, as the GET_NODES reply carries them.
  const exports: Record<string, Record<string, unknown>> = {
    '1:1': {
      id: '1:1',
      name: 'Card',
      type: 'FRAME',
      absoluteBoundingBox: {
        x: 0,
        y: 0,
        width: 320,
        height: 200,
      },
      fills: [
        {
          type: 'SOLID',
          color: { r: 1, g: 0, b: 0, a: 1 },
        },
      ],
      layoutMode: 'VERTICAL',
      itemSpacing: 8,
    },
    '1:2': {
      id: '1:2',
      name: 'Title',
      type: 'TEXT',
      absoluteBoundingBox: {
        x: 0,
        y: 0,
        width: 200,
        height: 24,
      },
      fills: [
        {
          type: 'SOLID',
          color: { r: 0, g: 0, b: 1, a: 1 },
        },
      ],
    },
  }

  const scan = [
    { id: '1:1', name: 'Card', type: 'FRAME' },
    {
      id: '1:2',
      name: 'Title',
      type: 'TEXT',
      characters: 'Hello',
    },
  ]

  /** Answers SEARCH with the scan rows and GET_NODES with the exports above. */
  const twoStepClient = (opts: {
    sent?: Sent[]
    missing?: string[]
  }): ScopedFigmaClient => ({
    fileKey: 'fk-test',
    sendCommand: async (
      command: string,
      params?: Record<string, unknown>,
    ) => {
      opts.sent?.push({ command, params })
      if (command === COMMANDS.GET_NODES) {
        const ids = (params?.nodeIds as string[]) ?? []
        return ids.map(id =>
          opts.missing?.includes(id) === true
            ? { id, error: 'Node not found' }
            : exports[id],
        )
      }
      return { results: scan }
    },
  })

  it('fetches the node specs and projects `fills`', async () => {
    const sent: Sent[] = []
    const result = await handleSearch(
      { fields: ['id', 'name', 'type', 'fills'] },
      twoStepClient({ sent }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: {
        id: string
        type: string
        fills?: string[]
      }[]
    }
    expect(sent[1].command).toBe(COMMANDS.GET_NODES)
    // Bounded: the ids of the page, at the fidelity reader's own depth.
    expect(sent[1].params?.nodeIds).toEqual(['1:1', '1:2'])
    expect(sent[1].params?.depth).toBe(0)
    expect(out.results[0].fills?.[0]).toBe('#FF0000')
    expect(out.results[1].fills?.[0]).toBe('#0000FF')
    // …and the row still answers to the id the scan reported.
    expect(out.results.map(r => r.id)).toEqual([
      '1:1',
      '1:2',
    ])
  })

  it('projects a `profile` preset the same way', async () => {
    const result = await handleSearch(
      { profile: 'layout' },
      twoStepClient({}),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { layout?: { mode: string; gap?: number } }[]
    }
    expect(out.results[0].layout?.mode).toBe('V')
    expect(out.results[0].layout?.gap).toBe(8)
  })

  it('does NOT fetch when the scan row already answers', async () => {
    for (const params of [
      {},
      { fields: ['id', 'name', 'type', 'size'] },
      { fields: ['id', 'characters'] },
      { profile: 'minimal' as const },
    ]) {
      const sent: Sent[] = []
      await handleSearch(params, twoStepClient({ sent }))
      expect(sent).toHaveLength(1)
      expect(sent[0].command).toBe(COMMANDS.SEARCH)
    }
  })

  // The allow-list stays EXACT — no silent base-merge. A caller who wants `id`
  // lists `id`, so an id-less text inventory is the contract, not a defect.
  it('keeps the allow-list exact (no base fields merged in)', async () => {
    const result = await handleSearch(
      { fields: ['characters'] },
      twoStepClient({}),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: Record<string, unknown>[]
    }
    expect(out.results[1]).toEqual({ characters: 'Hello' })
    expect(out.results[0]).not.toHaveProperty('id')
  })

  // T7 — a row whose spec could not be read is thin, and SAYS it is thin.
  it('names a result whose fields could not be read back', async () => {
    const result = await handleSearch(
      { fields: ['id', 'fills'] },
      twoStepClient({ missing: ['1:2'] }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { id: string; fills?: string[] }[]
      warnings?: string[]
    }
    expect(out.results[0].fills).toBeDefined()
    expect(out.results[1].fills).toBeUndefined()
    expect(out.results[1].id).toBe('1:2')
    expect(out.warnings?.[0]).toContain('1:2')
  })
})
