import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'bun:test'
import {
  mkdtemp,
  rm,
  readFile,
  readdir,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  recordFeedback,
  readItem,
  listPending,
  markSent,
  markFailed,
  discard,
} from '@figma-agent-bridge/server/feedback-store'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fb-'))
  process.env.FEEDBACK_DIR = dir
})
afterEach(async () => {
  delete process.env.FEEDBACK_DIR
  await rm(dir, { recursive: true, force: true })
})

describe('recordFeedback', () => {
  it('writes one markdown file under the category directory with frontmatter + body', async () => {
    const item = await recordFeedback(
      {
        category: 'bugs',
        title: 'resize_node no-ops',
        description: 'nothing changed',
        tool: 'resize_node',
      },
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
    const item = await recordFeedback(
      {
        category: 'proposals',
        title: 'Add postOp batch!',
        description: 'x',
      },
      '0.0.1',
    )
    expect(item.path).toMatch(
      /^proposals\/.*add-postop-batch\.md$/,
    )
  })
})

describe('read / list / mark', () => {
  it('round-trips an item via readItem', async () => {
    const written = await recordFeedback(
      {
        category: 'bugs',
        title: 'A bug',
        description: 'body text',
      },
      '0.0.1',
    )
    const read = await readItem(written.path)
    expect(read.title).toBe('A bug')
    expect(read.description).toBe('body text')
    expect(read.status).toBe('pending')
    expect(read.path).toBe(written.path)
  })
  it('lists only pending items, newest first, bounded by limit', async () => {
    const a = await recordFeedback(
      {
        category: 'bugs',
        title: 'first',
        description: 'x',
      },
      '0.0.1',
    )
    await recordFeedback(
      {
        category: 'proposals',
        title: 'second',
        description: 'y',
      },
      '0.0.1',
    )
    await markSent(a.path, 'https://example.com/c/1')
    const pending = await listPending({ limit: 10 })
    expect(pending.items.map(i => i.title)).toEqual([
      'second',
    ])
    const capped = await listPending({ limit: 1 })
    expect(capped.items).toHaveLength(1)
  })
  it('markSent flips status and records the comment url', async () => {
    const item = await recordFeedback(
      { category: 'bugs', title: 'b', description: 'x' },
      '0.0.1',
    )
    const sent = await markSent(
      item.path,
      'https://example.com/c/42',
    )
    expect(sent.status).toBe('sent')
    expect(sent.commentUrl).toBe('https://example.com/c/42')
    expect(sent.sentAt).toBeDefined()
    const reread = await readItem(item.path)
    expect(reread.status).toBe('sent')
    expect(reread.commentUrl).toBe(
      'https://example.com/c/42',
    )
  })
  it('markFailed flips status to failed', async () => {
    const item = await recordFeedback(
      { category: 'bugs', title: 'c', description: 'x' },
      '0.0.1',
    )
    const failed = await markFailed(item.path)
    expect(failed.status).toBe('failed')
    const reread = await readItem(item.path)
    expect(reread.status).toBe('failed')
  })
})

describe('listPending pagination', () => {
  it('pages pending items newest-first with an opaque cursor', async () => {
    for (const t of ['a', 'b', 'c']) {
      await recordFeedback(
        { category: 'bugs', title: t, description: 'd' },
        '0.0.1',
      )
    }
    const p1 = await listPending({ limit: 2 })
    expect(p1.items).toHaveLength(2)
    expect(p1.truncated).toBe(true)
    expect(typeof p1.cursor).toBe('string')

    const p2 = await listPending({
      limit: 2,
      cursor: p1.cursor,
    })
    expect(p2.items).toHaveLength(1)
    expect(p2.truncated).toBe(false)
    expect(p2.cursor).toBeUndefined()

    const seen = [...p1.items, ...p2.items].map(
      i => i.title,
    )
    expect(new Set(seen).size).toBe(3)
  })

  it('excludes sent items', async () => {
    const it0 = await recordFeedback(
      { category: 'bugs', title: 'x', description: 'd' },
      '0.0.1',
    )
    await markSent(it0.path, 'https://gh/c/1')
    const page = await listPending({ limit: 10 })
    expect(page.items).toHaveLength(0)
  })
})

describe('discard', () => {
  it('deletes the item file', async () => {
    const it0 = await recordFeedback(
      { category: 'bugs', title: 'gone', description: 'd' },
      '0.0.1',
    )
    await discard(it0.path)
    const page = await listPending({ limit: 10 })
    expect(page.items).toHaveLength(0)
  })

  it('throws if the file is missing', async () => {
    await expect(
      discard('bugs/does-not-exist.md'),
    ).rejects.toThrow()
  })
})
