import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import YAML from 'yaml'
import type { Server } from 'bun'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { createFigmaClient } from '@figma-agent-bridge/server/figma-client'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleConnect,
  handleStatus,
} from '@figma-agent-bridge/server/tools/session'
import {
  handleInspect,
  handleGetNode,
  handleListPages,
} from '@figma-agent-bridge/server/tools/read'
import {
  handleGetStyles,
  handleGetComponents,
} from '@figma-agent-bridge/server/tools/design-system'
import { handleSearch } from '@figma-agent-bridge/server/tools/search'
import { handleExport } from '@figma-agent-bridge/server/tools/export'
import { createMockPlugin } from '../mocks/mock-plugin'

const TEST_PORT = 3097
const RELAY_URL = `ws://localhost:${TEST_PORT}`
const RELAY_HTTP_URL = `http://localhost:${TEST_PORT}`
const TEST_CHANNEL = 'e2e-test-channel'

describe('e2e roundtrip', () => {
  let server: Server<{ id: string }>
  let client: FigmaClient
  let plugin: ReturnType<typeof createMockPlugin> | null =
    null

  beforeEach(() => {
    server = startRelay(TEST_PORT)
    client = createFigmaClient(RELAY_URL)
  })

  afterEach(async () => {
    if (plugin !== null) {
      plugin.stop()
      plugin = null
    }
    client.disconnect()
    stopRelay(server)
  })

  it('connect tool joins channel', async () => {
    const result = await handleConnect(
      { channel: TEST_CHANNEL },
      client,
    )

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain(TEST_CHANNEL)
  })

  it('status tool returns connected + LIVE context (D1)', async () => {
    // D1: status sends COMMANDS.STATUS to the plugin and merges the live context
    // (currentPage / selection / viewport) with the server-side connection
    // state — so a plugin must be running for the live read to resolve.
    plugin = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: TEST_CHANNEL,
      documentName: 'Status Doc',
      pageName: 'Live Page',
    })
    await plugin.start()
    await handleConnect({ channel: TEST_CHANNEL }, client)

    const result = await handleStatus(client)

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    const out = JSON.parse(result.content[0].text) as {
      connected: boolean
      channel: string
      currentPage: { id: string; name: string }
      selection: { id: string; type: string }[]
      viewport: {
        center: { x: number; y: number }
        zoom: number
      }
    }
    expect(out.connected).toBe(true)
    expect(out.channel).toBe(TEST_CHANNEL)
    // Live context merged from the plugin's STATUS reply.
    expect(out.currentPage).toEqual({
      id: 'page:1',
      name: 'Live Page',
    })
    expect(out.selection[0].type).toBe('FRAME')
    expect(out.viewport.zoom).toBe(1.5)
  })

  it('server can send command to mock plugin and get response', async () => {
    plugin = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: TEST_CHANNEL,
      documentName: 'Test Doc',
      pageName: 'Main Page',
    })

    await plugin.start()

    await handleConnect({ channel: TEST_CHANNEL }, client)

    const result = await client.sendCommand(
      'get_document_info',
      {},
      5000,
    )

    const doc = result as {
      name: string
      currentPage: { id: string; name: string }
    }

    expect(doc.name).toBe('Test Doc')
  })

  it('registered plugin appears in /channels', async () => {
    plugin = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: TEST_CHANNEL,
      documentName: 'Design File',
    })

    await plugin.start()

    // Give register message time to process
    await Bun.sleep(50)

    const res = await fetch(`${RELAY_HTTP_URL}/channels`)
    const data = (await res.json()) as {
      channel: string
      fileName: string | null
    }[]

    expect(data).toHaveLength(1)
    expect(data[0].channel).toBe(TEST_CHANNEL)
    expect(data[0].fileName).toBe('Design File')
  })

  it('connect tool auto-discovers channel', async () => {
    plugin = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: TEST_CHANNEL,
      documentName: 'Auto Doc',
    })

    await plugin.start()
    await Bun.sleep(50)

    const result = await handleConnect(
      { fileName: 'Auto Doc' },
      client,
      RELAY_HTTP_URL,
    )

    expect(result.content[0].text).toContain(TEST_CHANNEL)
    expect(client.isConnected()).toBe(true)
  })
})

const M2_TEST_PORT = 3098
const M2_RELAY_URL = `ws://localhost:${M2_TEST_PORT}`
const M2_TEST_CHANNEL = 'e2e-m2-test-channel'

describe('M2 read tools e2e', () => {
  let server: Server<{ id: string }>
  let client: FigmaClient
  let plugin: ReturnType<typeof createMockPlugin> | null =
    null

  beforeEach(async () => {
    server = startRelay(M2_TEST_PORT)
    client = createFigmaClient(M2_RELAY_URL)

    plugin = createMockPlugin({
      relayUrl: M2_RELAY_URL,
      channel: M2_TEST_CHANNEL,
      documentName: 'Mock Document',
      pageName: 'Homepage',
    })

    await plugin.start()
    await handleConnect(
      { channel: M2_TEST_CHANNEL },
      client,
    )
  })

  afterEach(() => {
    if (plugin !== null) {
      plugin.stop()
      plugin = null
    }
    client.disconnect()
    stopRelay(server)
  })

  it('inspect returns {view, truncated} YAML for mock document', async () => {
    const result = await handleInspect(
      { nodeId: '1:42', depth: -1 },
      client,
    )

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    const out = YAML.parse(result.content[0].text) as {
      view: { name: string }
      truncated: unknown[]
    }
    expect(out.view.name).toBe('Card')
    expect(Array.isArray(out.truncated)).toBe(true)
  })

  it('get_node returns a NodeSpec (YAML) with depth control', async () => {
    const result = await handleGetNode(
      { nodeId: '1:42', depth: 0 },
      client,
    )

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    const parsed = YAML.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(parsed.id).toBe('1:42')
    expect(parsed.name).toBe('Card')
    // depth 0 means children shown as id-stubs (drill-by-id).
    const children = parsed.children as {
      id?: string
      childCount?: number
    }[]
    for (const child of children) {
      expect(child.id).toBeDefined()
      expect(child.childCount).toBeDefined()
    }
  })

  it('get_styles returns the Rule-A results list', async () => {
    const result = await handleGetStyles({}, client)

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('results')
    expect(result.content[0].text).toContain('truncated')
  })

  it('get_components returns the component catalog', async () => {
    const result = await handleGetComponents({}, client)

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('results')
    expect(result.content[0].text).toContain('Button')
  })

  it('search finds nodes by name pattern (server-side match)', async () => {
    const result = await handleSearch(
      { match: { name: 'Card' } },
      client,
    )

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('Card')
  })

  it('list_pages returns the document + pages in YAML (Rule A)', async () => {
    const result = await handleListPages({}, client)

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    // The mock's page name is whatever pageName was passed to createMockPlugin.
    expect(result.content[0].text).toContain('results')
    expect(result.content[0].text).toContain('docName')
  })

  it('export PNG returns image with valid base64', async () => {
    const result = await handleExport(
      { nodeId: '1:42', format: 'PNG' },
      client,
    )

    expect(result.content).toHaveLength(1)
    const item = result.content[0] as {
      type: string
      data?: string
      mimeType?: string
    }
    expect(item.type).toBe('image')
    expect(item.mimeType).toBe('image/png')
    expect(item.data).toBeDefined()
    // Verify data is valid base64
    const decoded = Buffer.from(item.data ?? '', 'base64')
    expect(decoded.length).toBeGreaterThan(0)
  })

  it('export SVG returns text starting with <svg', async () => {
    const result = await handleExport(
      { nodeId: '1:42', format: 'SVG' },
      client,
    )

    expect(result.content).toHaveLength(1)
    const item = result.content[0] as {
      type: string
      text?: string
    }
    expect(item.type).toBe('text')
    expect(item.text).toMatch(/^<svg/)
  })
})
