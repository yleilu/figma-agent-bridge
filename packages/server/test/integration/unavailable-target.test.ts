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
import { handleConnect } from '@figma-agent-bridge/server/tools/session'
import { createMockPlugin } from '../mocks/mock-plugin'

const PORT = 3113
const WS_URL = `ws://localhost:${PORT}`
const HTTP_URL = `http://localhost:${PORT}`

describe('unavailable / ambiguous target → ask-error with available[]', () => {
  let server: Server<{ id: string }>
  const plugins: ReturnType<typeof createMockPlugin>[] = []
  let client: FigmaClient | null = null

  beforeEach(() => {
    server = startRelay(PORT)
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

  it('unknown fileKey lists available files and does NOT fall back / connect', async () => {
    const a = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'file-a-ch',
      fileKey: 'key-A',
      documentName: 'File A',
    })
    const b = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'file-b-ch',
      fileKey: 'key-B',
      documentName: 'File B',
    })
    plugins.push(a, b)
    await a.start()
    await b.start()
    await Bun.sleep(30)

    client = createFigmaClient(WS_URL)
    const res = await handleConnect(
      { fileKey: 'key-Z' }, // not open
      client,
      HTTP_URL,
      PORT,
    )
    const { text } = res.content[0]

    // NO guess, NO fallback to an open file
    expect(client.isConnected()).toBe(false)
    // available[] enumerated so the agent can choose
    expect(text).toContain('key-A')
    expect(text).toContain('key-B')
    expect(text).toContain('File A')
    expect(text).toContain('File B')
    // did not silently claim success on the requested key
    expect(text).not.toContain(
      'Connected to channel: key-Z',
    )
  })

  it('ambiguous fileName (two files share it) also asks with available[]', async () => {
    const a = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'shared-a-ch',
      fileKey: 'key-A',
      documentName: 'Shared',
    })
    const b = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'shared-b-ch',
      fileKey: 'key-B',
      documentName: 'Shared',
    })
    plugins.push(a, b)
    await a.start()
    await b.start()
    await Bun.sleep(30)

    client = createFigmaClient(WS_URL)
    const res = await handleConnect(
      { fileName: 'Shared' },
      client,
      HTTP_URL,
      PORT,
    )
    const { text } = res.content[0]

    expect(client.isConnected()).toBe(false)
    // both candidates surfaced by fileKey so the caller can disambiguate
    expect(text).toContain('key-A')
    expect(text).toContain('key-B')
  })
})
