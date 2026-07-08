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
const SAME_PATCH = `${MAJ}.${MIN}.999` // same major.minor, different patch → OK
const MINOR_BUMP = `${MAJ}.${Number(MIN) + 1}.0` // minor bump = breaking → refuse

describe('handleConnect version handshake', () => {
  let server: ReturnType<typeof startRelay>
  beforeEach(() => {
    server = startRelay(PORT)
  })
  afterEach(() => {
    stopRelay(server)
  })

  it('connects when major.minor matches (exact version)', async () => {
    const plugin = createMockPlugin({
      relayUrl: WS,
      channel: 'ok',
      documentName: 'D',
    })
    await plugin.start()
    const client = createFigmaClient(WS)
    const res = await handleConnect(
      { channel: 'ok' },
      client,
      HTTP,
      PORT,
    )
    const out = JSON.parse(text(res))
    expect(out.connected).toBe(true)
    expect(out.channel).toBe('ok')
    client.disconnect()
    plugin.stop()
  })

  it('connects on a patch-only difference (tolerated)', async () => {
    const plugin = createMockPlugin({
      relayUrl: WS,
      channel: 'patch',
      documentName: 'D',
      version: SAME_PATCH,
    })
    await plugin.start()
    const client = createFigmaClient(WS)
    const res = await handleConnect(
      { channel: 'patch' },
      client,
      HTTP,
      PORT,
    )
    const out = JSON.parse(text(res))
    expect(out.connected).toBe(true)
    expect(out.channel).toBe('patch')
    client.disconnect()
    plugin.stop()
  })

  it('refuses on a minor difference (breaking) and names the fix', async () => {
    const plugin = createMockPlugin({
      relayUrl: WS,
      channel: 'bad',
      documentName: 'D',
      version: MINOR_BUMP,
    })
    await plugin.start()
    const client = createFigmaClient(WS)
    const res = await handleConnect(
      { channel: 'bad' },
      client,
      HTTP,
      PORT,
    )
    expect(text(res)).toContain('incompatible')
    expect(text(res)).toContain(APP_VERSION)
    expect(client.isConnected()).toBe(false)
    client.disconnect()
    plugin.stop()
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

  it('status reports fileKey, fileName, and available[]', async () => {
    const plugin = createMockPlugin({
      relayUrl: WS,
      channel: 'st-ch2',
      documentName: 'Status File',
    })
    await plugin.start()
    const client = createFigmaClient(WS)
    // Join with a target fileKey so status echoes the client-tracked identity.
    await client.joinChannel('st-ch2', 'key-s')

    const res = await handleStatus(client, HTTP)
    const out = JSON.parse(text(res))
    expect(out.connected).toBe(true)
    expect(out.channel).toBe('st-ch2')
    expect(out.fileKey).toBe('key-s')
    expect(out.fileName).toBe('Status File')
    expect(Array.isArray(out.available)).toBe(true)
    expect(out.available.length).toBeGreaterThanOrEqual(1)

    client.disconnect()
    plugin.stop()
  })
})

// Raw channel register (connect only JOINS, so no mock plugin is needed): open
// a ws, join `channel`, and register it with a fileName/fileKey so /channels
// lists it as an available file.
const registerRaw = async (
  channel: string,
  fileName: string | null,
  fileKey: string | null,
): Promise<WebSocket> => {
  const ws = await new Promise<WebSocket>(
    (resolve, reject) => {
      const s = new WebSocket(WS)
      s.onopen = () => resolve(s)
      s.onerror = () => reject(new Error('connect failed'))
    },
  )
  ws.send(JSON.stringify({ type: 'join', channel }))
  await Bun.sleep(20)
  ws.send(
    JSON.stringify({
      type: 'register',
      channel,
      fileName,
      fileKey,
      version: APP_VERSION,
    }),
  )
  await Bun.sleep(30)
  return ws
}

describe('handleConnect file targeting', () => {
  let server: ReturnType<typeof startRelay>
  beforeEach(() => {
    server = startRelay(PORT)
  })
  afterEach(() => {
    stopRelay(server)
  })

  it('routes to the file whose fileName matches', async () => {
    const a = await registerRaw('ch-a', 'Design A', 'key-a')
    const b = await registerRaw('ch-b', 'Design B', 'key-b')
    const client = createFigmaClient(WS)

    const res = await handleConnect(
      { fileName: 'Design B' },
      client,
      HTTP,
      PORT,
    )
    const out = JSON.parse(text(res))
    expect(out.connected).toBe(true)
    expect(out.channel).toBe('ch-b')
    expect(out.fileName).toBe('Design B')
    expect(out.available).toHaveLength(2)

    client.disconnect()
    a.close()
    b.close()
  })

  it('ASKS (no guess) with available[] when the target is unknown', async () => {
    const a = await registerRaw('ch-a', 'Design A', 'key-a')
    const b = await registerRaw('ch-b', 'Design B', 'key-b')
    const client = createFigmaClient(WS)

    const res = await handleConnect(
      { fileName: 'Nonexistent' },
      client,
      HTTP,
      PORT,
    )
    const msg = text(res)
    expect(msg).toContain('No connected Figma file')
    expect(msg).toContain('Design A')
    expect(msg).toContain('Design B')
    expect(client.isConnected()).toBe(false)

    client.disconnect()
    a.close()
    b.close()
  })

  it('ASKS (unspecified) when a bare connect names no file', async () => {
    const a = await registerRaw('ch-a', 'Design A', 'key-a')
    const b = await registerRaw('ch-b', 'Design B', 'key-b')
    const client = createFigmaClient(WS)

    const res = await handleConnect({}, client, HTTP, PORT)
    const msg = text(res)
    expect(msg).toContain('No target file specified')
    expect(msg).toContain('Design A')
    expect(msg).toContain('Design B')
    expect(client.isConnected()).toBe(false)

    client.disconnect()
    a.close()
    b.close()
  })
})
