import { describe, it, expect } from 'bun:test'
import { postFeedback } from '@figma-agent-bridge/server/worker-client'

const args = {
  workerUrl: 'https://worker.example.com',
  secret: 's3cret',
  category: 'bugs' as const,
  title: 'A bug',
  body: 'body',
  version: '0.0.1',
}

describe('postFeedback', () => {
  it('POSTs the payload with the secret header and returns the comment url', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(JSON.stringify({ comment_url: 'https://gh/c/1' }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await postFeedback(args, fakeFetch)
    expect(result.commentUrl).toBe('https://gh/c/1')
    expect(captured!.url).toBe('https://worker.example.com')
    expect((captured!.init.headers as Record<string, string>)['x-feedback-secret']).toBe('s3cret')
    expect(JSON.parse(captured!.init.body as string)).toMatchObject({ category: 'bugs', title: 'A bug' })
  })
  it('throws when the worker url is not configured', async () => {
    await expect(postFeedback({ ...args, workerUrl: '' })).rejects.toThrow(/WORKER_URL/)
  })
  it('throws on a non-2xx response', async () => {
    const fakeFetch = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    await expect(postFeedback(args, fakeFetch)).rejects.toThrow(/401/)
  })
  it('throws when comment_url is missing', async () => {
    const fakeFetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    await expect(postFeedback(args, fakeFetch)).rejects.toThrow(/comment_url/)
  })
})
