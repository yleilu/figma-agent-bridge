// inspect.test.ts — the rebuilt handleInspect (Rule B: depth + budget + receipt).
//
// inspect sends COMMANDS.INSPECT → toNodeSpec(depth=-1) → truncateTree (which
// calls read/budget when a budget is set) → match → project → {view,
// truncated:[{id,childCount}]} rendered as YAML. NOT a bespoke budgeted view —
// it consumes the P0 read/* primitives directly.

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'
import { handleInspect } from '@figma-agent-bridge/server/tools/read'
import { estimateTokens } from '@figma-agent-bridge/server/read/budget'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { ScopedFigmaClient } from '@figma-agent-bridge/server/figma-client'
import deepTree from '../fixtures/deep-tree-raw.json'
import cardNode from '../fixtures/card-node-raw.json'

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

const parse = (
  text: string,
): {
  view: Record<string, unknown>
  truncated: { id: string; childCount: number }[]
} =>
  YAML.parse(text) as {
    view: Record<string, unknown>
    truncated: { id: string; childCount: number }[]
  }

describe('handleInspect (rebuilt — Rule B)', () => {
  it('sends COMMANDS.INSPECT', async () => {
    const sent: Sent[] = []
    await handleInspect(
      { nodeId: '10:0', depth: 0 },
      stubClient({ sent, reply: deepTree }),
    )
    expect(sent[0].command).toBe(COMMANDS.INSPECT)
    expect(sent[0].params?.nodeId).toBe('10:0')
  })

  // B23: the plugin bounds its enrichment by the `depth` it is handed and has
  // no budget of its own to reason from, so the depth on the wire is the
  // RESOLVED one — the same rule truncateTree applies.
  it('sends a RESOLVED depth: 0 by default, -1 when only a budget was asked for', async () => {
    const sent: Sent[] = []
    const client = stubClient({ sent, reply: deepTree })
    await handleInspect({ nodeId: '10:0' }, client)
    expect(sent[0].params?.depth).toBe(0)

    await handleInspect(
      { nodeId: '10:0', budget: 500 },
      client,
    )
    expect(sent[1].params?.depth).toBe(-1)

    await handleInspect(
      { nodeId: '10:0', depth: 2, budget: 500 },
      client,
    )
    expect(sent[2].params?.depth).toBe(2)
  })

  it('returns {view, truncated} with an empty receipt for a small tree (depth=-1)', async () => {
    const result = await handleInspect(
      { nodeId: '10:0', depth: -1 },
      stubClient({ reply: deepTree }),
    )
    const out = parse(result.content[0].text)
    expect(out.view).toBeDefined()
    expect(out.truncated).toEqual([])
  })

  it('no budget + no depth defaults to depth=0 (children become stubs)', async () => {
    const result = await handleInspect(
      { nodeId: '10:0' },
      stubClient({ reply: deepTree }),
    )
    const out = parse(result.content[0].text)
    const children = out.view.children as {
      id: string
      childCount: number
    }[]
    // depth=0 collapses the children to IdStubs; they carry childCount.
    expect(children[0]).toHaveProperty('childCount')
  })

  it('a tight budget stubs overflow and returns a receipt naming cut subtrees', async () => {
    const result = await handleInspect(
      { nodeId: '10:0', budget: 60 },
      stubClient({ reply: deepTree }),
    )
    const out = parse(result.content[0].text)
    // Something must have been cut under a tight budget.
    expect(out.truncated.length).toBeGreaterThan(0)
    // Each receipt entry is a real, drillable id with a childCount.
    for (const entry of out.truncated) {
      expect(typeof entry.id).toBe('string')
      expect(entry.id.length).toBeGreaterThan(0)
      expect(typeof entry.childCount).toBe('number')
    }
  })

  it('returns Node not found when the plugin returns null', async () => {
    const result = await handleInspect(
      { nodeId: 'nope' },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toContain('not found')
  })

  it('emits contextSummary, never full context, and it survives a fields narrow', async () => {
    const res = await handleInspect(
      { nodeId: '1:42', fields: ['id'] },
      stubClient({
        reply: {
          id: '1:42',
          type: 'FRAME',
          context:
            '---\npurpose: CTA\n---\n## Notes\nlong body',
        },
      }),
    )
    const parsed = YAML.parse(res.content[0].text) as {
      view: { context?: string; contextSummary?: string }
    }
    expect(parsed.view.contextSummary).toBe('purpose: CTA')
    expect(parsed.view.context).toBeUndefined()
  })
})

// ─── multi-selection inspect (M2 chunk F) ─────────────────────────────────────
//
// With no nodeId/pageId, inspect() targets the CURRENT SELECTION. When the
// plugin returns >1 raw export (array), the handler assembles a forest under a
// synthetic { type: 'SELECTION', children: [...] } root so depth/budget/receipt
// apply across the WHOLE set. Single-select (1 raw export) stays a single view.

describe('handleInspect — multi-selection forest (M2 chunk F)', () => {
  it('wraps a multi-node selection in a SELECTION forest root', async () => {
    const result = await handleInspect(
      { depth: -1 },
      stubClient({ reply: [deepTree, cardNode] }),
    )
    const out = parse(result.content[0].text)
    expect(out.view.type).toBe('SELECTION')
    const children = out.view.children as {
      id: string
    }[]
    expect(children).toHaveLength(2)
    const ids = children.map(c => c.id)
    expect(ids).toContain('10:0')
    expect(ids).toContain('1:42')
  })

  it('keeps the single-node view shape when exactly one node is selected (unchanged)', async () => {
    const result = await handleInspect(
      { depth: -1 },
      stubClient({ reply: cardNode }),
    )
    const out = parse(result.content[0].text)
    // Single-select renders the node directly, NOT a SELECTION wrapper.
    expect(out.view.type).toBe('FRAME')
    expect(out.view.id).toBe('1:42')
  })

  it('returns the nothing-selected message when no node is selected', async () => {
    const result = await handleInspect(
      {},
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toContain('not found')
  })

  it('budget bounds the WHOLE forest (receipt names real cut ids)', async () => {
    const result = await handleInspect(
      { budget: 80 },
      stubClient({ reply: [deepTree, cardNode] }),
    )
    const out = parse(result.content[0].text)
    expect(out.view.type).toBe('SELECTION')
    // A tight budget over two whole subtrees must cut something.
    expect(out.truncated.length).toBeGreaterThan(0)
    // Every receipt id is a real, drillable id with a childCount.
    for (const entry of out.truncated) {
      expect(typeof entry.id).toBe('string')
      expect(entry.id.length).toBeGreaterThan(0)
      expect(typeof entry.childCount).toBe('number')
    }
  })

  it('forest depth=0 collapses each selected node to a stubbed view', async () => {
    const result = await handleInspect(
      { depth: 0 },
      stubClient({ reply: [deepTree, cardNode] }),
    )
    const out = parse(result.content[0].text)
    const children = out.view.children as {
      id: string
      children?: { childCount: number }[]
    }[]
    // depth=0 below the synthetic root → each selected node kept, its own
    // children collapsed to id-stubs.
    expect(children).toHaveLength(2)
    const root10 = children.find(c => c.id === '10:0')!
    expect(root10.children?.[0]).toHaveProperty(
      'childCount',
    )
  })

  it('profile:minimal keeps BOTH selected nodes (projected) — does not erase the forest', async () => {
    const result = await handleInspect(
      { profile: 'minimal' },
      stubClient({ reply: [deepTree, cardNode] }),
    )
    const out = parse(result.content[0].text)
    expect(out.view.type).toBe('SELECTION')
    const children = out.view.children as Record<
      string,
      unknown
    >[]
    // Both selected nodes survive the projection — the forest is NOT empty.
    expect(children).toHaveLength(2)
    const ids = children.map(c => c.id)
    expect(ids).toContain('10:0')
    expect(ids).toContain('1:42')
    // Each is projected to the minimal field set (type/name/id only).
    for (const child of children) {
      expect(Object.keys(child).sort()).toEqual([
        'id',
        'name',
        'type',
      ])
    }
  })

  it('fields:[id,name] keeps BOTH selected nodes projected to those fields', async () => {
    const result = await handleInspect(
      { fields: ['id', 'name'] },
      stubClient({ reply: [deepTree, cardNode] }),
    )
    const out = parse(result.content[0].text)
    expect(out.view.type).toBe('SELECTION')
    const children = out.view.children as Record<
      string,
      unknown
    >[]
    expect(children).toHaveLength(2)
    for (const child of children) {
      expect(Object.keys(child).sort()).toEqual([
        'id',
        'name',
      ])
    }
    const ids = children.map(c => c.id)
    expect(ids).toContain('10:0')
    expect(ids).toContain('1:42')
  })

  it('budget hard-bounds the WHOLE forest view (estimateTokens(view) <= budget)', async () => {
    const budget = 80
    const result = await handleInspect(
      { budget },
      stubClient({ reply: [deepTree, cardNode] }),
    )
    const out = parse(result.content[0].text)
    expect(out.view.type).toBe('SELECTION')
    // The cross-forest guarantee: the returned view never exceeds the budget.
    expect(
      estimateTokens(out.view as never),
    ).toBeLessThanOrEqual(budget)
  })

  // Regression guard (180250a): a forest bumped an omitted `depth` to 1 before
  // calling truncateTree. That was harmless while a budget made truncateTree
  // ignore depth — once depth became binding, a generous budget came back one
  // level deep with almost all of it unspent. The existing budget test above
  // uses a tiny budget, so it truncates either way and cannot see this.
  it('a generous budget fills the whole forest — depth is not forced to 1', async () => {
    const generous = parse(
      (
        await handleInspect(
          { budget: 100000 },
          stubClient({ reply: [deepTree, cardNode] }),
        )
      ).content[0].text,
    )
    const forcedToOne = parse(
      (
        await handleInspect(
          { depth: 1 },
          stubClient({ reply: [deepTree, cardNode] }),
        )
      ).content[0].text,
    )
    const nodes = (n: unknown): number => {
      const o = n as { children?: unknown[] }
      return (
        1 +
        (o.children ?? []).reduce<number>(
          (t, c) => t + nodes(c),
          0,
        )
      )
    }
    // Nothing was cut: the forest fits well inside 100k tokens.
    expect(generous.truncated).toEqual([])
    // And it is strictly deeper than the one-level view the bug returned.
    expect(nodes(generous.view)).toBeGreaterThan(
      nodes(forcedToOne.view),
    )
  })

  it('a budget below the SELECTION root cost emits no empty-id receipt entry', async () => {
    // The synthetic SELECTION root carries no real id. Under a budget smaller
    // than its shallow cost, fillToBudget must NOT push a {id:''} receipt entry
    // (a non-drillable id violates the "every receipt id is real" invariant).
    const result = await handleInspect(
      { budget: 2 },
      stubClient({ reply: [deepTree, cardNode] }),
    )
    const out = parse(result.content[0].text)
    for (const entry of out.truncated) {
      expect(entry.id.length).toBeGreaterThan(0)
    }
  })
})
