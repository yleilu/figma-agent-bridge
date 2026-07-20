import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import type { Server } from 'bun'
import type { ChannelInfo } from '@figma-agent-bridge/shared'
import { APP_VERSION } from '@figma-agent-bridge/shared'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import { createFigmaClient } from '@figma-agent-bridge/server/figma-client'
import { CursorError } from '@figma-agent-bridge/server/read/paginate'
import {
  textResult,
  formatMutationResult,
  errorMessage,
  cursorRejected,
  errorEnvelope,
  synthKey,
  requireFile,
} from '@figma-agent-bridge/server/tools/shared'

describe('textResult', () => {
  it('wraps a string in the ToolResult shape', () => {
    expect(textResult('hi')).toEqual({
      content: [{ type: 'text', text: 'hi' }],
    })
  })
})

describe('errorMessage', () => {
  it('returns err.message for Error instances', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })

  it('stringifies non-Error values', () => {
    expect(errorMessage('raw string')).toBe('raw string')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(null)).toBe('null')
  })
})

describe('cursorRejected', () => {
  it('returns the STALE re-run message string for a STALE cursor', () => {
    expect(cursorRejected(new CursorError('STALE'))).toBe(
      'Cursor rejected (STALE) — re-run the read to get a fresh cursor.',
    )
  })

  it('returns the MALFORMED re-run message string for a MALFORMED cursor', () => {
    expect(
      cursorRejected(new CursorError('MALFORMED')),
    ).toBe(
      'Cursor rejected (MALFORMED) — re-run the read to get a fresh cursor.',
    )
  })
})

describe('formatMutationResult', () => {
  it('returns the fail message when result is null', () => {
    expect(
      formatMutationResult(null, 'Failed to create node.')
        .content[0].text,
    ).toBe('Failed to create node.')
  })

  it('prefixes Error: when result.error is set', () => {
    expect(
      formatMutationResult({ error: 'boom' }, 'fail')
        .content[0].text,
    ).toBe('Error: boom')
  })

  it('pretty-prints JSON otherwise', () => {
    const r = formatMutationResult(
      { id: '1:2' } as { error?: string },
      'fail',
    )
    expect(r.content[0].text).toBe(
      JSON.stringify({ id: '1:2' }, null, 2),
    )
  })
})

// A healthy connected file reports the current APP_VERSION (passes the B2 gate);
// the skew test below overrides version explicitly.
const info = (
  channel: string,
  fileKey: string | null,
  fileName: string | null,
): ChannelInfo => ({
  channel,
  fileKey,
  fileName,
  connectedAt: 0,
  version: APP_VERSION,
})

const makeClient = (
  over: Partial<FigmaClient>,
): FigmaClient => ({
  joinChannel: () => Promise.resolve(''),
  sendCommand: () => Promise.resolve(null),
  forFile: fileKey => ({
    fileKey,
    sendCommand: () => Promise.resolve(null),
  }),
  notify: () => undefined,
  onRequest: () => undefined,
  disconnect: () => undefined,
  isConnected: () => true,
  joinedFiles: () => [],
  channelFor: () => null,
  discover: () => Promise.resolve([]),
  isInstanceDead: () => false,
  notifyMismatch: () => undefined,
  ...over,
})

describe('errorEnvelope', () => {
  it('emits { error, code } JSON', () => {
    expect(
      JSON.parse(
        errorEnvelope('DISCONNECTED', 'down').content[0]
          .text,
      ),
    ).toEqual({
      error: 'down',
      code: 'DISCONNECTED',
    })
  })
})

describe('synthKey', () => {
  it('returns the real fileKey when present', () => {
    expect(synthKey(info('ch', 'fk', 'N'))).toBe('fk')
  })
  it('falls back to the channel for an unsaved file', () => {
    expect(synthKey(info('sess-123', null, 'N'))).toBe(
      'sess-123',
    )
  })
})

describe('requireFile', () => {
  it('returns ok when the file is already joined', async () => {
    const client = makeClient({ channelFor: () => 'ch-a' })
    expect(await requireFile(client, 'fk-a')).toEqual({
      ok: true,
      fileKey: 'fk-a',
    })
  })

  it('DISCONNECTED when the registry is empty', async () => {
    const r = await requireFile(
      makeClient({ discover: () => Promise.resolve([]) }),
      'fk-a',
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(
        JSON.parse(r.result.content[0].text).code,
      ).toBe('DISCONNECTED')
    }
  })

  it('WRONG_FILE + ASK list when the fileKey is not available', async () => {
    const r = await requireFile(
      makeClient({
        discover: () =>
          Promise.resolve([
            info('ch-b', 'fk-b', 'Design B'),
          ]),
      }),
      'fk-a',
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const env = JSON.parse(r.result.content[0].text)
      expect(env.code).toBe('WRONG_FILE')
      expect(env.error).toContain('fk-b')
      expect(env.error).toContain('Design B')
    }
  })

  it('auto-joins an available file then returns ok', async () => {
    let joinedWith: [string, string] | null = null
    const client = makeClient({
      discover: () =>
        Promise.resolve([info('ch-a', 'fk-a', 'Design A')]),
      joinChannel: (ch, fk) => {
        joinedWith = [ch, fk]
        return Promise.resolve('ok')
      },
    })
    expect(await requireFile(client, 'fk-a')).toEqual({
      ok: true,
      fileKey: 'fk-a',
    })
    expect(joinedWith).toEqual(['ch-a', 'fk-a'])
  })

  it('auto-joins an unsaved file addressed by its synthetic (channel) key', async () => {
    let joinedWith: [string, string] | null = null
    const client = makeClient({
      discover: () =>
        Promise.resolve([info('sess-9', null, 'Untitled')]),
      joinChannel: (ch, fk) => {
        joinedWith = [ch, fk]
        return Promise.resolve('ok')
      },
    })
    expect(await requireFile(client, 'sess-9')).toEqual({
      ok: true,
      fileKey: 'sess-9',
    })
    expect(joinedWith).toEqual(['sess-9', 'sess-9'])
  })

  it('refuses a version-skewed plugin (B2) AND pushes version-mismatch, BEFORE joining', async () => {
    // ChannelInfo has a `version?: string` field; a skewed value → INCOMPATIBLE.
    const skewed: ChannelInfo = {
      channel: 'ch-old',
      fileKey: 'fk-old',
      fileName: 'Old',
      connectedAt: 0,
      version: '0.0.1', // ≠ APP_VERSION major.minor
    }
    let joinCalled = false
    const pushes: [string, string, string][] = []
    const client = makeClient({
      discover: () => Promise.resolve([skewed]),
      joinChannel: () => {
        joinCalled = true
        return Promise.resolve('ok')
      },
      notifyMismatch: (channel, plugin, server) => {
        pushes.push([channel, plugin, server])
      },
    })
    const r = await requireFile(client, 'fk-old')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(
        JSON.parse(r.result.content[0].text).code,
      ).toBe('INCOMPATIBLE')
    }
    expect(joinCalled).toBe(false) // no join, no dispatch — refused loudly, not a 30s hang
    expect(pushes).toEqual([
      ['ch-old', '0.0.1', APP_VERSION],
    ])
  })

  it('a plugin reporting NO version pushes plugin: "(none)"', async () => {
    const pushes: [string, string, string][] = []
    const client = makeClient({
      discover: () =>
        Promise.resolve([
          {
            channel: 'ch-x',
            fileKey: 'fk-x',
            fileName: 'X',
            connectedAt: 0,
          } as ChannelInfo,
        ]),
      notifyMismatch: (c, p, s) => pushes.push([c, p, s]),
    })
    const r = await requireFile(client, 'fk-x')
    expect(r.ok).toBe(false)
    expect(pushes).toEqual([
      ['ch-x', '(none)', APP_VERSION],
    ])
  })

  it('does NOT push on a healthy (matching) file', async () => {
    let pushed = false
    const client = makeClient({
      discover: () =>
        Promise.resolve([info('ch-a', 'fk-a', 'A')]),
      joinChannel: () => Promise.resolve('ok'),
      notifyMismatch: () => {
        pushed = true
      },
    })
    // `info(...)` carries APP_VERSION by default — the healthy path.
    await requireFile(client, 'fk-a')
    expect(pushed).toBe(false)
  })

  // connection-liveness.md: the watchdog (L6) declares an unresponsive instance
  // dead by fileKey → connectedAt. requireFile must fast-fail DISCONNECTED while
  // the /channels entry's connectedAt still matches the declared-dead value,
  // BEFORE auto-joining — the server is not joined here (channelFor → null), so
  // the discover() branch is reached and the marker check applies.
  it('DISCONNECTED when the watchdog has declared this instance dead (connectedAt still matches)', async () => {
    let joinCalled = false
    const client = makeClient({
      channelFor: () => null,
      discover: () =>
        Promise.resolve([
          info('ch-dead', 'fk-dead', 'Dead Design'),
        ]).then(list =>
          list.map(c => ({ ...c, connectedAt: 100 })),
        ),
      isInstanceDead: (fileKey, connectedAt) =>
        fileKey === 'fk-dead' && connectedAt === 100,
      joinChannel: () => {
        joinCalled = true
        return Promise.resolve('ok')
      },
    })
    const r = await requireFile(client, 'fk-dead')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(
        JSON.parse(r.result.content[0].text).code,
      ).toBe('DISCONNECTED')
    }
    expect(joinCalled).toBe(false) // marker fast-fails before auto-join
  })
})

const RF_PORT = 3101
const RF_WS = `ws://localhost:${RF_PORT}`

const registerRawRF = async (
  channel: string,
  fileName: string,
  fileKey: string,
): Promise<WebSocket> => {
  const ws = await new Promise<WebSocket>(
    (resolve, reject) => {
      const s = new WebSocket(RF_WS)
      s.onopen = () => resolve(s)
      s.onerror = () => reject(new Error('connect failed'))
    },
  )
  ws.send(JSON.stringify({ type: 'join', channel }))
  await Bun.sleep(20)
  // Register with the current APP_VERSION so requireFile's B2 gate passes.
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

describe('requireFile concurrency (real client)', () => {
  let server: Server<{ id: string }>
  beforeEach(() => {
    server = startRelay(RF_PORT)
  })
  afterEach(() => {
    stopRelay(server)
  })

  it('two concurrent first-touches to DIFFERENT files both return ok', async () => {
    const a = await registerRawRF(
      'ch-a',
      'Design A',
      'fk-a',
    )
    const b = await registerRawRF(
      'ch-b',
      'Design B',
      'fk-b',
    )
    const client = createFigmaClient(RF_WS)
    const [ra, rb] = await Promise.all([
      requireFile(client, 'fk-a'),
      requireFile(client, 'fk-b'),
    ])
    expect(ra.ok).toBe(true)
    expect(rb.ok).toBe(true)
    expect(client.joinedFiles().sort()).toEqual([
      'fk-a',
      'fk-b',
    ])
    client.disconnect()
    a.close()
    b.close()
  })
})
