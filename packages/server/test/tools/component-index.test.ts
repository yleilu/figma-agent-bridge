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
import { parse } from 'yaml'
import { IndexManager } from '@figma-agent-bridge/server/component-index/manager'
import {
  handleSearchComponents,
  handleReindex,
} from '@figma-agent-bridge/server/tools/component-index'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'

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
const stubClient = (opts: {
  connected?: boolean
  reply?: unknown
  sent?: Sent[]
  fileKey?: string | null
}): FigmaClient => ({
  joinChannel: async () => 'ch',
  sendCommand: async (command, params) => {
    opts.sent?.push({ command, params })
    return opts.reply ?? null
  },
  notify: () => {},
  onRequest: () => {},
  disconnect: () => {},
  isConnected: () => opts.connected ?? true,
  currentChannel: () => 'ch',
  currentFileKey: () =>
    opts.fileKey === undefined ? 'f' : opts.fileKey,
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
  it('errors when not connected', async () => {
    const mgr = new IndexManager()
    const res = await handleSearchComponents(
      { fileId: 'f', query: 'x' },
      stubClient({ connected: false }),
      mgr,
    )
    expect(res.content[0].text).toContain('Not connected')
  })
  it('builds via GET_COMPONENTS and returns matches + indexState', async () => {
    const mgr = new IndexManager()
    const sent: Sent[] = []
    const res = await handleSearchComponents(
      { fileId: 'f', query: 'button' },
      stubClient({ sent, reply }),
      mgr,
    )
    expect(sent[0].command).toBe(COMMANDS.GET_COMPONENTS)
    const out = parse(res.content[0].text)
    expect(out.indexState).toBe('warm')
    expect(
      out.results.map((r: { name: string }) => r.name),
    ).toEqual(['Primary Button'])
  })
  it('errors when fileId is not the connected file (B3)', async () => {
    const mgr = new IndexManager()
    const res = await handleSearchComponents(
      { fileId: 'other', query: 'x' },
      stubClient({ reply, fileKey: 'f' }),
      mgr,
    )
    expect(res.content[0].text).toContain(
      'operates on the connected file',
    )
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
          fileId: 'f',
          query: 'button',
          type: 'COMPONENT_SET',
        },
        stubClient({ reply: mixedReply }),
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
      { fileId: 'f' },
      stubClient({ reply }),
      mgr,
    )
    const out = parse(res.content[0].text)
    expect(out.count).toBe(1)
    expect(out.indexState).toBe('warm')
  })
})
