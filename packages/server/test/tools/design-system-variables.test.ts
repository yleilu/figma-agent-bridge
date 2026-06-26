// design-system-variables.test.ts — handleBindVariable / handleGetVariables.
//
// bind_variable routes through formatMutationResult so a plugin-side {error}
// (which figma-client resolves through, since it only rejects on the WS-level
// error field) is surfaced as an error — NOT mistaken for success. A
// {id,warnings:[...]} degrade (T7 feature-detect/warn) is success-with-warning.

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'
import {
  handleBindVariable,
  handleGetVariables,
} from '@figma-agent-bridge/server/tools/design-system'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'

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
    return opts.reply ?? { id: 'n', warnings: [] }
  },
  disconnect: () => {},
  isConnected: () => opts.connected ?? true,
  currentChannel: () => 'ch',
})

describe('handleBindVariable', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleBindVariable(
      { nodeId: '1:1', variableId: 'v:1', field: 'fills' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.BIND_VARIABLE with {nodeId, variableId, field}', async () => {
    const sent: Sent[] = []
    await handleBindVariable(
      { nodeId: '1:42', variableId: 'v:9', field: 'fills' },
      stubClient({ sent }),
    )
    expect(sent[0].command).toBe(COMMANDS.BIND_VARIABLE)
    expect(sent[0].params).toEqual({
      nodeId: '1:42',
      variableId: 'v:9',
      field: 'fills',
    })
  })

  it('surfaces a plugin-side {error} as an ERROR (not success)', async () => {
    const result = await handleBindVariable(
      { nodeId: '1:42', variableId: 'v:9', field: 'fills' },
      stubClient({
        reply: { error: 'Variable not found: v:9' },
      }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'Variable not found',
    )
  })

  it('surfaces a {id,warnings:[...]} degrade as success-with-warning (never thrown)', async () => {
    const result = await handleBindVariable(
      { nodeId: '1:42', variableId: 'v:9', field: 'fills' },
      stubClient({
        reply: {
          id: '1:42',
          warnings: [
            'setBoundVariable unavailable in this Figma version; binding skipped',
          ],
        },
      }),
    )
    // success path: no "Error:" prefix; warning text present.
    expect(result.content[0].text).not.toContain('Error:')
    expect(result.content[0].text).toContain(
      'setBoundVariable unavailable',
    )
  })
})

describe('handleGetVariables', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleGetVariables(
      {},
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.GET_VARIABLES with {collectionId}', async () => {
    const sent: Sent[] = []
    await handleGetVariables(
      { collectionId: 'col:1' },
      stubClient({ sent, reply: { results: [] } }),
    )
    expect(sent[0].command).toBe(COMMANDS.GET_VARIABLES)
    expect(sent[0].params?.collectionId).toBe('col:1')
  })

  it('renders the collections + variables to text', async () => {
    const result = await handleGetVariables(
      {},
      stubClient({
        reply: {
          results: [
            {
              id: 'col:1',
              name: 'Brand',
              modes: [{ modeId: 'm1', name: 'Light' }],
              variables: [
                {
                  id: 'v:9',
                  name: 'Brand/Primary',
                  resolvedType: 'COLOR',
                  valuesByMode: {
                    m1: { r: 1, g: 0, b: 0 },
                  },
                },
              ],
            },
          ],
        },
      }),
    )
    expect(result.content[0].text).toContain(
      'Brand/Primary',
    )
    expect(result.content[0].text).toContain('v:9')
  })

  // Rule-A list envelope (D1): get_variables wraps its collections in the SAME
  // { results, truncated: false } shape as the shipped sibling reads
  // (get_styles / get_components / list_fonts) — NOT a Markdown header followed
  // by a bare top-level YAML array. Bounded read → no cursor input or output.
  it('wraps collections in the Rule-A { results, truncated:false } envelope', async () => {
    const result = await handleGetVariables(
      {},
      stubClient({
        reply: {
          results: [
            {
              id: 'col:1',
              name: 'Brand',
              modes: [{ modeId: 'm1', name: 'Light' }],
              variables: [
                {
                  id: 'v:9',
                  name: 'Brand/Primary',
                  resolvedType: 'COLOR',
                  valuesByMode: {
                    m1: { r: 1, g: 0, b: 0 },
                  },
                  scopes: ['ALL_SCOPES'],
                },
              ],
            },
          ],
        },
      }),
    )
    const { text } = result.content[0]
    // No leading Markdown header line (the dropped "# N collections, …").
    expect(text.startsWith('#')).toBe(false)
    // The whole payload parses as the Rule-A envelope OBJECT, not a bare array.
    const out = YAML.parse(text) as {
      results: {
        id: string
        name: string
        variables: { id: string; name: string }[]
      }[]
      truncated: boolean
    }
    expect(Array.isArray(out)).toBe(false)
    expect(out.truncated).toBe(false)
    // No cursor key (bounded read, consistent with the shipped siblings).
    expect('cursor' in out).toBe(false)
    // Collection/variable DATA unchanged — only the wrapper.
    expect(out.results).toHaveLength(1)
    expect(out.results[0].id).toBe('col:1')
    expect(out.results[0].variables[0].name).toBe(
      'Brand/Primary',
    )
  })

  it('renders COLOR valuesByMode to hex atoms and surfaces scopes/codeSyntax/hiddenFromPublishing', async () => {
    const result = await handleGetVariables(
      {},
      stubClient({
        reply: {
          results: [
            {
              id: 'col:1',
              name: 'Brand',
              modes: [{ modeId: 'm1', name: 'Light' }],
              variables: [
                {
                  id: 'var:123',
                  name: 'Brand/Primary',
                  resolvedType: 'COLOR',
                  valuesByMode: {
                    m1: { r: 1, g: 0, b: 0, a: 1 },
                  },
                  aliases: [],
                  scopes: ['ALL_SCOPES'],
                  codeSyntax: { WEB: '--brand-primary' },
                  hiddenFromPublishing: false,
                },
              ],
            },
          ],
        },
      }),
    )
    const { text } = result.content[0]
    // COLOR valuesByMode rendered to a hex atom (server-side).
    expect(text).toContain('#FF0000')
    expect(text).toContain('ALL_SCOPES')
    expect(text).toContain('--brand-primary')
    expect(text).toContain('hiddenFromPublishing')
  })

  it('passes through FLOAT/STRING values and alias refs unchanged', async () => {
    const result = await handleGetVariables(
      {},
      stubClient({
        reply: {
          results: [
            {
              id: 'col:2',
              name: 'Spacing',
              modes: [{ modeId: 'm1', name: 'Default' }],
              variables: [
                {
                  id: 'var:200',
                  name: 'space/md',
                  resolvedType: 'FLOAT',
                  valuesByMode: { m1: 16 },
                  aliases: [],
                  scopes: ['GAP'],
                },
                {
                  id: 'var:201',
                  name: 'space/alias',
                  resolvedType: 'FLOAT',
                  valuesByMode: {
                    m1: {
                      type: 'VARIABLE_ALIAS',
                      id: 'var:200',
                    },
                  },
                  aliases: [
                    {
                      type: 'VARIABLE_ALIAS',
                      id: 'var:200',
                    },
                  ],
                  scopes: ['GAP'],
                },
              ],
            },
          ],
        },
      }),
    )
    const { text } = result.content[0]
    expect(text).toContain('16')
    // alias ref preserved (not rendered to a hex atom).
    expect(text).toContain('VARIABLE_ALIAS')
  })

  // T10 — server-side pagination over the top-level COLLECTIONS list. The plugin
  // returns all collections; the SERVER bounds the AGENT-CONTEXT via paginateList.
  const manyCollections = (n: number) => ({
    results: Array.from({ length: n }, (_, i) => ({
      id: `col:${i}`,
      name: `Collection ${i}`,
      modes: [{ modeId: 'm1', name: 'Default' }],
      variables: [
        {
          id: `v:${i}`,
          name: `var ${i}`,
          resolvedType: 'FLOAT',
          valuesByMode: { m1: i },
        },
      ],
    })),
  })

  it('paginates with limit: page 1 truncated + cursor', async () => {
    const result = await handleGetVariables(
      { limit: 2 },
      stubClient({ reply: manyCollections(5) }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { id: string }[]
      truncated: boolean
      cursor?: string
    }
    expect(out.results).toHaveLength(2)
    expect(out.results[0].id).toBe('col:0')
    expect(out.truncated).toBe(true)
    expect(typeof out.cursor).toBe('string')
  })

  it('resumes from a cursor on the next page', async () => {
    const page1 = await handleGetVariables(
      { limit: 2 },
      stubClient({ reply: manyCollections(4) }),
    )
    const out1 = YAML.parse(page1.content[0].text) as {
      cursor: string
    }
    const page2 = await handleGetVariables(
      { limit: 2, cursor: out1.cursor },
      stubClient({ reply: manyCollections(4) }),
    )
    const out2 = YAML.parse(page2.content[0].text) as {
      results: { id: string }[]
      truncated: boolean
      cursor?: string
    }
    expect(out2.results).toHaveLength(2)
    expect(out2.results[0].id).toBe('col:2')
    expect(out2.truncated).toBe(false)
    expect(out2).not.toHaveProperty('cursor')
  })

  it('reports a STALE cursor without throwing when the set changed', async () => {
    const page1 = await handleGetVariables(
      { limit: 2 },
      stubClient({ reply: manyCollections(5) }),
    )
    const out1 = YAML.parse(page1.content[0].text) as {
      cursor: string
    }
    const stale = await handleGetVariables(
      { limit: 2, cursor: out1.cursor },
      stubClient({ reply: manyCollections(2) }),
    )
    const { text } = stale.content[0]
    expect(text).toContain('Cursor rejected (STALE)')
    expect(text.toLowerCase()).toContain('re-run')
  })

  it('single-page behavior unchanged: no cursor when it fits', async () => {
    const result = await handleGetVariables(
      {},
      stubClient({
        reply: {
          results: [
            {
              id: 'col:1',
              name: 'Brand',
              modes: [{ modeId: 'm1', name: 'Light' }],
              variables: [],
            },
          ],
        },
      }),
    )
    const out = YAML.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(out.truncated).toBe(false)
    expect(out).not.toHaveProperty('cursor')
  })
})
