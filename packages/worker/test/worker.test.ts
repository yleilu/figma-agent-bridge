import { describe, it, expect } from 'bun:test'
import { handle, composeBody } from '../src/index'

const env = {
  GITHUB_TOKEN: 'tok',
  SHARED_SECRET: 'sek',
  REPO: 'owner/repo',
  BUGS_ISSUE: '10',
  PROPOSALS_ISSUE: '11',
}

const req = (body: unknown, secret = 'sek') =>
  new Request('https://w', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-feedback-secret': secret,
    },
    body: JSON.stringify(body),
  })

describe('worker', () => {
  it('composes a comment body with title, body, and version', () => {
    expect(composeBody('T', 'B', '0.0.1')).toContain('T')
    expect(composeBody('T', 'B', '0.0.1')).toContain(
      '0.0.1',
    )
  })
  it('rejects a bad secret with 401', async () => {
    const res = await handle(
      req(
        {
          category: 'bugs',
          title: 't',
          body: 'b',
          version: 'v',
        },
        'wrong',
      ),
      env,
    )
    expect(res.status).toBe(401)
  })
  it('rejects an unknown category with 400', async () => {
    const res = await handle(
      req({
        category: 'wishlist',
        title: 't',
        body: 'b',
        version: 'v',
      }),
      env,
    )
    expect(res.status).toBe(400)
  })
  it('maps bugs → BUGS_ISSUE and returns the github comment url', async () => {
    let ghUrl = ''
    const fakeFetch = (async (url: string) => {
      ghUrl = url
      return new Response(
        JSON.stringify({ html_url: 'https://gh/c/5' }),
        { status: 201 },
      )
    }) as unknown as typeof fetch
    const res = await handle(
      req({
        category: 'bugs',
        title: 't',
        body: 'b',
        version: '0.0.1',
      }),
      env,
      fakeFetch,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      comment_url: 'https://gh/c/5',
    })
    expect(ghUrl).toBe(
      'https://api.github.com/repos/owner/repo/issues/10/comments',
    )
  })
  it('returns 502 when GitHub errors', async () => {
    const fakeFetch = (async () =>
      new Response('no', {
        status: 403,
      })) as unknown as typeof fetch
    const res = await handle(
      req({
        category: 'bugs',
        title: 't',
        body: 'b',
        version: 'v',
      }),
      env,
      fakeFetch,
    )
    expect(res.status).toBe(502)
  })
})
