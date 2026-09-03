// depth-honesty.test.ts — one rule, three readers (I64).
//
// `get_node({nodeId, depth:2, profile:'minimal'})` returned the node with no
// `children` key, no warning and no error: the read descended and the
// projection threw the descent away. `get_nodes` and `inspect` did the same.
// The surface now REFUSES the contradiction and names both ways out (the
// design decision and its three reasons live in read/depth-projection.ts).
//
// Asserted at the HANDLER, not on the pure helper, because the point of the
// item is that all three readers behave the same and that none of them
// contacts the plugin before refusing.

import { describe, expect, it } from 'bun:test'
import {
  handleGetNode,
  handleGetNodes,
  handleInspect,
} from '@figma-agent-bridge/server/tools/read'
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

const parse = (text: string): Record<string, unknown> =>
  JSON.parse(text) as Record<string, unknown>

describe('depth honesty — the triage repro (I64)', () => {
  it('get_node refuses depth:2 + profile:minimal, before contacting the plugin', async () => {
    const sent: Sent[] = []
    const result = await handleGetNode(
      { nodeId: '1:42', depth: 2, profile: 'minimal' },
      stubClient({ sent, reply: cardFixture }),
    )
    const data = parse(result.content[0].text)
    expect(data.code).toBe('INVALID_PARAM')
    expect(data.error).toContain('depth:2')
    expect(data.error).toContain('children')
    expect(sent).toHaveLength(0)
  })

  it('get_nodes refuses the same pair, on the same terms', async () => {
    const sent: Sent[] = []
    const result = await handleGetNodes(
      { nodeIds: ['1:42'], depth: 2, profile: 'minimal' },
      stubClient({ sent, reply: [cardFixture] }),
    )
    const data = parse(result.content[0].text)
    expect(data.code).toBe('INVALID_PARAM')
    expect(sent).toHaveLength(0)
  })

  it('inspect refuses the same pair, on the same terms', async () => {
    const sent: Sent[] = []
    const result = await handleInspect(
      { nodeId: '1:42', depth: 2, profile: 'minimal' },
      stubClient({ sent, reply: cardFixture }),
    )
    const data = parse(result.content[0].text)
    expect(data.code).toBe('INVALID_PARAM')
    expect(sent).toHaveLength(0)
  })

  it('a fields list that names children is accepted and descends', async () => {
    const sent: Sent[] = []
    const result = await handleGetNode(
      {
        nodeId: '1:42',
        depth: 2,
        fields: ['id', 'name', 'children'],
      },
      stubClient({ sent, reply: cardFixture }),
    )
    expect(sent[0].params?.depth).toBe(2)
    const spec = parse(result.content[0].text)
    expect(Array.isArray(spec.children)).toBe(true)
  })

  it("profile:'full' with a depth is accepted — it drops nothing", async () => {
    const sent: Sent[] = []
    await handleGetNode(
      { nodeId: '1:42', depth: 2, profile: 'full' },
      stubClient({ sent, reply: cardFixture }),
    )
    expect(sent).toHaveLength(1)
  })

  it('a narrowing projection with NO depth still works — nothing to lose', async () => {
    const sent: Sent[] = []
    const result = await handleGetNode(
      { nodeId: '1:42', profile: 'minimal' },
      stubClient({ sent, reply: cardFixture }),
    )
    expect(sent).toHaveLength(1)
    const spec = parse(result.content[0].text)
    expect(spec.children).toBeUndefined()
    expect(typeof spec.id).toBe('string')
  })
})
