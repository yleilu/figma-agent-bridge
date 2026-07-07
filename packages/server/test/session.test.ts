import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'bun:test'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { APP_VERSION } from '@figma-agent-bridge/shared'
import { createFigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  handleConnect,
  handleStatus,
} from '@figma-agent-bridge/server/tools/session'
import { createMockPlugin } from './mocks/mock-plugin'

const PORT = 18192
const WS = `ws://localhost:${PORT}`
const HTTP = `http://localhost:${PORT}`
const text = (r: { content: { text: string }[] }) =>
  r.content[0].text

const [MAJ, MIN] = APP_VERSION.split('.')
const SAME_PATCH = `${MAJ}.${MIN}.999`               // same major.minor, different patch → OK
const MINOR_BUMP = `${MAJ}.${Number(MIN) + 1}.0`     // minor bump = breaking → refuse

describe('handleConnect version handshake', () => {
  let server: ReturnType<typeof startRelay>
  beforeEach(() => {
    server = startRelay(PORT)
  })
  afterEach(() => {
    stopRelay(server)
  })

  it('connects when major.minor matches (exact version)', async () => {
    const plugin = createMockPlugin({ relayUrl: WS, channel: 'ok', documentName: 'D' })
    await plugin.start()
    const client = createFigmaClient(WS)
    const res = await handleConnect({ channel: 'ok' }, client, HTTP, PORT)
    expect(text(res)).toContain('Connected to channel: ok')
    client.disconnect(); plugin.stop()
  })

  it('connects on a patch-only difference (tolerated)', async () => {
    const plugin = createMockPlugin({ relayUrl: WS, channel: 'patch', documentName: 'D', version: SAME_PATCH })
    await plugin.start()
    const client = createFigmaClient(WS)
    const res = await handleConnect({ channel: 'patch' }, client, HTTP, PORT)
    expect(text(res)).toContain('Connected to channel: patch')
    client.disconnect(); plugin.stop()
  })

  it('refuses on a minor difference (breaking) and names the fix', async () => {
    const plugin = createMockPlugin({ relayUrl: WS, channel: 'bad', documentName: 'D', version: MINOR_BUMP })
    await plugin.start()
    const client = createFigmaClient(WS)
    const res = await handleConnect({ channel: 'bad' }, client, HTTP, PORT)
    expect(text(res)).toContain('incompatible')
    expect(text(res)).toContain(APP_VERSION)
    expect(client.isConnected()).toBe(false)
    client.disconnect(); plugin.stop()
  })

  it('status reports the connected channel version', async () => {
    const plugin = createMockPlugin({
      relayUrl: WS,
      channel: 'st-ch',
      documentName: 'D',
    })
    await plugin.start()
    const client = createFigmaClient(WS)
    await handleConnect(
      { channel: 'st-ch' },
      client,
      HTTP,
      PORT,
    )
    const res = await handleStatus(client, HTTP)
    const parsed = JSON.parse(text(res))
    expect(parsed.protocolVersion).toBe(APP_VERSION)
    client.disconnect()
    plugin.stop()
  })
})
