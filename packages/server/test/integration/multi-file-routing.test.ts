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
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleConnect,
  handleStatus,
} from '@figma-agent-bridge/server/tools/session'
import { createMockPlugin } from '../mocks/mock-plugin'

const PORT = 3112
const WS_URL = `ws://localhost:${PORT}`
const HTTP_URL = `http://localhost:${PORT}`

describe('multi-file targeting: connect by fileKey routes correctly', () => {
  let server: Server<{ id: string }>
  const plugins: ReturnType<typeof createMockPlugin>[] = []
  let client: FigmaClient | null = null

  beforeEach(async () => {
    server = startRelay(PORT)
    const a = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'file-a-ch',
      fileKey: 'key-A',
      documentName: 'File A',
      pageName: 'Page A',
    })
    const b = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'file-b-ch',
      fileKey: 'key-B',
      documentName: 'File B',
      pageName: 'Page B',
    })
    plugins.push(a, b)
    await a.start()
    await b.start()
    await Bun.sleep(30) // both registered before discovery
  })

  afterEach(() => {
    if (client !== null) {
      client.disconnect()
      client = null
    }
    for (const p of plugins) {
      p.stop()
    }
    plugins.length = 0
    stopRelay(server)
  })

  it('connect({fileKey:"key-A"}) routes commands to File A', async () => {
    client = createFigmaClient(WS_URL)
    const res = await handleConnect(
      { fileKey: 'key-A' },
      client,
      HTTP_URL,
      PORT,
    )
    // connected to A, not a discovery/ambiguity message
    expect(res.content[0].text).not.toContain(
      'No Figma plugins',
    )
    expect(res.content[0].text).toContain('key-A')

    const statusRes = await handleStatus(client, HTTP_URL)
    const status = JSON.parse(
      statusRes.content[0].text,
    ) as { currentPage: { name: string } }
    expect(status.currentPage.name).toBe('Page A')
  })

  it('connect({fileKey:"key-B"}) routes commands to File B', async () => {
    client = createFigmaClient(WS_URL)
    const res = await handleConnect(
      { fileKey: 'key-B' },
      client,
      HTTP_URL,
      PORT,
    )
    expect(res.content[0].text).toContain('key-B')

    const statusRes = await handleStatus(client, HTTP_URL)
    const status = JSON.parse(
      statusRes.content[0].text,
    ) as { currentPage: { name: string } }
    expect(status.currentPage.name).toBe('Page B')
  })
})
