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
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import deepTree from '../fixtures/deep-tree-raw.json'
import cardNode from '../fixtures/card-node-raw.json'

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
    return opts.reply ?? null
  },
  disconnect: () => {},
  isConnected: () => opts.connected ?? true,
  currentChannel: () => 'ch',
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
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleInspect(
      { nodeId: '10:0' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('sends COMMANDS.INSPECT', async () => {
    const sent: Sent[] = []
    await handleInspect(
      { nodeId: '10:0', depth: 0 },
      stubClient({ sent, reply: deepTree }),
    )
    expect(sent[0].command).toBe(COMMANDS.INSPECT)
    expect(sent[0].params?.nodeId).toBe('10:0')
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
