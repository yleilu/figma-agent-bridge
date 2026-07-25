import { describe, it, expect } from 'bun:test'
import { handle, composeBody } from '../src/index'

const limiter = (success = true) => ({
  limit: async () => ({ success }),
})

const env = {
  GITHUB_TOKEN: 'tok',
  REPO: 'owner/repo',
  BUGS_ISSUE: '10',
  PROPOSALS_ISSUE: '11',
  FEEDBACK_LIMITER: limiter(),
}

const req = (body: unknown, ip = '203.0.113.7') =>
  new Request('https://w', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': ip,
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
  it('files a comment for an uncredentialed request', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ html_url: 'https://gh/c/9' }),
        { status: 201 },
      )) as unknown as typeof fetch
    // no credential of any kind: content-type only
    const request = new Request('https://w', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        category: 'bugs',
        title: 't',
        body: 'b',
        version: 'v',
      }),
    })
    const res = await handle(request, env, fakeFetch)
    expect(res.status).toBe(200)
  })
  it('keys the rate limit on CF-Connecting-IP', async () => {
    const keys: string[] = []
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ html_url: 'https://gh/c/9' }),
        { status: 201 },
      )) as unknown as typeof fetch
    await handle(
      req(
        {
          category: 'bugs',
          title: 't',
          body: 'b',
          version: 'v',
        },
        '198.51.100.4',
      ),
      {
        ...env,
        FEEDBACK_LIMITER: {
          limit: async (o: { key: string }) => {
            keys.push(o.key)
            return { success: true }
          },
        },
      },
      fakeFetch,
    )
    expect(keys).toEqual(['198.51.100.4'])
  })
  it('returns 429 and calls GitHub zero times when refused', async () => {
    let calls = 0
    const fakeFetch = (async () => {
      calls += 1
      return new Response('{}', { status: 201 })
    }) as unknown as typeof fetch
    const res = await handle(
      req({
        category: 'bugs',
        title: 't',
        body: 'b',
        version: 'v',
      }),
      { ...env, FEEDBACK_LIMITER: limiter(false) },
      fakeFetch,
    )
    expect(res.status).toBe(429)
    expect(calls).toBe(0)
    expect(await res.text()).toMatch(/try again/i)
  })
  it('refuses the over-limit key with 429 while another key is filed', async () => {
    let calls = 0
    const fakeFetch = (async () => {
      calls += 1
      return new Response(
        JSON.stringify({ html_url: 'https://gh/c/9' }),
        { status: 201 },
      )
    }) as unknown as typeof fetch
    const perKey = {
      ...env,
      FEEDBACK_LIMITER: {
        limit: async (o: { key: string }) => ({
          success: o.key !== '203.0.113.7',
        }),
      },
    }
    const item = {
      category: 'bugs',
      title: 't',
      body: 'b',
      version: 'v',
    }
    const refused = await handle(
      req(item, '203.0.113.7'),
      perKey,
      fakeFetch,
    )
    const allowed = await handle(
      req(item, '198.51.100.4'),
      perKey,
      fakeFetch,
    )
    expect(refused.status).toBe(429)
    expect(allowed.status).toBe(200)
    expect(calls).toBe(1)
  })
  it('fails closed with 503 when the limiter throws', async () => {
    let calls = 0
    const fakeFetch = (async () => {
      calls += 1
      return new Response('{}', { status: 201 })
    }) as unknown as typeof fetch
    const res = await handle(
      req({
        category: 'bugs',
        title: 't',
        body: 'b',
        version: 'v',
      }),
      {
        ...env,
        FEEDBACK_LIMITER: {
          limit: async () => {
            throw new Error('limiter down')
          },
        },
      },
      fakeFetch,
    )
    expect(res.status).toBe(503)
    expect(calls).toBe(0)
    expect(await res.text()).toMatch(/gate unavailable/i)
  })
  it('fails closed with 503 when the limiter binding is missing', async () => {
    const { FEEDBACK_LIMITER, ...unbound } = env
    const res = await handle(
      req({
        category: 'bugs',
        title: 't',
        body: 'b',
        version: 'v',
      }),
      unbound as typeof env,
    )
    expect(res.status).toBe(503)
  })
  it('rejects a malformed body with 400 and no GitHub call', async () => {
    let calls = 0
    const fakeFetch = (async () => {
      calls += 1
      return new Response('{}', { status: 201 })
    }) as unknown as typeof fetch
    const bad = new Request('https://w', {
      method: 'POST',
      body: 'not json{',
    })
    const res = await handle(bad, env, fakeFetch)
    expect(res.status).toBe(400)
    expect(calls).toBe(0)
    const nulled = await handle(
      new Request('https://w', {
        method: 'POST',
        body: 'null',
      }),
      env,
      fakeFetch,
    )
    expect(nulled.status).toBe(400)
    expect(calls).toBe(0)
  })
  it('rejects missing or non-string fields with 400 and no GitHub call', async () => {
    let calls = 0
    const fakeFetch = (async () => {
      calls += 1
      return new Response('{}', { status: 201 })
    }) as unknown as typeof fetch
    const bare = await handle(
      req({ category: 'bugs' }),
      env,
      fakeFetch,
    )
    expect(bare.status).toBe(400)
    const objectTitle = await handle(
      req({
        category: 'bugs',
        title: {},
        body: 'b',
        version: 'v',
      }),
      env,
      fakeFetch,
    )
    expect(objectTitle.status).toBe(400)
    const blank = await handle(
      req({
        category: 'bugs',
        title: '   ',
        body: 'b',
        version: 'v',
      }),
      env,
      fakeFetch,
    )
    expect(blank.status).toBe(400)
    expect(calls).toBe(0)
  })
  it('defaults a missing version rather than stamping undefined', async () => {
    let sent = ''
    const fakeFetch = (async (
      _url: string,
      init: { body: string },
    ) => {
      sent = JSON.parse(init.body).body
      return new Response(
        JSON.stringify({ html_url: 'https://gh/c/9' }),
        { status: 201 },
      )
    }) as unknown as typeof fetch
    const res = await handle(
      req({ category: 'bugs', title: 't', body: 'b' }),
      env,
      fakeFetch,
    )
    expect(res.status).toBe(200)
    expect(sent).toContain('unknown')
    expect(sent).not.toContain('undefined')
  })
  it('rejects an oversized payload with 413 and no GitHub call', async () => {
    let calls = 0
    const fakeFetch = (async () => {
      calls += 1
      return new Response('{}', { status: 201 })
    }) as unknown as typeof fetch
    const res = await handle(
      req({
        category: 'bugs',
        title: 't',
        body: 'x'.repeat(20_000),
        version: 'v',
      }),
      env,
      fakeFetch,
    )
    expect(res.status).toBe(413)
    expect(calls).toBe(0)
  })
})
