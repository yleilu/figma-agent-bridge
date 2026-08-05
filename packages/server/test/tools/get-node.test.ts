// get-node.test.ts — the rebuilt handleGetNode (NodeSpec read, fidelity-first).
//
// get_node sends COMMANDS.GET_NODE → raw export → toNodeSpec(depth) →
// projectNode(fields/profile) → YAML. It NEVER budget-truncates. Depth past the
// boundary collapses children to IdStubs.

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'
import { handleGetNode } from '@figma-agent-bridge/server/tools/read'
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

describe('handleGetNode (rebuilt — NodeSpec)', () => {
  it('sends COMMANDS.GET_NODE with {nodeId, depth}', async () => {
    const sent: Sent[] = []
    await handleGetNode(
      { nodeId: '1:42', depth: 0 },
      stubClient({ sent, reply: cardFixture }),
    )
    expect(sent[0].command).toBe(COMMANDS.GET_NODE)
    expect(sent[0].params?.nodeId).toBe('1:42')
    expect(sent[0].params?.depth).toBe(0)
  })

  it('emits a NodeSpec with atom-grammar leaves (not raw JSON_REST_V1)', async () => {
    const result = await handleGetNode(
      { nodeId: '1:42', depth: 0 },
      stubClient({ reply: cardFixture }),
    )
    const { text } = result.content[0]
    const spec = YAML.parse(text) as Record<string, unknown>
    expect(spec.type).toBe('FRAME')
    expect(spec.name).toBe('Card')
    // atom-grammar fill (var-wrapped white), NOT a JSON_REST_V1 paint object.
    const fills = spec.fills as string[]
    expect(typeof fills[0]).toBe('string')
    expect(fills[0]).toMatch(/var\(.*\)#FFFFFF/)
    // NOT the raw shape: no layoutMode / absoluteBoundingBox keys.
    expect(spec).not.toHaveProperty('layoutMode')
    expect(spec).not.toHaveProperty('absoluteBoundingBox')
  })

  it('depth=0 collapses children to IdStubs (drill-by-id)', async () => {
    const result = await handleGetNode(
      { nodeId: '1:42', depth: 0 },
      stubClient({ reply: cardFixture }),
    )
    const spec = YAML.parse(result.content[0].text) as {
      children: { id: string; childCount: number }[]
    }
    expect(spec.children[0].id).toBe('1:43')
    expect(spec.children[0].childCount).toBe(0)
  })

  it('returns Node not found when the plugin returns null', async () => {
    const result = await handleGetNode(
      { nodeId: 'nope' },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toContain('not found')
  })

  it('emits position so get_node→create_node/update_node round-trips x/y', async () => {
    const result = await handleGetNode(
      { nodeId: '1:42', depth: 0 },
      stubClient({ reply: cardFixture }),
    )
    const spec = YAML.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    // relativeTransform [[1,0,100],[0,1,200]] → [100,200].
    expect(spec.position).toEqual([100, 200])
  })

  it('applies a fields projection', async () => {
    const result = await handleGetNode(
      { nodeId: '1:42', fields: ['type', 'name'] },
      stubClient({ reply: cardFixture }),
    )
    const spec = YAML.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(spec.type).toBe('FRAME')
    expect(spec.name).toBe('Card')
    expect(spec).not.toHaveProperty('fills')
  })

  it('maps a thrown plugin error to a tool-formatted message', async () => {
    const client: ScopedFigmaClient = {
      fileKey: 'fk-test',
      sendCommand: () =>
        Promise.reject(new Error('plugin exploded')),
    }
    const result = await handleGetNode(
      { nodeId: '1:42' },
      client,
    )
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.error).toBe('plugin exploded')
    expect(data.code).toBe('PLUGIN_ERROR')
  })

  it('emits vectorPaths as path atoms for a VECTOR node (enriched by plugin)', async () => {
    // The plugin enriches the exportAsync result with node.vectorPaths before
    // returning it to the server. The reader converts those objects to path atoms.
    const vectorFixture = {
      id: '5:1',
      name: 'Arrow',
      type: 'VECTOR',
      absoluteBoundingBox: {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
      // vectorPaths is injected by the plugin (not from exportAsync JSON_REST_V1)
      vectorPaths: [
        { windingRule: 'NONZERO', data: 'M0 0 L10 0 Z' },
      ],
    }
    const result = await handleGetNode(
      { nodeId: '5:1', depth: 0 },
      stubClient({ reply: vectorFixture }),
    )
    const spec = YAML.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(spec.type).toBe('VECTOR')
    // vectorPaths should be read back as path atoms
    const vp = spec.vectorPaths as string[]
    expect(Array.isArray(vp)).toBe(true)
    expect(vp[0]).toBe('path(NONZERO,"M0 0 L10 0 Z")')
  })
})
