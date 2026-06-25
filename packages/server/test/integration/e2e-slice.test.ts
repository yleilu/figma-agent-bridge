// e2e-slice.test.ts — the M2 vertical slice over the REAL relay with the mock
// plugin (headless, CI). Proves the 4 slice tools end-to-end:
//   get_node (NodeSpec read) · inspect (budget + receipt) ·
//   update_node (round-trip: server parses, plugin assigns) ·
//   bind_variable (degrade / error / happy + var() read-back).
//
// Same startRelay + createMockPlugin + createFigmaClient pattern as the other
// integration suites, so no Figma is needed.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import type { Server } from 'bun'
import YAML from 'yaml'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { createFigmaClient } from '@figma-agent-bridge/server/figma-client'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import { handleConnect } from '@figma-agent-bridge/server/tools/session'
import {
  handleGetNode,
  handleInspect,
} from '@figma-agent-bridge/server/tools/read'
import { handleUpdateNode } from '@figma-agent-bridge/server/tools/update'
import {
  handleBindVariable,
  handleGetVariables,
} from '@figma-agent-bridge/server/tools/design-system'
import { createMockPlugin } from '../mocks/mock-plugin'

const TEST_PORT = 3101
const RELAY_URL = `ws://localhost:${TEST_PORT}`
const TEST_CHANNEL = 'e2e-slice-channel'

describe('M2 vertical slice e2e (mock plugin over real relay)', () => {
  let server: Server<{ id: string }>
  let client: FigmaClient
  let plugin: ReturnType<typeof createMockPlugin> | null =
    null

  beforeEach(async () => {
    server = startRelay(TEST_PORT)
    client = createFigmaClient(RELAY_URL)
    plugin = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: TEST_CHANNEL,
      documentName: 'Slice Doc',
      pageName: 'Main',
    })
    await plugin.start()
    await handleConnect({ channel: TEST_CHANNEL }, client)
  })

  afterEach(() => {
    if (plugin !== null) {
      plugin.stop()
      plugin = null
    }
    client.disconnect()
    stopRelay(server)
  })

  // 1 — get_node emits NodeSpec (atom-grammar leaves, child id-stubs)
  it('get_node emits a NodeSpec with atom fills and child id-stubs', async () => {
    const result = await handleGetNode(
      { nodeId: '1:42', depth: 0 },
      client,
    )
    const spec = YAML.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(spec.type).toBe('FRAME')
    const fills = spec.fills as string[]
    // atom string, not a raw JSON_REST_V1 paint object.
    expect(typeof fills[0]).toBe('string')
    expect(fills[0]).toMatch(/#FFFFFF/)
    // children collapsed to drillable id-stubs at depth 0.
    const children = spec.children as {
      id: string
      childCount: number
    }[]
    expect(children[0].id).toBe('1:43')
    expect(children[0]).toHaveProperty('childCount')
  })

  // 2 — inspect budget + receipt
  it('inspect returns a truncation receipt under a tight budget', async () => {
    const result = await handleInspect(
      { nodeId: '1:42', budget: 50 },
      client,
    )
    const out = YAML.parse(result.content[0].text) as {
      view: Record<string, unknown>
      truncated: { id: string; childCount: number }[]
    }
    expect(out.view).toBeDefined()
    expect(out.truncated.length).toBeGreaterThan(0)
    for (const entry of out.truncated) {
      expect(typeof entry.id).toBe('string')
      expect(entry.id.length).toBeGreaterThan(0)
    }
  })

  it('inspect with no budget + no depth defaults to depth=0', async () => {
    const result = await handleInspect(
      { nodeId: '1:42' },
      client,
    )
    const out = YAML.parse(result.content[0].text) as {
      view: { children: { childCount: number }[] }
    }
    expect(out.view.children[0]).toHaveProperty(
      'childCount',
    )
  })

  // 3 — full round-trip: get_node → edit → update_node → mock echoes CONVERTED
  it('round-trips a fill edit through the relay: server parses, plugin assigns', async () => {
    // Read the node as a NodeSpec.
    const read = await handleGetNode(
      { nodeId: '1:42', depth: 0 },
      client,
    )
    const spec = YAML.parse(read.content[0].text) as {
      fills: string[]
    }
    expect(spec.fills[0]).toMatch(/#FFFFFF/)

    // Edit the fill to a fresh literal and write it back through the REAL
    // handler. (The card's read-back fill is var-bound — see the fixture — so
    // we write a fresh literal, not the var() atom, which the writer would
    // resolve to a literal anyway by the documented T2 asymmetry.)
    const updated = await handleUpdateNode(
      { nodeId: '1:42', patch: { fills: ['#FF0000'] } },
      client,
    )

    // The mock echoes the CONVERTED spec (Figma objects, not atom strings), so
    // handleUpdateNode's OWN result proves the server parsed the atom and the
    // plugin only assigned — asserted on the real handler output.
    const reply = JSON.parse(updated.content[0].text) as {
      spec: { fills: { type: string; color: unknown }[] }
    }
    expect(reply.spec.fills[0]).toEqual({
      type: 'SOLID',
      color: { r: 1, g: 0, b: 0 },
    })
  })

  it('update_node forwards a parsed SOLID paint to the plugin (converted, not atom)', async () => {
    const result = await handleUpdateNode(
      { nodeId: '1:42', patch: { fills: ['#00FF00'] } },
      client,
    )
    const reply = JSON.parse(result.content[0].text) as {
      spec: { fills: { type: string; color: unknown }[] }
    }
    expect(reply.spec.fills[0]).toEqual({
      type: 'SOLID',
      color: { r: 0, g: 1, b: 0 },
    })
  })

  // 4 — bind_variable degrade path (success-with-warning, not error)
  it('bind_variable degrade path reports success-with-warning', async () => {
    const result = await handleBindVariable(
      {
        nodeId: '1:42',
        variableId: 'degrade:var',
        field: 'fills',
      },
      client,
    )
    expect(result.content[0].text).not.toContain('Error:')
    expect(result.content[0].text).toContain(
      'setBoundVariable unavailable',
    )
  })

  // 5 — bind_variable error vs success
  it('bind_variable error path surfaces an error (formatMutationResult catches plugin {error})', async () => {
    const result = await handleBindVariable(
      {
        nodeId: '1:42',
        variableId: 'err:missing',
        field: 'fills',
      },
      client,
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'Variable not found',
    )
  })

  // 6 — bind_variable happy + read-back shows var()
  it('bind_variable happy path + read-back shows the var(...) wrapper atom', async () => {
    // get_variables → pick a variable id.
    const vars = await handleGetVariables({}, client)
    expect(vars.content[0].text).toContain('Brand/Primary')

    // bind (happy path — no err:/degrade: prefix).
    const bind = await handleBindVariable(
      {
        nodeId: '1:42',
        variableId: 'var:123',
        field: 'fills',
      },
      client,
    )
    expect(bind.content[0].text).not.toContain('Error:')

    // read-back: get_node shows the var(...) wrapper on the bound leaf
    // (the card fixture's fill carries boundVariables.color → var:123).
    const read = await handleGetNode(
      { nodeId: '1:42', depth: 0 },
      client,
    )
    const spec = YAML.parse(read.content[0].text) as {
      fills: string[]
    }
    expect(spec.fills[0]).toMatch(/^var\(/)
  })
})
