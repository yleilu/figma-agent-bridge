import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
} from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IndexManager } from '@figma-agent-bridge/server/component-index/manager'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'manager-test-'))
  process.env.COMPONENT_INDEX_DIR = tmpDir
})

afterEach(async () => {
  delete process.env.COMPONENT_INDEX_DIR
  await rm(tmpDir, { recursive: true, force: true })
})

const reply = (names: string[]) => ({
  local: names.map((name, i) => ({
    id: `${i}`,
    key: `k${i}`,
    name,
    type: 'COMPONENT',
    page: 'p',
    properties: [],
    variantAxes: {},
  })),
  remote: [],
})

describe('IndexManager', () => {
  it('builds on first search (cold -> warm) and finds a component', async () => {
    const mgr = new IndexManager()
    let calls = 0
    const out = await mgr.search(
      'file-a',
      'button',
      10,
      async () => {
        calls += 1
        return reply(['Primary Button', 'Card'])
      },
    )
    expect(calls).toBe(1)
    expect(out.indexState).toBe('warm')
    expect(out.results.map(r => r.name)).toEqual([
      'Primary Button',
    ])
  })

  it('does not rebuild while warm', async () => {
    const mgr = new IndexManager()
    let calls = 0
    const get = async () => {
      calls += 1
      return reply(['Button'])
    }
    await mgr.search('file-a', 'button', 10, get)
    await mgr.search('file-a', 'button', 10, get)
    expect(calls).toBe(1)
  })

  it('rebuilds after markStale', async () => {
    const mgr = new IndexManager()
    let names = ['Button']
    const get = async () => reply(names)
    await mgr.search('file-a', 'x', 10, get)
    mgr.markStale('file-a')
    names = ['Button', 'New Thing']
    const out = await mgr.search('file-a', 'new', 10, get)
    expect(out.results.map(r => r.name)).toEqual([
      'New Thing',
    ])
  })

  it('reindex forces a rebuild and returns count', async () => {
    const mgr = new IndexManager()
    const out = await mgr.reindex('file-a', async () =>
      reply(['A', 'B', 'C']),
    )
    expect(out.indexState).toBe('warm')
    expect(out.count).toBe(3)
  })

  it(
    'revalidates a rehydrated index once, then serves it ' +
      'warm',
    async () => {
      const mgrA = new IndexManager()
      await mgrA.reindex('file-a', async () =>
        reply(['Button']),
      )
      const mgrB = new IndexManager()
      let calls = 0
      const get = async () => {
        calls += 1
        return reply(['Button'])
      }
      const first = await mgrB.search(
        'file-a',
        'button',
        10,
        get,
      )
      const second = await mgrB.search(
        'file-a',
        'button',
        10,
        get,
      )
      // one revalidation for the unvalidated cache — and
      // exactly one: the second search is already warm
      expect(calls).toBe(1)
      expect(first.indexState).toBe('warm')
      expect(second.indexState).toBe('warm')
      expect(second.results.map(r => r.name)).toEqual([
        'Button',
      ])
    },
  )

  it(
    'does not serve an unvalidated disk cache as ' +
      'authoritative',
    async () => {
      const mgrA = new IndexManager()
      await mgrA.reindex('file-a', async () =>
        reply(['Button']),
      )
      // The document has moved on since that projection;
      // the on-disk index is of unknown age and has had
      // no freshness check.
      const mgrB = new IndexManager()
      let calls = 0
      const out = await mgrB.search(
        'file-a',
        'new',
        10,
        async () => {
          calls += 1
          return reply(['Button', 'New Thing'])
        },
      )
      // A rehydrated cache must be revalidated against
      // the document before its results are labelled
      // authoritative.
      expect(calls).toBe(1)
      expect(out.results.map(r => r.name)).toEqual([
        'New Thing',
      ])
      expect(out.indexState).toBe('warm')
    },
  )
})
