import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { recordFeedback } from '@figma-agent-bridge/server/feedback-store'
import { buildFeedbackHandlers } from '@figma-agent-bridge/server/feedback-wiring'

const ok = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
const fail = (status: number) =>
  (async () => new Response('no', { status })) as unknown as typeof fetch

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fb-'))
  process.env.FEEDBACK_DIR = dir
  process.env.WORKER_URL = 'https://worker.test'
  process.env.WORKER_SECRET = 'sek'
})
afterEach(async () => {
  delete process.env.FEEDBACK_DIR; delete process.env.WORKER_URL; delete process.env.WORKER_SECRET
  await rm(dir, { recursive: true, force: true })
})

describe('buildFeedbackHandlers', () => {
  it('sync returns the pending items', async () => {
    await recordFeedback({ category: 'bugs', title: 't1', description: 'd' }, '0.0.1')
    const h = buildFeedbackHandlers(() => {}, ok({}))
    const { items } = await h.sync()
    expect(items.map((i) => i.title)).toContain('t1')
  })

  it('send posts to the worker, marks sent, and notifies feedback-updated', async () => {
    const item = await recordFeedback({ category: 'bugs', title: 't2', description: 'd' }, '0.0.1')
    const notes: { command: string; params: any }[] = []
    const h = buildFeedbackHandlers((command, params) => notes.push({ command, params }), ok({ comment_url: 'https://gh/c/1' }))
    const res = await h.send({ path: item.path })
    expect(res.item.status).toBe('sent')
    expect(res.item.commentUrl).toBe('https://gh/c/1')
    expect(notes[0].command).toBe('feedback-updated')
    expect(notes[0].params.item.status).toBe('sent')
  })

  it('send marks failed and notifies when the worker errors', async () => {
    const item = await recordFeedback({ category: 'bugs', title: 't3', description: 'd' }, '0.0.1')
    const notes: { command: string; params: any }[] = []
    const h = buildFeedbackHandlers((command, params) => notes.push({ command, params }), fail(500))
    await expect(h.send({ path: item.path })).rejects.toThrow()
    expect(notes[0].command).toBe('feedback-updated')
    expect(notes[0].params.item.status).toBe('failed')
  })

  it('send is idempotent for an already-sent item', async () => {
    const item = await recordFeedback({ category: 'bugs', title: 't4', description: 'd' }, '0.0.1')
    const h = buildFeedbackHandlers(() => {}, ok({ comment_url: 'https://gh/c/2' }))
    await h.send({ path: item.path })
    const again = await h.send({ path: item.path })
    expect(again.item.status).toBe('sent')
  })
})
