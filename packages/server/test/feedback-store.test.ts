import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { recordFeedback, readItem, listPending, markSent, markFailed } from '@figma-agent-bridge/server/feedback-store'

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

describe('read / list / mark', () => {
  it('round-trips an item via readItem', async () => {
    const written = await recordFeedback({ category: 'bugs', title: 'A bug', description: 'body text' }, '0.0.1')
    const read = await readItem(written.path)
    expect(read.title).toBe('A bug')
    expect(read.description).toBe('body text')
    expect(read.status).toBe('pending')
    expect(read.path).toBe(written.path)
  })
  it('lists only pending items, newest first, bounded by limit', async () => {
    const a = await recordFeedback({ category: 'bugs', title: 'first', description: 'x' }, '0.0.1')
    await recordFeedback({ category: 'proposals', title: 'second', description: 'y' }, '0.0.1')
    await markSent(a.path, 'https://example.com/c/1')
    const pending = await listPending(10)
    expect(pending.map(i => i.title)).toEqual(['second'])
    const capped = await listPending(1)
    expect(capped).toHaveLength(1)
  })
  it('markSent flips status and records the comment url', async () => {
    const item = await recordFeedback({ category: 'bugs', title: 'b', description: 'x' }, '0.0.1')
    const sent = await markSent(item.path, 'https://example.com/c/42')
    expect(sent.status).toBe('sent')
    expect(sent.commentUrl).toBe('https://example.com/c/42')
    expect(sent.sentAt).toBeDefined()
    const reread = await readItem(item.path)
    expect(reread.status).toBe('sent')
    expect(reread.commentUrl).toBe('https://example.com/c/42')
  })
  it('markFailed flips status to failed', async () => {
    const item = await recordFeedback({ category: 'bugs', title: 'c', description: 'x' }, '0.0.1')
    const failed = await markFailed(item.path)
    expect(failed.status).toBe('failed')
    const reread = await readItem(item.path)
    expect(reread.status).toBe('failed')
  })
})
