import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleRecordFeedback } from '@figma-agent-bridge/server/tools/feedback'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fb-'))
  process.env.FEEDBACK_DIR = dir
})
afterEach(async () => {
  delete process.env.FEEDBACK_DIR
  await rm(dir, { recursive: true, force: true })
})

describe('handleRecordFeedback', () => {
  it('records the item', async () => {
    const result = await handleRecordFeedback(
      { category: 'bugs', title: 'x', description: 'y' },
      '0.0.1',
    )
    expect(result.content[0].text).toContain('Recorded')
  })

  it('returns an error result if the write fails', async () => {
    // A regular file as the parent makes mkdir fail with
    // ENOTDIR on every OS. (/proc/... answered EROFS on a
    // read-only macOS root and something else on Linux.)
    const parent = join(dir, 'not-a-dir')
    await writeFile(parent, '')
    process.env.FEEDBACK_DIR = join(parent, 'cannot-write')
    const result = await handleRecordFeedback(
      { category: 'bugs', title: 'x', description: 'y' },
      '0.0.1',
    )
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.error).toContain('ENOTDIR')
    expect(data.code).toBe('PLUGIN_ERROR')
  })
})
