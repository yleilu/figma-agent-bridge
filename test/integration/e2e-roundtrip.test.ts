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
} from '../../packages/relay/src/relay'
import { createFigmaClient } from '../../packages/server/src/figma-client'
import type { FigmaClient } from '../../packages/server/src/figma-client'
import {
  handleConnect,
  handleStatus,
} from '../../packages/server/src/tools/session'
import {
  handleInspect,
  handleGetNodeInfo,
  handleListPages,
} from '../../packages/server/src/tools/read'
import {
  handleInspectStyles,
  handleInspectComponents,
} from '../../packages/server/src/tools/design-system'
import { handleSearch } from '../../packages/server/src/tools/search'
import { handleExport } from '../../packages/server/src/tools/export'
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

  it('status tool returns connected', async () => {
    await handleConnect({ channel: TEST_CHANNEL }, client)

    const result = await handleStatus(client)

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('connected')
    expect(result.content[0].text).toContain(TEST_CHANNEL)
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
    const data = (await res.json()) as Array<{
      channel: string
      fileName: string | null
    }>

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
      {},
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

  it('inspect returns YAML for mock document', async () => {
    const result = await handleInspect(
      { nodeId: '1:42' },
      client,
    )

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('# Card')
    expect(result.content[0].text).toContain(
      'auto-layout: V',
    )
  })

  it('get_node_info returns JSON with depth control', async () => {
    const result = await handleGetNodeInfo(
      { nodeId: '1:42', depth: 0 },
      client,
    )

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    const parsed = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(parsed.id).toBe('1:42')
    expect(parsed.name).toBe('Card')
    // depth 0 means children shown as stubs
    if (parsed.children !== undefined) {
      const children = parsed.children as Array<{
        id?: string
        name?: string
        type?: string
        _stub?: boolean
      }>
      for (const child of children) {
        expect(
          child._stub === true ||
            (child.id !== undefined &&
              child.name !== undefined),
        ).toBe(true)
      }
    }
  })

  it('inspect_styles returns design system YAML', async () => {
    const result = await handleInspectStyles({}, client)

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('styles')
  })

  it('inspect_components returns component catalog', async () => {
    const result = await handleInspectComponents({}, client)

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('local')
  })

  it('search finds nodes by name pattern', async () => {
    const result = await handleSearch(
      { name: 'Card' },
      client,
    )

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('Card')
  })

  it('list_pages returns all pages in YAML', async () => {
    const result = await handleListPages(client)

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('Homepage')
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
