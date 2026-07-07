import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { startRelay, stopRelay } from '@figma-agent-bridge/relay/relay'
import { PROTOCOL_VERSION } from '@figma-agent-bridge/shared'
import { createFigmaClient } from '@figma-agent-bridge/server/figma-client'
import { handleConnect, handleStatus } from '@figma-agent-bridge/server/tools/session'
import { createMockPlugin } from './mocks/mock-plugin'

const PORT = 18192
const WS = `ws://localhost:${PORT}`
const HTTP = `http://localhost:${PORT}`
const text = (r: { content: { text: string }[] }) => r.content[0].text as string

describe('handleConnect version handshake', () => {
  let server: ReturnType<typeof startRelay>
  beforeEach(() => { server = startRelay(PORT) })
  afterEach(() => { stopRelay(server) })

  it('connects when the plugin protocol version matches', async () => {
    const plugin = createMockPlugin({ relayUrl: WS, channel: 'ok-ch', documentName: 'D' })
    await plugin.start()
    const client = createFigmaClient(WS)
    const res = await handleConnect({ channel: 'ok-ch' }, client, HTTP, PORT)
    expect(text(res)).toContain('Connected to channel: ok-ch')
    client.disconnect(); plugin.stop()
  })

  it('refuses to connect on a protocol mismatch and names the fix', async () => {
    const plugin = createMockPlugin({ relayUrl: WS, channel: 'bad-ch', documentName: 'D', version: '999' })
    await plugin.start()
    const client = createFigmaClient(WS)
    const res = await handleConnect({ channel: 'bad-ch' }, client, HTTP, PORT)
    expect(text(res)).toContain('incompatible')
    expect(text(res)).toContain(PROTOCOL_VERSION)
    expect(client.isConnected()).toBe(false)
    client.disconnect(); plugin.stop()
  })

  it('status reports the connected channel protocol version', async () => {
    const plugin = createMockPlugin({ relayUrl: WS, channel: 'st-ch', documentName: 'D' })
    await plugin.start()
    const client = createFigmaClient(WS)
    await handleConnect({ channel: 'st-ch' }, client, HTTP, PORT)
    const res = await handleStatus(client, HTTP)
    const parsed = JSON.parse(text(res))
    expect(parsed.protocolVersion).toBe(PROTOCOL_VERSION)
    client.disconnect(); plugin.stop()
  })
})
