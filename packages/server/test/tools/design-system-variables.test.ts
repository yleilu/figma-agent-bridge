// design-system-variables.test.ts — handleBindVariable / handleGetVariables.
//
// bind_variable routes through formatMutationResult so a plugin-side {error}
// (which figma-client resolves through, since it only rejects on the WS-level
// error field) is surfaced as an error — NOT mistaken for success. A
// {id,warnings:[...]} degrade (T7 feature-detect/warn) is success-with-warning.

import { describe, expect, it } from 'bun:test'
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
})
