// update.test.ts — handleUpdateNode unit tests (stub FigmaClient, no relay).
//
// Proves: only supplied keys are forwarded (specToFigma injects no defaults);
// atom leaves are parsed on the write face (#FF0000 → SOLID paint); the
// not-connected guard short-circuits.

import { describe, expect, it } from 'bun:test'
import { handleUpdateNode } from '@figma-agent-bridge/server/tools/update'
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
    return (
      opts.reply ?? {
        id: 'n',
        name: 'N',
        type: 'FRAME',
        warnings: [],
      }
    )
  },
})

describe('handleUpdateNode', () => {
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

  it('B45 — forwards a path atom as the geometry the plugin assigns, and calls it a known key', async () => {
    // The write face has always converted vectorPaths, and update_node has
    // always sent it. It was the plugin that never applied it, so the arm that
    // stays testable headlessly is this one: the canonical atom a read emits
    // reaches the plugin as Figma's own {windingRule, data}, and nothing
    // reports it as an unknown key.
    const sent: Sent[] = []
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: {
          name: 'X',
          vectorPaths: [
            'path(NONZERO,"M 12 0 L 24 24 L 0 24 Z")',
          ],
        },
      },
      stubClient({ sent }),
    )
    const spec = sent[0].params?.spec as {
      vectorPaths: { windingRule: string; data: string }[]
    }
    expect(spec.vectorPaths).toEqual([
      {
        windingRule: 'NONZERO',
        data: 'M 12 0 L 24 24 L 0 24 Z',
      },
    ])
    expect(result.content[0].text).not.toContain(
      'vectorPaths',
    )
  })

  it('surfaces a plugin-side {error} as an error (not success)', async () => {
    const result = await handleUpdateNode(
      { nodeId: '1:42', patch: { opacity: 0.5 } },
      stubClient({
        reply: { error: 'Node not found: 1:42' },
      }),
    )
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.error).toContain('Node not found')
    expect(data.code).toBe('NODE_NOT_FOUND')
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

  // 3c: a server-side writer warning (GRID-only layout keys on a non-GRID
  // mode) is MERGED into the reply's structured warnings[] — one concept, one
  // surface — rather than appended as loose trailing text after the JSON.
  it('merges server-side writer warnings into the structured warnings[]', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: { layout: { mode: 'V', rows: 2 } },
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
    // Both the plugin warning and the server writer warning live in warnings[].
    expect(out.warnings).toContain('a plugin warning')
    expect(
      out.warnings.some(w =>
        w.includes(
          'rows/cols/rowGap/colGap keys are GRID-only',
        ),
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

// An unrecognised patch key is a SILENT no-op: the zod object strips it, the
// converter never sees it, and the reply says success with an empty
// `warnings[]`. `update_node({patch:{x:10}})` therefore reports that it moved
// a node it did not touch. tool-surface.md is silent on unknown keys but
// explicit that update_node "warns on no-op" (T7 honesty) — so it warns.
describe('handleUpdateNode — unknown patch keys are never silent', () => {
  it('warns, naming the key, and points at the field that DOES exist', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: { x: 10 } as Record<string, unknown>,
      },
      stubClient({}),
    )
    const data = JSON.parse(result.content[0].text) as {
      warnings: string[]
    }
    expect(data.warnings).toHaveLength(1)
    expect(data.warnings[0]).toContain('x')
    expect(data.warnings[0]).toContain('position')
  })

  it('says the patch changed NOTHING when every key is unknown', async () => {
    const sent: Sent[] = []
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: { x: 10, y: 20 } as Record<string, unknown>,
      },
      stubClient({ sent }),
    )
    // The converter produced an EMPTY spec — nothing was asked of the plugin.
    expect(sent[0].params?.spec).toEqual({})
    const data = JSON.parse(result.content[0].text) as {
      warnings: string[]
    }
    expect(data.warnings.join(' ')).toContain(
      'nothing was changed',
    )
  })

  // A read-modify-write echoes the read's own honesty fields back. They are
  // NodeSpec fields (expression-formats.md → Read-only node fields), just
  // read-only ones — so the warning must say READ-ONLY, never that the field
  // does not exist, which would contradict the grammar the agent read.
  it('calls an echoed read-only field read-only, not unknown', async () => {
    const result = await handleUpdateNode(
      {
        nodeId: '1:42',
        patch: {
          readError: 'node not found',
          position: [10, 20],
        } as Record<string, unknown>,
      },
      stubClient({}),
    )
    const data = JSON.parse(result.content[0].text) as {
      warnings: string[]
    }
    expect(data.warnings).toHaveLength(1)
    expect(data.warnings[0]).toContain('readError')
    expect(data.warnings[0]).toContain('read-only')
    expect(data.warnings[0]).not.toContain(
      'not a NodeSpec field',
    )
  })

  it('stays silent about keys it DOES know', async () => {
    const result = await handleUpdateNode(
      { nodeId: '1:42', patch: { position: [10, 20] } },
      stubClient({}),
    )
    const data = JSON.parse(result.content[0].text) as {
      warnings?: string[]
    }
    expect(data.warnings ?? []).toEqual([])
  })
})

// ─── B57: the one-way clamp warning reaches the agent ────────────────────────
//
// The write itself is faithful — Figma's min/max IS a one-way clamp, and the
// plugin does a plain property set. What was wrong is that `update_node`
// answered ok with `warnings: []` while a size the operator had set by hand was
// destroyed: dropping a min back down left the clamped value in place, on an
// overridden instance, on a hugging instance, and on the hugging master.

describe('handleUpdateNode — one-way clamp warning (B57)', () => {
  const warningsOf = async (
    patch: Record<string, unknown>,
  ): Promise<string[]> => {
    const result = await handleUpdateNode(
      { nodeId: '1:42', patch },
      stubClient({
        reply: {
          id: '1:42',
          name: 'Card',
          type: 'FRAME',
          warnings: [],
        },
      }),
    )
    const reply = JSON.parse(result.content[0].text) as {
      warnings?: string[]
    }
    return reply.warnings ?? []
  }

  it('warns, naming the field, when a floor is written', async () => {
    const warnings = await warningsOf({ minHeight: 240 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('minHeight')
  })

  it('warns when a floor is CLEARED — the clear restores nothing', async () => {
    const warnings = await warningsOf({ minWidth: null })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('minWidth')
    expect(warnings[0]).toContain('restore')
  })

  it('stays silent on a patch that moves no clamp', async () => {
    expect(await warningsOf({ opacity: 0.5 })).toEqual([])
  })

  it('never reports ok with empty warnings for a clamp write', async () => {
    // The B57 failure shape verbatim: ok + warnings:[] while a size was lost.
    const result = await handleUpdateNode(
      { nodeId: '1:42', patch: { minWidth: 320 } },
      stubClient({
        reply: {
          id: '1:42',
          name: 'State block',
          type: 'COMPONENT',
          warnings: [],
        },
      }),
    )
    const reply = JSON.parse(result.content[0].text) as {
      warnings?: string[]
    }
    expect(reply.warnings ?? []).not.toHaveLength(0)
  })
})

// ─── B58: the pair is refused before anything is sent ────────────────────────
//
// A refused write must reach nothing: the point of catching it on the server is
// that no half-applied layout exists to clean up.

describe('handleUpdateNode — SPACE_BETWEEN + bound gap (B58)', () => {
  const pair = {
    layout: {
      mode: 'H' as const,
      align: ['SPACE_BETWEEN', 'CENTER'],
      gap: 'var(space/16)16',
    },
  }

  it('refuses, names the node, and sends NOTHING', async () => {
    const sent: Sent[] = []
    const result = await handleUpdateNode(
      { nodeId: '454:4934', patch: pair as never },
      stubClient({ sent }),
    )
    const { text } = result.content[0]
    expect(text).toContain('SPACE_BETWEEN')
    expect(text).toContain('454:4934')
    expect(sent).toHaveLength(0)
  })

  it('accepts SPACE_BETWEEN with a literal gap, and sends it', async () => {
    const sent: Sent[] = []
    await handleUpdateNode(
      {
        nodeId: '454:4934',
        patch: {
          layout: {
            mode: 'H',
            align: ['SPACE_BETWEEN', 'CENTER'],
            gap: 16,
          },
        } as never,
      },
      stubClient({ sent }),
    )
    expect(sent).toHaveLength(1)
    const spec = sent[0].params?.spec as {
      layout: { spacing: number }
    }
    expect(spec.layout.spacing).toBe(16)
  })
})
