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
  handleGetNodes,
  handleInspect,
  handleListPages,
} from '@figma-agent-bridge/server/tools/read'
import { handleUpdateNode } from '@figma-agent-bridge/server/tools/update'
import { handleCreateNode } from '@figma-agent-bridge/server/tools/create-node'
import { handleSearch } from '@figma-agent-bridge/server/tools/search'
import {
  handleGetSelection,
  handleSetSelection,
} from '@figma-agent-bridge/server/tools/selection'
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

  // ── chunk B — core reads + single-node create + navigation ────────────────

  // 7 — create_node round-trip: server converts the atom fill → SOLID paint,
  // the mock echoes the CONVERTED spec back, proving the plugin only assigns.
  it('create_node round-trips: server parses the atom, plugin gets the converted paint', async () => {
    const result = await handleCreateNode(
      {
        spec: {
          type: 'RECTANGLE',
          name: 'Card BG',
          size: [320, 200],
          fills: ['#3B82F6'],
        },
        parentId: 'page:1',
      },
      client,
    )
    const reply = JSON.parse(result.content[0].text) as {
      id: string
      type: string
      name: string
      fills: { type: string; color: unknown }[]
      warnings: string[]
    }
    expect(reply.type).toBe('RECTANGLE')
    expect(reply.name).toBe('Card BG')
    expect(reply.id).toBeDefined()
    // The CONVERTED paint reached the plugin (atom string was parsed server-side;
    // the grammar rounds channels to 3 decimals).
    expect(reply.fills[0].type).toBe('SOLID')
    expect(reply.fills[0].color).toEqual({
      r: 0.231,
      g: 0.51,
      b: 0.965,
    })
  })

  // 8 — create_node with children warns (M2 single-node) and never recurses.
  it('create_node warns and does not recurse when children are present', async () => {
    const result = await handleCreateNode(
      {
        spec: {
          type: 'FRAME',
          name: 'Parent',
          children: [{ type: 'RECTANGLE' }],
        },
        parentId: 'page:1',
      },
      client,
    )
    expect(result.content[0].text).toContain('create_tree')
  })

  // 9 — search with a server-side match (name glob) over the relay.
  it('search applies the name match server-side', async () => {
    const result = await handleSearch(
      { match: { name: 'Card' } },
      client,
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { name: string; type: string }[]
      truncated: boolean
    }
    expect(out.results).toHaveLength(1)
    expect(out.results[0].name).toBe('Card')
    expect(out.truncated).toBe(false)
  })

  // 10 — search with a match.type ARRAY (any-of) over the relay.
  it('search applies a match.type array (any-of) server-side', async () => {
    const result = await handleSearch(
      { match: { type: ['TEXT', 'INSTANCE'] } },
      client,
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { type: string }[]
    }
    // Title + Body (TEXT) + Action Button (INSTANCE) from the mock candidates.
    expect(out.results).toHaveLength(3)
    for (const r of out.results) {
      expect(['TEXT', 'INSTANCE']).toContain(r.type)
    }
  })

  // 11 — search pagination: a tight limit truncates and yields a resumable cursor.
  it('search paginates with limit + cursor across the relay', async () => {
    const page1 = await handleSearch({ limit: 2 }, client)
    const out1 = YAML.parse(page1.content[0].text) as {
      results: { id: string }[]
      truncated: boolean
      cursor: string
    }
    expect(out1.results).toHaveLength(2)
    expect(out1.truncated).toBe(true)
    expect(typeof out1.cursor).toBe('string')

    const page2 = await handleSearch(
      { limit: 2, cursor: out1.cursor },
      client,
    )
    const out2 = YAML.parse(page2.content[0].text) as {
      results: { id: string }[]
      truncated: boolean
    }
    expect(out2.results).toHaveLength(2)
    expect(out2.truncated).toBe(false)
    // Disjoint pages — no id repeats across the boundary.
    const ids1 = out1.results.map(r => r.id)
    const ids2 = out2.results.map(r => r.id)
    expect(ids1.some(id => ids2.includes(id))).toBe(false)
  })

  // 12 — get_nodes multi-id read → { results, errors } over the relay.
  it('get_nodes returns NodeSpec results over the relay', async () => {
    const result = await handleGetNodes(
      { nodeIds: ['1:42'], depth: 0 },
      client,
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { type: string; fills: string[] }[]
      errors: unknown[]
    }
    expect(out.results).toHaveLength(1)
    expect(out.results[0].type).toBe('FRAME')
    expect(typeof out.results[0].fills[0]).toBe('string')
    expect(out.errors).toHaveLength(0)
  })

  // 13 — selection round-trip: set_selection reports the count, get_selection reads.
  it('set_selection reports selectedCount and get_selection reads the list', async () => {
    const set = await handleSetSelection(
      { nodeIds: ['1:42', '1:43'] },
      client,
    )
    const setOut = JSON.parse(set.content[0].text) as {
      selectedCount: number
    }
    expect(setOut.selectedCount).toBe(2)

    const get = await handleGetSelection(client)
    const list = YAML.parse(get.content[0].text) as {
      id: string
      name: string
      type: string
    }[]
    expect(Array.isArray(list)).toBe(true)
    expect(list[0]).toHaveProperty('id')
    expect(list[0]).toHaveProperty('type')
  })

  // 14 — list_pages returns the Rule A document + page shape over the relay.
  it('list_pages returns { docName, results, truncated } over the relay', async () => {
    const result = await handleListPages(client)
    const out = YAML.parse(result.content[0].text) as {
      docName: string
      results: {
        id: string
        name: string
        isCurrent: boolean
        childCount: number
      }[]
      truncated: boolean
    }
    expect(out.docName).toBe('Slice Doc')
    expect(out.results.length).toBeGreaterThan(0)
    expect(out.results[0]).toHaveProperty('isCurrent')
    expect(out.truncated).toBe(false)
  })
})
