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
    expect(parsed.joined[0].protocolVersion).toBe(
      APP_VERSION,
    )
    client.disconnect()
    plugin.stop()
  })

  it('status merges the per-file live context from a responding plugin', async () => {
    const plugin = createMockPlugin({
      relayUrl: WS,
      channel: 'st-live',
      documentName: 'Live',
    })
    await plugin.start()
    const client = createFigmaClient(WS)
    await handleConnect(
      { channel: 'st-live' },
      client,
      HTTP,
      PORT,
    )

    const out = JSON.parse(
      text(await handleStatus(client, HTTP)),
    )
    const entry = out.joined[0]
    expect(entry.currentPage.id).toBe('page:1')
    expect(entry.selection).toHaveLength(1)
    expect(entry.selection[0].id).toBe('1:42')
    expect(entry.viewport.zoom).toBe(1.5)

    client.disconnect()
    plugin.stop()
  })

  it('status reports fileKey, fileName, and available[]', async () => {
    const plugin = createMockPlugin({
      relayUrl: WS,
      channel: 'st-ch2',
      documentName: 'Status File',
      // Register the plugin's identity so status matches it by synthKey.
      fileKey: 'key-s',
    })
    await plugin.start()
    const client = createFigmaClient(WS)
    // Join with a target fileKey so status echoes the client-tracked identity.
    await client.joinChannel('st-ch2', 'key-s')

    const res = await handleStatus(client, HTTP)
    const out = JSON.parse(text(res))
    expect(out.connected).toBe(true)
    expect(out.joined[0].channel).toBe('st-ch2')
    expect(out.joined[0].fileKey).toBe('key-s')
    expect(out.joined[0].fileName).toBe('Status File')
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

  it('surfaces a synthetic fileKey (= channel) for an unsaved file', async () => {
    const u = await registerRaw('sess-x', 'Untitled', null)
    const client = createFigmaClient(WS)
    const out = JSON.parse(
      text(
        await handleConnect(
          { channel: 'sess-x' },
          client,
          HTTP,
          PORT,
        ),
      ),
    )
    expect(out.fileKey).toBe('sess-x')
    expect(
      out.available.find(
        (f: { fileKey: string }) => f.fileKey === 'sess-x',
      ),
    ).toBeDefined()
    client.disconnect()
    u.close()
  })

  it('joins an explicit channel that is NOT in the registry (escape hatch)', async () => {
    // A registered file exists, but the caller targets a different, unregistered
    // channel directly. info is undefined (channel unknown to /channels) → NO
    // version check → the join proceeds. It must NOT be misreported as a
    // '(none)' version skew (an unregistered channel ≠ a version mismatch).
    const a = await registerRaw('ch-a', 'Design A', 'key-a')
    const client = createFigmaClient(WS)

    const res = await handleConnect(
      { channel: 'ch-raw' },
      client,
      HTTP,
      PORT,
    )
    const out = JSON.parse(text(res))
    expect(out.connected).toBe(true)
    expect(out.channel).toBe('ch-raw')
    expect(out.fileKey).toBe('ch-raw')
    expect(client.channelFor('ch-raw')).toBe('ch-raw')

    client.disconnect()
    a.close()
  })
})

describe('connect/status multi-file contract', () => {
  let server: ReturnType<typeof startRelay>
  beforeEach(() => {
    server = startRelay(PORT)
  })
  afterEach(() => {
    stopRelay(server)
  })

  it('connect pre-joins a named fileKey and can then drive it', async () => {
    const a = await registerRaw('ch-a', 'Design A', 'key-a')
    const client = createFigmaClient(WS)
    const out = JSON.parse(
      text(
        await handleConnect(
          { fileKey: 'key-a' },
          client,
          HTTP,
          PORT,
        ),
      ),
    )
    expect(out.connected).toBe(true)
    expect(out.fileKey).toBe('key-a')
    expect(client.channelFor('key-a')).toBe('ch-a')
    client.disconnect()
    a.close()
  })

  it('status reports ALL joined files + availability', async () => {
    const a = await registerRaw('ch-a', 'Design A', 'key-a')
    const b = await registerRaw('ch-b', 'Design B', 'key-b')
    const client = createFigmaClient(WS)
    await client.joinChannel('ch-a', 'key-a')
    await client.joinChannel('ch-b', 'key-b')
    const out = JSON.parse(
      text(await handleStatus(client, HTTP)),
    )
    expect(out.connected).toBe(true)
    expect(
      out.joined
        .map((f: { fileKey: string }) => f.fileKey)
        .sort(),
    ).toEqual(['key-a', 'key-b'])
    expect(out.available.length).toBe(2)
    client.disconnect()
    a.close()
    b.close()
  })

  it('status reports disconnected when nothing is joined', async () => {
    const client = createFigmaClient(WS)
    expect(
      text(await handleStatus(client, HTTP)),
    ).toContain('disconnected')
    client.disconnect()
  })
})
