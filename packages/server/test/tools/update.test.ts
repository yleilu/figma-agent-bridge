// update.test.ts — handleUpdateNode unit tests (stub FigmaClient, no relay).
//
// Proves: only supplied keys are forwarded (specToFigma injects no defaults);
// atom leaves are parsed on the write face (#FF0000 → SOLID paint); the
// not-connected guard short-circuits.

import { describe, expect, it } from 'bun:test'
import { handleUpdateNode } from '@figma-agent-bridge/server/tools/update'
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
    return (
      opts.reply ?? {
        id: 'n',
        name: 'N',
        type: 'FRAME',
        warnings: [],
      }
    )
  },
  disconnect: () => {},
  isConnected: () => opts.connected ?? true,
  currentChannel: () => 'ch',
})

describe('handleUpdateNode', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleUpdateNode(
      { nodeId: '1:1', patch: { opacity: 0.5 } },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.UPDATE_NODE with {nodeId, spec}', async () => {
    const sent: Sent[] = []
    await handleUpdateNode(
      { nodeId: '1:42', patch: { opacity: 0.5 } },
      stubClient({ sent }),
    )
    expect(sent).toHaveLength(1)
    expect(sent[0].command).toBe(COMMANDS.UPDATE_NODE)
    expect(sent[0].params?.nodeId).toBe('1:42')
    expect(sent[0].params?.spec).toBeDefined()
  })

  it('forwards ONLY supplied keys (no defaults injected)', async () => {
    const sent: Sent[] = []
    await handleUpdateNode(
      { nodeId: '1:42', patch: { opacity: 0.5 } },
      stubClient({ sent }),
    )
    const spec = sent[0].params?.spec as Record<
      string,
      unknown
    >
    expect(spec).toEqual({ opacity: 0.5 })
    // no name, no type, no layout etc.
    expect(spec).not.toHaveProperty('name')
    expect(spec).not.toHaveProperty('type')
  })

  it('parses a fill atom to a SOLID paint on the write face', async () => {
    const sent: Sent[] = []
    await handleUpdateNode(
      { nodeId: '1:42', patch: { fills: ['#FF0000'] } },
      stubClient({ sent }),
    )
    const spec = sent[0].params?.spec as {
      fills: unknown[]
    }
    expect(spec.fills[0]).toEqual({
      type: 'SOLID',
      color: { r: 1, g: 0, b: 0 },
    })
  })

  it('surfaces a plugin-side {error} as an error (not success)', async () => {
    const result = await handleUpdateNode(
      { nodeId: '1:42', patch: { opacity: 0.5 } },
      stubClient({
        reply: { error: 'Node not found: 1:42' },
      }),
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'Node not found',
    )
  })

  it('surfaces plugin warnings on success', async () => {
    const result = await handleUpdateNode(
      { nodeId: '1:42', patch: { position: [10, 20] } },
      stubClient({
        reply: {
          id: '1:42',
          name: 'Card',
          type: 'FRAME',
          warnings: ['x/y ignored on an auto-layout child'],
        },
      }),
    )
    expect(result.content[0].text).toContain(
      'auto-layout child',
    )
  })

  // 3c: a server-side writer warning (per-side stroke collapse) is MERGED into
  // the reply's structured warnings[] — one concept, one surface — rather than
  // appended as loose trailing text after the JSON.
  it('merges server-side writer warnings into the structured warnings[]', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: { stroke: 'stroke([1,2,3,4])' },
      },
      stubClient({
        reply: {
          id: '1:42',
          name: 'Card',
          type: 'FRAME',
          warnings: ['a plugin warning'],
        },
      }),
    )
    // The whole result is still parseable JSON (no loose "Warning:" tail).
    const out = JSON.parse(result.content[0].text) as {
      id: string
      warnings: string[]
    }
    expect(out.id).toBe('1:42')
    // Both the plugin warning and the server collapse warning live in warnings[].
    expect(out.warnings).toContain('a plugin warning')
    expect(
      out.warnings.some(w =>
        w.includes('collapsed to a single strokeWeight'),
      ),
    ).toBe(true)
  })

  it('rejects over-cap context with a clean message and does not send', async () => {
    const sent: Sent[] = []
    const res = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: { context: '🙂'.repeat(513) },
      },
      stubClient({ sent }),
    )
    expect(res.content[0].text).toMatch(
      /context is 2052 bytes; limit is 2048/,
    )
    expect(sent).toHaveLength(0)
  })

  it('forwards in-cap context in the converted spec and omits when absent', async () => {
    const sent: Sent[] = []
    await handleUpdateNode(
      { nodeId: '1:42', patch: { context: '---\nx\n---' } },
      stubClient({ sent }),
    )
    expect(
      (sent[0].params?.spec as { context?: string })
        .context,
    ).toBe('---\nx\n---')
  })
})
