import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
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
    // On macOS, /proc doesn't exist, so mkdir will fail with ENOENT
    process.env.FEEDBACK_DIR =
      '/proc/nonexistent/cannot-write'
    const result = await handleRecordFeedback(
      { category: 'bugs', title: 'x', description: 'y' },
      '0.0.1',
    )
    expect(result.content[0].text).toContain('Error')
  })
})
