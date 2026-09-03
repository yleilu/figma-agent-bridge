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

  // B72 — `truncated` answers "is there another PAGE of results"; `incomplete`
  // answers "did the scan reach the whole document". The 2026-08-30 round read
  // the first as an answer to the second: a document scan missing 13% of the
  // file said `truncated:false`, and two rubric categories were scored to a
  // false FAIL off it — one of them a gate condition.
  it('carries the scan-incomplete flag through, beside truncated', async () => {
    const shortClient: ScopedFigmaClient = {
      fileKey: 'fk-test',
      sendCommand: async () => ({
        results: candidates,
        incomplete: true,
        warnings: [
          'search: skipped the children of I5:1;5:2',
        ],
      }),
    }
    const out = YAML.parse(
      (await handleSearch({}, shortClient)).content[0].text,
    ) as { truncated: boolean; incomplete?: boolean }
    expect(out.incomplete).toBe(true)
    // …and the two stay distinguishable: this page held every result.
    expect(out.truncated).toBe(false)
  })

  it('omits incomplete when the scan reached everything', async () => {
    expect(
      YAML.parse(
        (await handleSearch({}, stubClient({}))).content[0]
          .text,
      ),
    ).not.toHaveProperty('incomplete')
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

  // I85 — the two read channels do not mean the same thing by `position`, and
  // nothing said so. A `search` row is hydrated by a read ENTERED at that node,
  // so it has no parent bbox to subtract and its position is ABSOLUTE; a
  // `get_node` tree's children are PARENT-RELATIVE. Two reviewers mis-scored on
  // it in one round, on exactly the overflow / alignment / containment checks
  // three rubric categories are made of.
  it('names the frame of reference beside a position it returns (I85)', async () => {
    const result = await handleSearch(
      { fields: ['id', 'position'] },
      twoStepClient({}),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: {
        position?: [number, number]
        positionFrame?: string
      }[]
    }
    expect(out.results[0].position).toEqual([0, 0])
    expect(out.results[0].positionFrame).toBe('absolute')
  })

  it('says nothing about a frame for a row that carries no position', async () => {
    const result = await handleSearch(
      { fields: ['id', 'name'] },
      twoStepClient({}),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: Record<string, unknown>[]
    }
    expect('positionFrame' in out.results[0]).toBe(false)
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

// ─── B56 (live root cause): a VARIANT instance is findable by its SET name ───
//
// Live evidence, file MFMyzjEZyH5cVyrNejdbyP:
//   454:5478 is a COMPONENT_SET named "State block"
//   454:5477 is a COMPONENT named "State=Error" — one of its variants
//   I454:5452;453:3882;454:5489 is an INSTANCE of 454:5477
//
// `search {instancesOf:'State=Error'}` finds it. `search {instancesOf:'State
// block'}` finds NOTHING — and "State block" is the only name a human ever
// sees for that family: it is what the components panel shows, what the design
// doc calls it, and what the acceptance gate was written against. So a correct
// design scored as a missing master (B56).
//
// The enumeration was never the problem here. `instancesOf` compared against
// the main component's OWN name, and a variant's own name is `State=<Value>`;
// the family name lives on the set.

const variantCandidates = [
  {
    id: 'I454:5452;453:3882;454:5489',
    name: 'Error block',
    type: 'INSTANCE',
    componentKey: 'k-error',
    instancesOf: 'State=Error',
    instancesOfSet: 'State block',
  },
  {
    id: 'I454:5346;453:3882;454:5370',
    name: 'Empty block',
    type: 'INSTANCE',
    componentKey: 'k-empty',
    instancesOf: 'State=Empty',
    instancesOfSet: 'State block',
  },
  {
    // A plain, set-less component's instance — no set name to match on.
    id: '1:45',
    name: 'Action Button',
    type: 'INSTANCE',
    componentKey: 'btn-key-123',
    instancesOf: 'Button',
  },
]

describe('handleSearch — instancesOf reaches a variant family (B56)', () => {
  const found = async (instancesOf: string) => {
    const result = await handleSearch(
      { match: { instancesOf } },
      stubClient({ results: variantCandidates }),
    )
    return (
      YAML.parse(result.content[0].text) as {
        results: { id: string }[]
      }
    ).results.map(r => r.id)
  }

  it('finds every variant of a set by the SET name', async () => {
    expect(await found('State block')).toEqual([
      'I454:5452;453:3882;454:5489',
      'I454:5346;453:3882;454:5370',
    ])
  })

  it('still finds one variant by its own name', async () => {
    expect(await found('State=Error')).toEqual([
      'I454:5452;453:3882;454:5489',
    ])
  })

  it('still finds a set-less component by its name', async () => {
    expect(await found('Button')).toEqual(['1:45'])
  })

  it('matches nothing for a name that is neither', async () => {
    expect(await found('State blocks')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// I58 — the `fields` vocabulary is honest about what it takes
// ---------------------------------------------------------------------------
//
// `fields` is an EXACT allow-list, and an entry outside it was dropped without
// a word. A dropped field looks exactly like a field the node does not carry,
// so `fields:['id','childCount']` came back as bare ids and read as a document
// where nothing has children — the caller draws the opposite conclusion from
// the one the data supports. `childCount` was not in the vocabulary at all,
// which is the same silence one step earlier: search returns a FLAT DFS list,
// and that count is the only thing in it that says what contains what.
describe('handleSearch — the fields vocabulary (I58)', () => {
  const exportsById: Record<
    string,
    Record<string, unknown>
  > = {
    '1:1': {
      id: '1:1',
      name: 'Card',
      type: 'FRAME',
      children: [
        { id: '1:2', name: 'Title', type: 'TEXT' },
        { id: '1:3', name: 'Body', type: 'TEXT' },
      ],
    },
    '1:2': { id: '1:2', name: 'Title', type: 'TEXT' },
  }

  const client = (sent?: Sent[]): ScopedFigmaClient => ({
    fileKey: 'fk-test',
    sendCommand: async (
      command: string,
      params?: Record<string, unknown>,
    ) => {
      sent?.push({ command, params })
      if (command === COMMANDS.GET_NODES) {
        return ((params?.nodeIds as string[]) ?? []).map(
          id => exportsById[id],
        )
      }
      return {
        results: [
          { id: '1:1', name: 'Card', type: 'FRAME' },
          { id: '1:2', name: 'Title', type: 'TEXT' },
        ],
      }
    },
  })

  it('refuses an entry it cannot supply, and names it', async () => {
    const sent: Sent[] = []
    const result = await handleSearch(
      { fields: ['id', 'fillz'] },
      client(sent),
    )
    const { text } = result.content[0]
    expect(text).toContain('INVALID_PARAM')
    expect(text).toContain('`fillz`')
    // Refused BEFORE the scan: a rejected call must not cost a document walk.
    expect(sent).toEqual([])
  })

  it('names every bad entry, not just the first', async () => {
    const { text } = (
      await handleSearch(
        { fields: ['id', 'fillz', 'nmae'] },
        client(),
      )
    ).content[0]
    expect(text).toContain('`fillz`')
    expect(text).toContain('`nmae`')
  })

  it('says what it does take', async () => {
    const { text } = (
      await handleSearch({ fields: ['fillz'] }, client())
    ).content[0]
    for (const known of [
      'fills',
      'characters',
      'childCount',
      'layout',
    ]) {
      expect(text).toContain(known)
    }
  })

  it('lets every real NodeSpec field through', async () => {
    // Derived from the schema, so a field added to NodeSpec is accepted here
    // the day it exists — the `full` profile fell eight fields behind by being
    // a hand-written list, and this vocabulary must not repeat that.
    const result = await handleSearch(
      {
        fields: [
          'id',
          'name',
          'type',
          'layout',
          'sizing',
          'overrides',
          'componentProperties',
        ],
      },
      client(),
    )
    expect(result.content[0].text).not.toContain(
      'INVALID_PARAM',
    )
  })

  it('projects childCount so a flat list can be re-parented', async () => {
    const out = YAML.parse(
      (
        await handleSearch(
          { fields: ['id', 'childCount'] },
          client(),
        )
      ).content[0].text,
    ) as {
      results: { id: string; childCount?: number }[]
    }
    expect(out.results).toEqual([
      { id: '1:1', childCount: 2 },
      { id: '1:2', childCount: 0 },
    ])
  })

  // B64 — the vocabulary is derived from the NodeSpec schema, and `context`
  // rides in on that derivation. A search row never carries it: the reader
  // deletes it post-projection and attaches the capped `contextSummary`
  // instead. So the tool accepted a name it could never honour, and refused
  // the name it always emits.
  it('refuses `context`, and says which field a row carries instead', async () => {
    const sent: Sent[] = []
    const { text } = (
      await handleSearch(
        { fields: ['context'] },
        client(sent),
      )
    ).content[0]
    expect(text).toContain('INVALID_PARAM')
    expect(text).toContain('`context`')
    expect(text).toContain('contextSummary')
    expect(text).toContain('get_node')
    // Refused before the scan, like every other bad entry — the old accept
    // paid for a whole document walk plus a 50-node hydration to return {}.
    expect(sent).toEqual([])
  })

  it('takes `contextSummary` — the name a row actually carries', async () => {
    const { text } = (
      await handleSearch(
        { fields: ['id', 'contextSummary'] },
        client(),
      )
    ).content[0]
    expect(text).not.toContain('INVALID_PARAM')
  })

  it('leaves childCount off a result nobody asked it for', async () => {
    const out = YAML.parse(
      (await handleSearch({ profile: 'full' }, client()))
        .content[0].text,
    ) as { results: Record<string, unknown>[] }
    // `full` is identity over the NodeSpec, and childCount is not one of its
    // fields — putting it there would make search's full row disagree with
    // get_node's for the same node.
    expect('childCount' in out.results[0]).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// I61 — a heavy projection is BOUNDED, not merely bounded-by-default
// ---------------------------------------------------------------------------
//
// Live 2026-08-27, an 838-node dashboard file:
//   search({match:{type:['INSTANCE']}, fields:['id','name','component'],
//           limit:500})   →   {"error":"Command cmd-… timed out","code":"TIMEOUT"}
// The same projection scoped per page with limit:100 succeeded four times over
// and returned 480 instances. B50 bounded the hydration by `limit`, but `limit`
// is the CALLER's number, and a projection that reaches past the scan row costs
// one per-node export EACH — so `limit:500` buys 500 exports and blows the 30s
// command timeout. The bounded-by-default promise (T10) stops holding the
// moment a heavy projection rides a document-wide scan.
//
// The get_components precedent: cap the expensive half, and SAY it was capped.
describe('handleSearch — the hydration is capped (I61)', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({
    id: `1:${i + 1}`,
    name: `Node ${i + 1}`,
    type: 'INSTANCE',
  }))

  const cappedClient = (opts: {
    sent?: Sent[]
  }): ScopedFigmaClient => ({
    fileKey: 'fk-test',
    sendCommand: async (
      command: string,
      params?: Record<string, unknown>,
    ) => {
      opts.sent?.push({ command, params })
      if (command === COMMANDS.GET_NODES) {
        const ids = (params?.nodeIds as string[]) ?? []
        return ids.map(id => ({
          id,
          name: 'N',
          type: 'INSTANCE',
        }))
      }
      return { results: many }
    },
  })

  it('clips a heavy projection to the cap and hands back a cursor', async () => {
    const sent: Sent[] = []
    const result = await handleSearch(
      {
        match: { type: ['INSTANCE'] },
        fields: ['id', 'name', 'component'],
        limit: 500,
      },
      cappedClient({ sent }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: unknown[]
      truncated: boolean
      cursor?: string
      warnings?: string[]
    }
    expect(out.results).toHaveLength(100)
    expect(out.truncated).toBe(true)
    expect(typeof out.cursor).toBe('string')
    // The hydration — the expensive half — never asked for more than the cap.
    const hydration = sent.find(
      x => x.command === COMMANDS.GET_NODES,
    )!
    expect(
      (hydration.params?.nodeIds as string[]).length,
    ).toBe(100)
    // …and the reply SAYS the tool clipped the page.
    const note = (out.warnings ?? []).find(w =>
      w.includes('limit'),
    )
    expect(note).toBeDefined()
    expect(note).toContain('100')
    expect(note).toContain('cursor')
  })

  it('the resumed page keeps the cap and keeps going', async () => {
    const first = await handleSearch(
      { fields: ['id', 'component'], limit: 500 },
      cappedClient({}),
    )
    const out1 = YAML.parse(first.content[0].text) as {
      cursor: string
    }
    const second = await handleSearch(
      {
        fields: ['id', 'component'],
        limit: 500,
        cursor: out1.cursor,
      },
      cappedClient({}),
    )
    const out2 = YAML.parse(second.content[0].text) as {
      results: { id: string }[]
      truncated: boolean
    }
    expect(out2.results).toHaveLength(100)
    expect(out2.truncated).toBe(true)
    expect(out2.results[0].id).toBe('1:101')
  })

  // CONTROL — the cap is on the HYDRATION, not on search. A projection the
  // scan row already answers pays nothing and keeps the caller's limit.
  it('a candidate-only projection keeps the caller’s limit and never hydrates', async () => {
    const sent: Sent[] = []
    const result = await handleSearch(
      { fields: ['id', 'name', 'type'], limit: 500 },
      cappedClient({ sent }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: unknown[]
      truncated: boolean
      warnings?: string[]
    }
    expect(out.results).toHaveLength(300)
    expect(out.truncated).toBe(false)
    expect(
      sent.some(x => x.command === COMMANDS.GET_NODES),
    ).toBe(false)
    expect(out.warnings).toBeUndefined()
  })

  // CONTROL — a limit at or under the cap is untouched, and says nothing.
  it('a limit within the cap is not clipped and carries no note', async () => {
    const result = await handleSearch(
      { fields: ['id', 'component'], limit: 100 },
      cappedClient({}),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: unknown[]
      warnings?: string[]
    }
    expect(out.results).toHaveLength(100)
    expect(out.warnings).toBeUndefined()
  })
})
