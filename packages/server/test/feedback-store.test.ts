import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { recordFeedback } from '@figma-agent-bridge/server/feedback-store'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fb-')); process.env.FEEDBACK_DIR = dir })
afterEach(async () => { delete process.env.FEEDBACK_DIR; await rm(dir, { recursive: true, force: true }) })

describe('recordFeedback', () => {
  it('writes one markdown file under the category directory with frontmatter + body', async () => {
    const item = await recordFeedback(
      { category: 'bugs', title: 'resize_node no-ops', description: 'nothing changed', tool: 'resize_node' },
      '0.0.1',
    )
    expect(item.category).toBe('bugs')
    expect(item.status).toBe('pending')
    expect(item.version).toBe('0.0.1')
    expect(item.path.startsWith('bugs/')).toBe(true)
    const files = await readdir(join(dir, 'bugs'))
    expect(files).toHaveLength(1)
    const raw = await readFile(join(dir, item.path), 'utf8')
    expect(raw).toContain('title: resize_node no-ops')
    expect(raw).toContain('status: pending')
    expect(raw).toContain('tool: resize_node')
    expect(raw).toContain('nothing changed')
  })
  it('slugifies the title into the filename', async () => {
    const item = await recordFeedback({ category: 'proposals', title: 'Add postOp batch!', description: 'x' }, '0.0.1')
    expect(item.path).toMatch(/^proposals\/.*add-postop-batch\.md$/)
  })
})
