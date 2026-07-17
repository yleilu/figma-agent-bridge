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
    return opts.reply ?? { id: 'n', warnings: [] }
  },
})

describe('handleBindVariable', () => {
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

// ─── M13 — bind_variable mode param ──────────────────────────────────────────

describe('handleBindVariable — mode param (M13)', () => {
  it('forwards mode map to COMMANDS.BIND_VARIABLE when variableId/field omitted (pure mode-set)', async () => {
    const sent: Sent[] = []
    await handleBindVariable(
      {
        nodeId: '1:42',
        mode: { 'col:1': { modeId: 'm:1' } },
      },
      stubClient({ sent }),
    )
    expect(sent[0].command).toBe(COMMANDS.BIND_VARIABLE)
    expect(sent[0].params?.nodeId).toBe('1:42')
    expect(sent[0].params?.mode).toEqual({
      'col:1': { modeId: 'm:1' },
    })
    // variableId and field must NOT be in params when omitted
    expect(sent[0].params?.variableId).toBeUndefined()
    expect(sent[0].params?.field).toBeUndefined()
  })

  it('forwards both mode AND variableId/field when all are provided', async () => {
    const sent: Sent[] = []
    await handleBindVariable(
      {
        nodeId: '1:42',
        variableId: 'v:9',
        field: 'fills',
        mode: { 'col:1': { modeId: 'm:1' } },
      },
      stubClient({ sent }),
    )
    expect(sent[0].params?.mode).toEqual({
      'col:1': { modeId: 'm:1' },
    })
    expect(sent[0].params?.variableId).toBe('v:9')
    expect(sent[0].params?.field).toBe('fills')
  })

  it('forwards modeName-based entries through to the plugin', async () => {
    const sent: Sent[] = []
    await handleBindVariable(
      {
        nodeId: '1:42',
        mode: { 'col:1': { modeName: 'Dark' } },
      },
      stubClient({ sent }),
    )
    expect(sent[0].params?.mode).toEqual({
      'col:1': { modeName: 'Dark' },
    })
  })

  it('forwards clearMode:true entries through to the plugin', async () => {
    const sent: Sent[] = []
    await handleBindVariable(
      {
        nodeId: '1:42',
        mode: { 'col:1': { clearMode: true } },
      },
      stubClient({ sent }),
    )
    expect(sent[0].params?.mode).toEqual({
      'col:1': { clearMode: true },
    })
  })

  it('returns INVALID_PARAM error when neither variableId/field nor mode is provided', async () => {
    const result = await handleBindVariable(
      { nodeId: '1:42' },
      stubClient({}),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'INVALID_PARAM',
    )
  })

  it('returns warning (not error) when plugin reports unknown-mode degrade', async () => {
    const result = await handleBindVariable(
      {
        nodeId: '1:42',
        mode: { 'col:1': { modeName: 'Nonexistent' } },
      },
      stubClient({
        reply: {
          id: '1:42',
          warnings: [
            'unknown mode "Nonexistent" in collection col:1; mode pin skipped',
          ],
        },
      }),
    )
    expect(result.content[0].text).not.toContain('Error:')
    expect(result.content[0].text).toContain('unknown mode')
  })

  it('returns warning (not error) when plugin reports unavailable-API degrade', async () => {
    const result = await handleBindVariable(
      {
        nodeId: '1:42',
        mode: { 'col:1': { modeId: 'm:1' } },
      },
      stubClient({
        reply: {
          id: '1:42',
          warnings: [
            'setExplicitVariableModeForCollection unavailable in this Figma version; mode pin skipped',
          ],
        },
      }),
    )
    expect(result.content[0].text).not.toContain('Error:')
    expect(result.content[0].text).toContain(
      'setExplicitVariableModeForCollection unavailable',
    )
  })
})

describe('handleGetVariables', () => {
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

  // B2 — aliases round-trip: plugin sends mode-keyed Record<modeId, targetId>;
  // server maps modeId → modeName so the read shape matches the write shape
  // (Record<modeName, targetVarId>) that create/update_variables consume.
  it('maps plugin mode-keyed aliases (modeId→targetId) to modeName→targetVarId (B2)', async () => {
    const result = await handleGetVariables(
      {},
      stubClient({
        reply: {
          results: [
            {
              id: 'col:1',
              name: 'Brand',
              modes: [
                { modeId: 'm1', name: 'Light' },
                { modeId: 'm2', name: 'Dark' },
              ],
              variables: [
                {
                  id: 'var:10',
                  name: 'Brand/Secondary',
                  resolvedType: 'COLOR',
                  valuesByMode: {
                    m1: { r: 1, g: 0, b: 0, a: 1 },
                    m2: {
                      type: 'VARIABLE_ALIAS',
                      id: 'var:primary',
                    },
                  },
                  // Plugin now sends mode-keyed map (modeId → targetId)
                  aliases: { m2: 'var:primary' },
                  scopes: [],
                },
              ],
            },
          ],
        },
      }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: {
        variables: {
          aliases?: Record<string, string>
        }[]
      }[]
    }
    const { aliases } = out.results[0].variables[0]
    // After translation: key is modeName ('Dark'), not modeId ('m2')
    expect(aliases).toBeDefined()
    expect(aliases?.Dark).toBe('var:primary')
    // modeId key must NOT appear in the output
    expect(aliases?.m2).toBeUndefined()
  })

  it('omits aliases key when no alias entries exist (B2)', async () => {
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
                  id: 'var:10',
                  name: 'Brand/Primary',
                  resolvedType: 'COLOR',
                  valuesByMode: {
                    m1: { r: 1, g: 0, b: 0, a: 1 },
                  },
                  aliases: {},
                  scopes: [],
                },
              ],
            },
          ],
        },
      }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { variables: { aliases?: unknown }[] }[]
    }
    const { aliases } = out.results[0].variables[0]
    // Empty alias map should not bloat the output
    expect(
      aliases === null ||
        aliases === undefined ||
        Object.keys(aliases as object).length === 0,
    ).toBe(true)
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
