// e2e-batch.test.ts — the one generic batch tool (M3 chunk D) over the REAL
// relay with the mock plugin (headless, CI). Same startRelay + createMockPlugin
// + createFigmaClient pattern as the other integration suites, so no Figma is
// needed.
//
// EXECUTION MODEL proof (one round-trip): handleBatch converts each op's params
// server-side and sends ONE COMMANDS.BATCH; the mock plugin's BATCH case loops
// the ops through its own per-command logic (mirroring the real plugin's
// handleCommand loop) and returns a per-op {ok,result|error}. The server merges
// those into { results, errors[] }.
//
// Covers a MIXED batch (update_node + reparent_node + apply_style) with ONE
// failing entry → per-op results + the failure isolated (partial success), plus
// a homogeneous batch and array-order assertions on the REAL mock echo.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import type { Server } from 'bun'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { createFigmaClient } from '@figma-agent-bridge/server/figma-client'
import type {
  FigmaClient,
  ScopedFigmaClient,
} from '@figma-agent-bridge/server/figma-client'
import { handleBatch } from '@figma-agent-bridge/server/tools/batch'
import { createMockPlugin } from '../mocks/mock-plugin'

const TEST_PORT = 3107
const RELAY_URL = `ws://localhost:${TEST_PORT}`
const TEST_CHANNEL = 'e2e-batch-test'
const FK = 'fk-batch'

type BatchOut = {
  results: {
    index: number
    op: string | null
    ok: boolean
    result?: Record<string, unknown>
    error?: string
  }[]
  errors: {
    index: number
    op: string | null
    error?: string
    code: string
  }[]
}

const parse = (text: string): BatchOut =>
  JSON.parse(text) as BatchOut

describe('M3 batch tool e2e (mock plugin over real relay)', () => {
  let server: Server<{ id: string }>
  let client: FigmaClient
  let scoped: ScopedFigmaClient
  let plugin: ReturnType<typeof createMockPlugin> | null =
    null

  beforeEach(async () => {
    server = startRelay(TEST_PORT)
    client = createFigmaClient(RELAY_URL)
    plugin = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: TEST_CHANNEL,
      documentName: 'Batch Doc',
      pageName: 'Main',
      fileKey: FK,
    })
    await plugin.start()
    await client.joinChannel(TEST_CHANNEL, FK)
    scoped = client.forFile(FK)
  })

  afterEach(() => {
    if (plugin !== null) {
      plugin.stop()
      plugin = null
    }
    client.disconnect()
    stopRelay(server)
  })

  it('runs a MIXED batch with one failing entry — per-op results, failure isolated', async () => {
    const result = await handleBatch(
      {
        ops: [
          // op[0]: update_node — succeeds; the mock echoes the CONVERTED spec.
          {
            op: 'update_node',
            nodeId: '1:1',
            patch: { name: 'Renamed', fills: ['#FF0000'] },
          },
          // op[1]: apply_style with an `err:`-prefixed nodeId → the mock returns
          // {error} → an ISOLATED per-op failure (does NOT abort op[0]/op[2]).
          {
            op: 'apply_style',
            nodeId: 'err:missing',
            styleId: 'S:1',
            field: 'fill',
          },
          // op[2]: reparent_node — succeeds; the mock echoes {id,…,parentId}.
          {
            op: 'reparent_node',
            nodeId: '1:3',
            parentId: '1:9',
          },
        ],
      },
      scoped,
    )

    expect(result.content[0].text).not.toStartWith('Error:')
    const out = parse(result.content[0].text)

    // array order + index alignment preserved across the round-trip.
    expect(out.results.map(r => r.index)).toEqual([0, 1, 2])
    expect(out.results.map(r => r.op)).toEqual([
      'update_node',
      'apply_style',
      'reparent_node',
    ])

    // op[0] succeeded: the mock echoed the CONVERTED spec (atom → Figma paint),
    // proving the server parsed before the plugin assigned.
    expect(out.results[0].ok).toBe(true)
    const r0 = out.results[0].result as {
      spec: {
        name: string
        fills: { type: string; color: { r: number } }[]
      }
    }
    expect(r0.spec.name).toBe('Renamed')
    expect(r0.spec.fills[0].type).toBe('SOLID')
    expect(r0.spec.fills[0].color.r).toBeCloseTo(1, 5)

    // op[1] failed in ISOLATION.
    expect(out.results[1].ok).toBe(false)
    expect(out.results[1].error).toContain('Node not found')

    // op[2] STILL succeeded despite op[1] failing.
    expect(out.results[2].ok).toBe(true)
    const r2 = out.results[2].result as { parentId: string }
    expect(r2.parentId).toBe('1:9')

    // errors[] summarizes only op[1].
    expect(out.errors).toEqual([
      {
        index: 1,
        op: 'apply_style',
        error: out.results[1].error,
        code: 'NODE_NOT_FOUND',
      },
    ])
  })

  it('homogeneous: a top-level op runs over N targets in ONE call', async () => {
    const result = await handleBatch(
      {
        op: 'delete_node',
        ops: [
          { nodeId: '1:1' },
          { nodeId: '1:2' },
          { nodeId: '1:3' },
        ],
      },
      scoped,
    )
    const out = parse(result.content[0].text)
    expect(out.results).toHaveLength(3)
    expect(out.results.every(r => r.ok)).toBe(true)
    expect(out.errors).toEqual([])
    // each op echoes the deleted node id the server forwarded.
    expect(
      out.results.map(r => (r.result as { id: string }).id),
    ).toEqual(['1:1', '1:2', '1:3'])
  })

  it('a degrade op rides on success with its warnings (T7), not a failure', async () => {
    const result = await handleBatch(
      {
        ops: [
          // set_reactions with a `degrade:`-prefixed nodeId → the mock returns
          // {id,warnings} (NEVER {error}) → success-with-warning.
          {
            op: 'set_reactions',
            nodeId: 'degrade:1',
            reactions: [],
          },
        ],
      },
      scoped,
    )
    const out = parse(result.content[0].text)
    expect(out.results[0].ok).toBe(true)
    expect(out.errors).toEqual([])
    const r = out.results[0].result as {
      warnings: string[]
    }
    expect(r.warnings.length).toBeGreaterThan(0)
  })
})
