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
import { createMockPlugin } from '../mocks/mock-plugin'

const TEST_PORT = 3097
const RELAY_URL = `ws://localhost:${TEST_PORT}`
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
})
