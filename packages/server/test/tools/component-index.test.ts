// component-index.test.ts — handleSearchComponents / handleReindex.
//
// The handlers take a ScopedFigmaClient (the withFile wrapper gates + scopes)
// and key the index by client.fileKey — no current-file coupling, no bespoke
// resolveTarget. Unit tests drive a scoped stub; the real-client tests drive
// TWO files through one client + one IndexManager to prove per-fileKey keying,
// and the wrapper's WRONG_FILE ASK for an un-joined fileKey.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'bun'
import { parse } from 'yaml'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { IndexManager } from '@figma-agent-bridge/server/component-index/manager'
import {
  handleSearchComponents,
  handleReindex,
} from '@figma-agent-bridge/server/tools/component-index'
import { withFile } from '@figma-agent-bridge/server/tools/with-file'
import {
  createFigmaClient,
  type FigmaClient,
  type ScopedFigmaClient,
} from '@figma-agent-bridge/server/figma-client'
import { COMMANDS } from '@figma-agent-bridge/shared'
import { createMockPlugin } from '../mocks/mock-plugin'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ci-tool-'))
  process.env.COMPONENT_INDEX_DIR = dir
})
afterEach(async () => {
  delete process.env.COMPONENT_INDEX_DIR
  await rm(dir, { recursive: true, force: true })
})

type Sent = {
  command: string
  params?: Record<string, unknown>
}

const stubScoped = (opts: {
  reply?: unknown
  sent?: Sent[]
  fileKey?: string
}): ScopedFigmaClient => ({
  fileKey: opts.fileKey ?? 'fk-test',
  sendCommand: async (
    command: string,
    params?: Record<string, unknown>,
  ) => {
    opts.sent?.push({ command, params })
    return opts.reply ?? null
  },
})

const reply = {
  local: [
    {
      id: '1',
      key: 'k1',
      name: 'Primary Button',
      type: 'COMPONENT',
      page: 'p',
      properties: [],
      variantAxes: {},
    },
  ],
  remote: [],
}

describe('handleSearchComponents', () => {
  it('builds via GET_COMPONENTS and returns matches + indexState', async () => {
    const mgr = new IndexManager()
    const sent: Sent[] = []
    const res = await handleSearchComponents(
      { query: 'button' },
      stubScoped({ sent, reply }),
      mgr,
    )
    expect(sent[0].command).toBe(COMMANDS.GET_COMPONENTS)
    const out = parse(res.content[0].text)
    expect(out.indexState).toBe('warm')
    expect(
      out.results.map((r: { name: string }) => r.name),
    ).toEqual(['Primary Button'])
  })
})

describe('handleSearchComponents type filter', () => {
  it(
    'returns only the requested type ' +
      '(truncated reflects filtered set)',
    async () => {
      const mgr = new IndexManager()
      const mixedReply = {
        local: [
          {
            id: '1',
            key: 'k1',
            name: 'Alpha Button',
            type: 'COMPONENT',
            page: 'p',
            properties: [],
            variantAxes: {},
          },
          {
            id: '2',
            key: 'k2',
            name: 'Beta Button',
            type: 'COMPONENT_SET',
            page: 'p',
            properties: [],
            variantAxes: {},
          },
        ],
        remote: [],
      }
      const res = await handleSearchComponents(
        {
          query: 'button',
          type: 'COMPONENT_SET',
        },
        stubScoped({ reply: mixedReply }),
        mgr,
      )
      const out = parse(res.content[0].text)
      expect(
        out.results.every(
          (r: { type: string }) =>
            r.type === 'COMPONENT_SET',
        ),
      ).toBe(true)
      expect(
        out.results.map((r: { id: string }) => r.id),
      ).toEqual(['2'])
    },
  )
})

describe('handleReindex', () => {
  it('rebuilds and reports count', async () => {
    const mgr = new IndexManager()
    const res = await handleReindex(
      {},
      stubScoped({ reply }),
      mgr,
    )
    const out = parse(res.content[0].text)
    expect(out.count).toBe(1)
    expect(out.indexState).toBe('warm')
  })
})

describe('component-index per-fileKey routing (real client)', () => {
  const TEST_PORT = 3119
  const RELAY_URL = `ws://localhost:${TEST_PORT}`
  let server: Server<{ id: string }>
  let client: FigmaClient

  beforeEach(() => {
    server = startRelay(TEST_PORT)
    client = createFigmaClient(RELAY_URL)
  })
  afterEach(() => {
    client.disconnect()
    stopRelay(server)
  })

  it('searches TWO files independently — index keyed per fileKey', async () => {
    const pa = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: 'ci-a',
      documentName: 'Doc A',
      fileKey: 'fk-a',
    })
    const pb = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: 'ci-b',
      documentName: 'Doc B',
      fileKey: 'fk-b',
    })
    await pa.start()
    await pb.start()
    await client.joinChannel('ci-a', 'fk-a')
    await client.joinChannel('ci-b', 'fk-b')
    const manager = new IndexManager()

    const ra = await handleSearchComponents(
      { query: 'Button' },
      client.forFile('fk-a'),
      manager,
    )
    const rb = await handleSearchComponents(
      { query: 'Button' },
      client.forFile('fk-b'),
      manager,
    )
    // Both files are searchable, AND each result set carries ONLY its own
    // fileKey (ComponentIndexRecord.fileKey is a store field). This is the
    // discriminating guard: a mis-key — the IndexManager collapsing both files
    // onto one entry, or the scoped client routing both calls to one channel —
    // would leak the other file's key here and fail.
    expect(ra.content[0].text).toContain('Button')
    expect(rb.content[0].text).toContain('Button')
    expect(ra.content[0].text).toContain('fk-a')
    expect(ra.content[0].text).not.toContain('fk-b')
    expect(rb.content[0].text).toContain('fk-b')
    expect(rb.content[0].text).not.toContain('fk-a')

    const reA = await handleReindex(
      {},
      client.forFile('fk-a'),
      manager,
    )
    expect(reA.content[0].text).not.toContain('Error')
    // Reindexing fk-a must not contaminate fk-b's index: re-searching fk-b
    // still returns ONLY fk-b's key.
    const rb2 = await handleSearchComponents(
      { query: 'Button' },
      client.forFile('fk-b'),
      manager,
    )
    expect(rb2.content[0].text).toContain('Button')
    expect(rb2.content[0].text).toContain('fk-b')
    expect(rb2.content[0].text).not.toContain('fk-a')

    pa.stop()
    pb.stop()
  })

  it('ASKS (WRONG_FILE) via the wrapper for an un-joined fileKey', async () => {
    // A plugin IS available (fk-real) but the caller addresses fk-nope: a
    // non-empty registry without the requested key → WRONG_FILE (ASK), not
    // DISCONNECTED. requireFile never guesses (B3).
    const plugin = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: 'ci-real',
      documentName: 'Real Doc',
      fileKey: 'fk-real',
    })
    await plugin.start()
    const wrapped = withFile(client, (p, c) =>
      handleSearchComponents(p, c, new IndexManager()),
    )
    const res = await wrapped({
      fileKey: 'fk-nope',
      query: 'x',
    })
    expect(JSON.parse(res.content[0].text).code).toBe(
      'WRONG_FILE',
    )
    plugin.stop()
  })
})
