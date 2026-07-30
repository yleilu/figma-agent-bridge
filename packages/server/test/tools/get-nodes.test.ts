// get-nodes.test.ts — the rebuilt handleGetNodes (multi-id NodeSpec read).
//
// get_nodes sends COMMANDS.GET_NODES with {nodeIds, depth?, fields?}; the
// plugin returns one entry per id (a raw export, or {id, error} for a miss).
// The server converts each raw export via toNodeSpec(depth) + projectNode and
// returns { results, errors } as YAML — successes in results, misses in errors.

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'
import { handleGetNodes } from '@figma-agent-bridge/server/tools/read'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { ScopedFigmaClient } from '@figma-agent-bridge/server/figma-client'
import cardFixture from '../fixtures/card-node-raw.json'

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

describe('handleGetNodes (rebuilt — NodeSpec)', () => {
  it('sends COMMANDS.GET_NODES with {nodeIds, depth, fields}', async () => {
    const sent: Sent[] = []
    await handleGetNodes(
      {
        nodeIds: ['1:42'],
        depth: 1,
        fields: ['type', 'name'],
      },
      stubClient({ sent, reply: [cardFixture] }),
    )
    expect(sent[0].command).toBe(COMMANDS.GET_NODES)
    expect(sent[0].params?.nodeIds).toEqual(['1:42'])
    expect(sent[0].params?.depth).toBe(1)
    expect(sent[0].params?.fields).toEqual(['type', 'name'])
  })

  it('converts each raw export to a NodeSpec (atom-grammar leaves)', async () => {
    const result = await handleGetNodes(
      { nodeIds: ['1:42'], depth: 0 },
      stubClient({ reply: [cardFixture] }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: Record<string, unknown>[]
      errors: unknown[]
    }
    expect(out.results).toHaveLength(1)
    expect(out.results[0].type).toBe('FRAME')
    const fills = out.results[0].fills as string[]
    expect(typeof fills[0]).toBe('string')
    expect(out.results[0]).not.toHaveProperty('layoutMode')
    expect(out.errors).toHaveLength(0)
  })

  it('routes a {id, error} miss into errors[], not results', async () => {
    const result = await handleGetNodes(
      { nodeIds: ['1:42', 'nope'] },
      stubClient({
        reply: [
          cardFixture,
          { id: 'nope', error: 'Node not found' },
        ],
      }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: Record<string, unknown>[]
      errors: {
        id: string
        error: string
        code: string
      }[]
    }
    expect(out.results).toHaveLength(1)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].id).toBe('nope')
    expect(out.errors[0].error).toContain('not found')
    expect(out.errors[0].code).toBe('NODE_NOT_FOUND')
  })

  it('applies a fields projection to each result', async () => {
    const result = await handleGetNodes(
      { nodeIds: ['1:42'], fields: ['type', 'name'] },
      stubClient({ reply: [cardFixture] }),
    )
    const out = YAML.parse(result.content[0].text) as {
      results: Record<string, unknown>[]
    }
    expect(out.results[0].type).toBe('FRAME')
    expect(out.results[0].name).toBe('Card')
    expect(out.results[0]).not.toHaveProperty('fills')
  })

  it('returns a failure message when the plugin returns null', async () => {
    const result = await handleGetNodes(
      { nodeIds: ['1:42'] },
      stubClient({ reply: null }),
    )
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'Failed to get nodes from plugin.',
      code: 'PLUGIN_ERROR',
    })
  })

  it('returns Unexpected response when the plugin returns a non-array', async () => {
    const result = await handleGetNodes(
      { nodeIds: ['1:42'] },
      stubClient({ reply: { not: 'an array' } }),
    )
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'Unexpected response from plugin',
      code: 'PLUGIN_ERROR',
    })
  })
})
