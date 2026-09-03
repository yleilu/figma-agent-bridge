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
import {
  saveIndex,
  loadCachedIndex,
} from '@figma-agent-bridge/server/component-index/store'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ci-'))
  process.env.COMPONENT_INDEX_DIR = dir
})
afterEach(async () => {
  delete process.env.COMPONENT_INDEX_DIR
  await rm(dir, { recursive: true, force: true })
})

describe('store round-trip', () => {
  it('saves then loads when the version matches', async () => {
    await saveIndex('file-a', {
      version: 'v1',
      serialized: '{"x":1}',
    })
    const loaded = await loadCachedIndex('file-a', 'v1')
    expect(loaded).toBe('{"x":1}')
  })
  it('returns null when the version differs (stale)', async () => {
    await saveIndex('file-a', {
      version: 'v1',
      serialized: '{"x":1}',
    })
    expect(await loadCachedIndex('file-a', 'v2')).toBeNull()
  })
  it('returns null for an unknown file', async () => {
    expect(
      await loadCachedIndex('missing', 'v1'),
    ).toBeNull()
  })
})
