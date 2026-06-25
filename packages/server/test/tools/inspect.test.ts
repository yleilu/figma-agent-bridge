// inspect.test.ts — the rebuilt handleInspect (Rule B: depth + budget + receipt).
//
// inspect sends COMMANDS.INSPECT → toNodeSpec(depth=-1) → truncateTree (which
// calls read/budget when a budget is set) → match → project → {view,
// truncated:[{id,childCount}]} rendered as YAML. NOT a bespoke budgeted view —
// it consumes the P0 read/* primitives directly.

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'
import { handleInspect } from '@figma-agent-bridge/server/tools/read'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import deepTree from '../fixtures/deep-tree-raw.json'

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
