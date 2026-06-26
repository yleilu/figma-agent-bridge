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
import { estimateTokens } from '@figma-agent-bridge/server/read/budget'
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
  handleGetStyles,
  handleGetComponents,
  handleListFonts,
} from '@figma-agent-bridge/server/tools/design-system'
import {
  handleCreateVariables,
  handleUpdateVariables,
  handleCreateStyles,
  handleApplyStyle,
} from '@figma-agent-bridge/server/tools/design-system-authoring'
import { handleExport } from '@figma-agent-bridge/server/tools/export'
import {
  handleGetReactions,
  handleGetPluginData,
  handleGetAnnotations,
  handleSetAnnotations,
} from '@figma-agent-bridge/server/tools/metadata'
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

  // 11a — search scope=node with an unresolvable id → {error} over the relay.
  it('search surfaces a plugin-side {error} for an unresolvable scope=node id', async () => {
    const result = await handleSearch(
      { scope: 'node', nodeId: 'nope:1' },
      client,
    )
    const { text } = result.content[0]
    expect(text).toContain('Error')
    expect(text).toContain('Node not found: nope:1')
    expect(text).not.toContain('results: []')
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

  // ── chunk C — design-system + metadata reads ──────────────────────────────

  // 15 — get_styles renders each style VALUE to a view atom over the relay,
  // including the grid render path (gridToAtom).
  it('get_styles renders paint→hex, text→font and grid→columns atoms over the relay', async () => {
    const result = await handleGetStyles({}, client)
    const out = YAML.parse(result.content[0].text) as {
      results: { type: string; value: string }[]
      truncated: boolean
    }
    expect(out.truncated).toBe(false)
    const paint = out.results.find(r => r.type === 'paint')!
    expect(paint.value).toBe('#3B82F6')
    const text = out.results.find(r => r.type === 'text')!
    expect(text.value).toContain('Inter')
    // grid render path: gridToAtom emits a columns(...) atom.
    const grid = out.results.find(r => r.type === 'grid')!
    expect(grid.value).toContain('columns')
  })

  // 16 — get_variables: modes present, COLOR valuesByMode → hex, scopes/codeSyntax.
  it('get_variables surfaces modes + scopes/codeSyntax and renders COLOR to hex', async () => {
    const result = await handleGetVariables({}, client)
    const { text } = result.content[0]
    expect(text).toContain('modes')
    expect(text).toContain('#FF0000')
    expect(text).toContain('ALL_SCOPES')
    expect(text).toContain('--brand-primary')
  })

  // 17 — get_components: a result carries variant axes + key over the relay.
  it('get_components carries variant axes and key over the relay', async () => {
    const result = await handleGetComponents({}, client)
    const out = YAML.parse(result.content[0].text) as {
      results: {
        name: string
        key: string
        variantAxes?: Record<string, string[]>
      }[]
    }
    const button = out.results.find(
      r => r.name === 'Button',
    )!
    expect(button.key).toBe('btn-key')
    expect(button.variantAxes).toEqual({
      Variant: ['Primary', 'Secondary'],
    })
  })

  // 18 — list_fonts returns families grouped with styles over the relay.
  it('list_fonts returns families with styles over the relay', async () => {
    const result = await handleListFonts({}, client)
    const out = YAML.parse(result.content[0].text) as {
      results: { family: string; styles: string[] }[]
      truncated: boolean
    }
    expect(out.truncated).toBe(false)
    expect(out.results[0].family).toBe('Inter')
    expect(out.results[0].styles).toContain('Bold')
  })

  // 19 — export SVG returns MCP text content with the SVG markup over the relay.
  it('export SVG returns text content with <svg over the relay', async () => {
    const result = await handleExport(
      { nodeId: '1:42', format: 'SVG' },
      client,
    )
    const item = result.content[0] as {
      type: string
      text: string
    }
    expect(item.type).toBe('text')
    expect(item.text).toContain('<svg')
  })

  // ── chunk C — node-metadata & handoff reads/writes (e2e parity) ────────────

  // 20 — get_reactions returns the Rule-A shape with the node's reactions.
  it('get_reactions returns { results, truncated } over the relay', async () => {
    const result = await handleGetReactions(
      { nodeId: '1:42' },
      client,
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { trigger: { type: string } }[]
      truncated: boolean
    }
    expect(out.truncated).toBe(false)
    expect(out.results).toHaveLength(1)
    expect(out.results[0].trigger.type).toBe('ON_CLICK')
  })

  // 21 — get_plugin_data reads pluginData; namespace surfaces sharedPluginData.
  it('get_plugin_data reads pluginData and (with namespace) sharedPluginData over the relay', async () => {
    const own = await handleGetPluginData(
      { nodeId: '1:42' },
      client,
    )
    const ownOut = YAML.parse(own.content[0].text) as {
      pluginData: Record<string, string>
      sharedPluginData?: Record<string, string>
    }
    expect(ownOut.pluginData.foo).toBe('bar')
    // No namespace ⇒ no sharedPluginData surfaced.
    expect(ownOut.sharedPluginData).toBeUndefined()

    const shared = await handleGetPluginData(
      { nodeId: '1:42', namespace: 'ns' },
      client,
    )
    const sharedOut = YAML.parse(
      shared.content[0].text,
    ) as {
      sharedPluginData?: Record<string, string>
    }
    expect(sharedOut.sharedPluginData?.baz).toBe('qux')
  })

  // 21a — get_plugin_data on a missing node degrades to empty pluginData + a
  // 'Node not found' warning over the relay (T7), never a silent empty/error.
  it('get_plugin_data forwards a node-not-found warning over the relay', async () => {
    const result = await handleGetPluginData(
      { nodeId: 'degrade:gone' },
      client,
    )
    const out = YAML.parse(result.content[0].text) as {
      pluginData: Record<string, string>
      warnings?: string[]
    }
    expect(result.content[0].text).not.toContain('Error')
    expect(out.pluginData).toEqual({})
    expect(out.warnings?.[0]).toContain(
      'Node not found: degrade:gone',
    )
  })

  // 22 — get_annotations returns the Rule-A handoff shape over the relay.
  it('get_annotations returns { results, truncated } over the relay', async () => {
    const result = await handleGetAnnotations(
      { nodeId: '1:42' },
      client,
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { label: string; categoryId: string }[]
      truncated: boolean
    }
    expect(out.truncated).toBe(false)
    expect(out.results[0].label).toBe('Check spacing')
  })

  // 22a — get_annotations on an unresolvable explicit nodeId degrades to an
  // empty result WITH a 'Node not found' warning (T7), never a silent empty.
  it('get_annotations surfaces a not-found warning for an unresolvable nodeId over the relay', async () => {
    const result = await handleGetAnnotations(
      { nodeId: 'degrade:gone' },
      client,
    )
    const out = YAML.parse(result.content[0].text) as {
      results: unknown[]
      warnings?: string[]
    }
    expect(result.content[0].text).not.toContain('Error')
    expect(out.results).toHaveLength(0)
    expect(out.warnings?.[0]).toContain(
      'Node not found: degrade:gone',
    )
  })

  // 22b — a multi-selection read tags each annotation with its source nodeId so
  // the flat result stays attributable / round-trippable to the single-node
  // set_annotations writer (T2).
  it('get_annotations tags each annotation with its source nodeId on a multi-selection read', async () => {
    const result = await handleGetAnnotations(
      { nodeId: 'multi:' },
      client,
    )
    const out = YAML.parse(result.content[0].text) as {
      results: { label: string; nodeId: string }[]
    }
    expect(out.results).toHaveLength(2)
    expect(out.results[0].nodeId).toBe('1:42')
    expect(out.results[1].nodeId).toBe('1:45')
  })

  // 23 — set_annotations happy path reports success (no error) over the relay.
  it('set_annotations happy path reports success over the relay', async () => {
    const result = await handleSetAnnotations(
      {
        nodeId: '1:42',
        annotations: [{ label: 'Review', categoryId: 'c' }],
      },
      client,
    )
    expect(result.content[0].text).not.toContain('Error')
  })

  // 24 — multi-selection inspect (M2 chunk F): with a ≥2-node selection and no
  // args, inspect() returns a SELECTION forest containing every selected node;
  // a tight budget over the whole forest produces a receipt of real cut ids.
  it('inspect() with no args returns a forest of the current multi-selection over the relay', async () => {
    // Swap the shared plugin for one whose selection holds TWO real nodes.
    plugin!.stop()
    plugin = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: TEST_CHANNEL,
      documentName: 'Slice Doc',
      pageName: 'Main',
      selection: [
        {
          id: '1:42',
          name: 'Card',
          type: 'FRAME',
          absoluteBoundingBox: {
            x: 0,
            y: 0,
            width: 320,
            height: 200,
          },
          children: [
            {
              id: '1:43',
              name: 'Title',
              type: 'TEXT',
              absoluteBoundingBox: {
                x: 0,
                y: 0,
                width: 288,
                height: 24,
              },
              characters: 'Card Title',
              style: {
                fontFamily: 'Inter',
                fontStyle: 'Bold',
                fontSize: 18,
              },
              children: [],
            },
          ],
        },
        {
          id: '2:10',
          name: 'Banner',
          type: 'FRAME',
          absoluteBoundingBox: {
            x: 0,
            y: 0,
            width: 600,
            height: 120,
          },
          children: [
            {
              id: '2:11',
              name: 'Logo',
              type: 'RECTANGLE',
              absoluteBoundingBox: {
                x: 0,
                y: 0,
                width: 40,
                height: 40,
              },
              children: [],
            },
          ],
        },
      ],
    })
    await plugin.start()
    await handleConnect({ channel: TEST_CHANNEL }, client)

    // No nodeId/pageId → inspect the current selection. depth=-1 keeps the
    // whole forest so we can assert both selected nodes are present.
    const result = await handleInspect(
      { depth: -1 },
      client,
    )
    const out = YAML.parse(result.content[0].text) as {
      view: {
        type: string
        children: { id: string; name: string }[]
      }
      truncated: { id: string; childCount: number }[]
    }
    expect(out.view.type).toBe('SELECTION')
    const ids = out.view.children.map(c => c.id)
    expect(ids).toContain('1:42')
    expect(ids).toContain('2:10')

    // A tight budget over the whole forest must cut something, and every
    // receipt id must be a real, drillable node id.
    const budget = 70
    const tight = await handleInspect({ budget }, client)
    const tightOut = YAML.parse(tight.content[0].text) as {
      view: { type: string }
      truncated: { id: string; childCount: number }[]
    }
    expect(tightOut.view.type).toBe('SELECTION')
    // The forest view is HARD-bounded by the budget across the whole selection.
    expect(
      estimateTokens(tightOut.view as never),
    ).toBeLessThanOrEqual(budget)
    expect(tightOut.truncated.length).toBeGreaterThan(0)
    for (const entry of tightOut.truncated) {
      expect(typeof entry.id).toBe('string')
      expect(entry.id.length).toBeGreaterThan(0)
    }
  })

  // ── chunk C — design-system AUTHORING (writes over the relay) ──────────────

  // 25 — create_variables: collection + modes + COLOR valuesByMode parsed from
  // hex reaches the plugin as {r,g,b,a}; FLOAT passes through.
  it('create_variables forwards modes + COLOR (parsed from hex) over the relay', async () => {
    const result = await handleCreateVariables(
      {
        collection: 'Brand',
        modes: ['Light', 'Dark'],
        variables: [
          {
            name: 'Brand/Primary',
            type: 'COLOR',
            valuesByMode: {
              Light: '#FF0000',
              Dark: '#000000',
            },
          },
          {
            name: 'radius/md',
            type: 'FLOAT',
            valuesByMode: { Light: 8 },
          },
        ],
      },
      client,
    )
    const out = JSON.parse(result.content[0].text) as {
      collectionId: string
      modes: { name: string }[]
      variables: { id: string; name: string }[]
      echo: {
        type: string
        valuesByMode: Record<string, unknown>
      }[]
    }
    expect(out.collectionId).toBe('col:new')
    expect(out.modes.map(m => m.name)).toEqual([
      'Light',
      'Dark',
    ])
    expect(out.variables[0].name).toBe('Brand/Primary')
    // The COLOR hex was parsed server-side to {r,g,b,a} before the plugin saw it.
    expect(out.echo[0].valuesByMode.Light).toEqual({
      r: 1,
      g: 0,
      b: 0,
      a: 1,
    })
    // FLOAT passed through unparsed.
    expect(out.echo[1].valuesByMode.Light).toBe(8)
  })

  // 26 — update_variables: addMode + a COLOR value edit, parsed from hex.
  it('update_variables forwards addModes + a parsed COLOR value edit over the relay', async () => {
    const result = await handleUpdateVariables(
      {
        collectionId: 'col:1',
        addModes: ['Dark'],
        variables: [
          {
            id: 'var:1',
            valuesByMode: { Default: '#00FF00' },
          },
        ],
      },
      client,
    )
    const out = JSON.parse(result.content[0].text) as {
      collectionId: string
      echo: {
        addModes: string[]
        variables: {
          id: string
          valuesByMode: Record<string, unknown>
        }[]
      }
    }
    expect(out.collectionId).toBe('col:1')
    expect(out.echo.addModes).toEqual(['Dark'])
    // COLOR value edit parsed server-side.
    expect(
      out.echo.variables[0].valuesByMode.Default,
    ).toEqual({ r: 0, g: 1, b: 0, a: 1 })
  })

  // 27 — update_variables degrade path reports success-with-warning (T7).
  it('update_variables degrade path reports success-with-warning over the relay', async () => {
    const result = await handleUpdateVariables(
      { collectionId: 'degrade:col', addModes: ['X'] },
      client,
    )
    expect(result.content[0].text).not.toContain('Error:')
    expect(result.content[0].text).toContain(
      'addMode unavailable',
    )
  })

  // 27a — update_variables: a setValueForMode REJECTION (e.g. a type-incompatible
  // value reaching a COLOR variable) degrades to a warning-on-success, never a
  // throw / never {error} (T7). The mock keys this off a variable id prefixed
  // `degrade:` on an otherwise-happy collection.
  it('update_variables setValueForMode failure degrades to success-with-warning over the relay', async () => {
    const result = await handleUpdateVariables(
      {
        collectionId: 'col:1',
        variables: [
          {
            id: 'degrade:var',
            valuesByMode: { Default: '#00FF00' },
          },
        ],
      },
      client,
    )
    expect(result.content[0].text).not.toContain('Error:')
    expect(result.content[0].text).toContain(
      'setValueForMode failed',
    )
  })

  // 27b — create_variables: a per-variable create / setValueForMode failure
  // degrades the batch (warning), and the rest of the batch continues — never a
  // throw, never {error}. The mock keys the failing variable off a name prefixed
  // `degrade:`.
  it('create_variables per-variable failure degrades while the batch continues over the relay', async () => {
    const result = await handleCreateVariables(
      {
        collection: 'Brand',
        variables: [
          {
            name: 'degrade:Bad',
            type: 'COLOR',
            valuesByMode: { Mode1: '#FF0000' },
          },
          {
            name: 'Good',
            type: 'COLOR',
            valuesByMode: { Mode1: '#000000' },
          },
        ],
      },
      client,
    )
    expect(result.content[0].text).not.toContain('Error:')
    const out = JSON.parse(result.content[0].text) as {
      variables: { name: string }[]
      warnings: string[]
    }
    // The good variable still made it into the batch.
    expect(out.variables.map(v => v.name)).toContain('Good')
    // The bad one degraded to a warning, not a throw / not {error}.
    expect(
      out.warnings.some(w => w.includes('degrade:Bad')),
    ).toBe(true)
  })

  // 27c — create_variables: a collection-level factory failure is a genuine
  // failure (nothing to return) and surfaces as {error}, NOT a degrade. The mock
  // keys this off a collection name prefixed `err:`.
  it('create_variables collection-factory failure surfaces as an error over the relay', async () => {
    const result = await handleCreateVariables(
      { collection: 'err:Brand', variables: [] },
      client,
    )
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain(
      'createVariableCollection',
    )
  })

  // 28 — create_styles: a paint atom is parsed server-side to a SOLID Paint
  // before the plugin creates the style.
  it('create_styles parses a paint atom to a SOLID Paint over the relay', async () => {
    const result = await handleCreateStyles(
      {
        type: 'paint',
        name: 'Brand/Primary',
        value: '#3B82F6',
      },
      client,
    )
    const out = JSON.parse(result.content[0].text) as {
      id: string
      key: string
      type: string
      echo: { type: string; color: unknown }
    }
    expect(out.id).toBe('S:new')
    expect(out.type).toBe('paint')
    // The atom was parsed to a Figma Paint before the plugin saw it.
    expect(out.echo.type).toBe('SOLID')
    expect(out.echo.color).toEqual({
      r: 0.231,
      g: 0.51,
      b: 0.965,
    })
  })

  // 29 — create_styles: a font atom is parsed to a FontName over the relay.
  it('create_styles parses a font atom to a FontName over the relay', async () => {
    const result = await handleCreateStyles(
      {
        type: 'text',
        name: 'Heading/H1',
        value: 'font(Inter,Bold,32,{lh=40})',
      },
      client,
    )
    const out = JSON.parse(result.content[0].text) as {
      type: string
      echo: {
        family: string
        size: number
        lineHeight: { value: number; unit: string }
      }
    }
    expect(out.type).toBe('text')
    expect(out.echo.family).toBe('Inter')
    expect(out.echo.size).toBe(32)
    expect(out.echo.lineHeight).toEqual({
      value: 40,
      unit: 'PIXELS',
    })
  })

  // 30 — apply_style happy path reports success (no error) over the relay.
  it('apply_style reports success over the relay', async () => {
    const result = await handleApplyStyle(
      { nodeId: '1:42', styleId: 'S:1', field: 'fill' },
      client,
    )
    const out = JSON.parse(result.content[0].text) as {
      id: string
      warnings: string[]
    }
    expect(out.id).toBe('1:42')
    expect(out.warnings).toEqual([])
  })

  // 31 — apply_style degrade path reports success-with-warning (T7).
  it('apply_style degrade path reports success-with-warning over the relay', async () => {
    const result = await handleApplyStyle(
      {
        nodeId: 'degrade:node',
        styleId: 'S:1',
        field: 'text',
      },
      client,
    )
    expect(result.content[0].text).not.toContain('Error:')
    expect(result.content[0].text).toContain('not applied')
  })
})
