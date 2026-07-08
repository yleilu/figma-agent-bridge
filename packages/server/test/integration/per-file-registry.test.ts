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
import { discoverChannels } from '@figma-agent-bridge/server/figma-client'
import { createMockPlugin } from '../mocks/mock-plugin'

const PORT = 3110
const WS_URL = `ws://localhost:${PORT}`
const HTTP_URL = `http://localhost:${PORT}`

describe('per-file channel registry (mock reports fileKey on register)', () => {
  let server: Server<{ id: string }>
  const plugins: ReturnType<typeof createMockPlugin>[] = []

  beforeEach(() => {
    server = startRelay(PORT)
  })

  afterEach(() => {
    for (const p of plugins) {
      p.stop()
    }
    plugins.length = 0
    stopRelay(server)
  })

  it('two saved files register distinct fileKeys discoverable via /channels', async () => {
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
    await Bun.sleep(30) // let both register frames reach the relay

    const channels = await discoverChannels(HTTP_URL)
    const infoA = channels.find(
      c => c.channel === 'file-a-ch',
    )
    const infoB = channels.find(
      c => c.channel === 'file-b-ch',
    )
    expect(infoA?.fileKey).toBe('key-A')
    expect(infoA?.fileName).toBe('File A')
    expect(infoB?.fileKey).toBe('key-B')
    expect(infoB?.fileName).toBe('File B')
  })

  it('a never-saved file registers fileKey:null (default, honest)', async () => {
    const p = createMockPlugin({
      relayUrl: WS_URL,
      channel: 'unsaved-ch',
      documentName: 'Untitled',
    })
    plugins.push(p)
    await p.start()
    await Bun.sleep(30)

    const channels = await discoverChannels(HTTP_URL)
    const info = channels.find(
      c => c.channel === 'unsaved-ch',
    )
    expect(info?.fileKey).toBeNull()
    expect(info?.fileName).toBe('Untitled')
  })
})
