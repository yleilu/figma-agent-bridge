import { describe, it, expect } from 'bun:test'
import {
  startDeviceAuth,
  pollDeviceAuth,
  fetchIdentity,
  createSubIssue,
} from '@figma-agent-bridge/server/github-client'

const jsonFetch = (
  status: number,
  body: unknown,
): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
    })) as unknown as typeof fetch

const seq = (
  ...steps: { status: number; body: unknown }[]
): typeof fetch => {
  let i = 0
  return (async () => {
    const s = steps[Math.min(i, steps.length - 1)]
    i += 1
    return new Response(JSON.stringify(s.body), {
      status: s.status,
    })
  }) as unknown as typeof fetch
}

// Like `seq`, but records each call's url + JSON-parsed body so
// tests can assert exactly what was sent to each endpoint.
const recordingSeq = (
  calls: { url: string; body: unknown }[],
  ...steps: { status: number; body: unknown }[]
): typeof fetch => {
  let i = 0
  return (async (url: string, init?: { body?: string }) => {
    calls.push({
      url,
      body: init?.body ? JSON.parse(init.body) : undefined,
    })
    const s = steps[Math.min(i, steps.length - 1)]
    i += 1
    return new Response(JSON.stringify(s.body), {
      status: s.status,
    })
  }) as unknown as typeof fetch
}

describe('startDeviceAuth', () => {
  it('parses the device-code response', async () => {
    const r = await startDeviceAuth(
      'cid',
      'repo',
      jsonFetch(200, {
        device_code: 'dc',
        user_code: 'WDJB-MJHT',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      }),
    )
    expect(r.deviceCode).toBe('dc')
    expect(r.userCode).toBe('WDJB-MJHT')
    expect(r.interval).toBe(5)
  })
})

describe('pollDeviceAuth', () => {
  it('returns authorized with the token', async () => {
    const r = await pollDeviceAuth(
      'cid',
      'dc',
      jsonFetch(200, { access_token: 'gho_1' }),
    )
    expect(r.status).toBe('authorized')
    expect(r.accessToken).toBe('gho_1')
  })
  it('maps authorization_pending', async () => {
    const r = await pollDeviceAuth(
      'cid',
      'dc',
      jsonFetch(200, { error: 'authorization_pending' }),
    )
    expect(r.status).toBe('pending')
  })
  it('maps slow_down + new interval', async () => {
    const r = await pollDeviceAuth(
      'cid',
      'dc',
      jsonFetch(200, { error: 'slow_down', interval: 10 }),
    )
    expect(r.status).toBe('slow_down')
    expect(r.interval).toBe(10)
  })
  it('maps access_denied and expired_token', async () => {
    expect(
      (
        await pollDeviceAuth(
          'cid',
          'dc',
          jsonFetch(200, { error: 'access_denied' }),
        )
      ).status,
    ).toBe('denied')
    expect(
      (
        await pollDeviceAuth(
          'cid',
          'dc',
          jsonFetch(200, { error: 'expired_token' }),
        )
      ).status,
    ).toBe('expired')
  })
})

describe('fetchIdentity', () => {
  it('uses the public email when present', async () => {
    const id = await fetchIdentity(
      'gho_1',
      jsonFetch(200, {
        login: 'lei',
        name: 'Lei',
        email: 'l@example.com',
        id: 42,
      }),
    )
    expect(id).toEqual({
      login: 'lei',
      name: 'Lei',
      email: 'l@example.com',
    })
  })
  it('falls back to the noreply address when email is null', async () => {
    const id = await fetchIdentity(
      'gho_1',
      jsonFetch(200, {
        login: 'lei',
        name: null,
        email: null,
        id: 42,
      }),
    )
    expect(id.email).toBe('42+lei@users.noreply.github.com')
    expect(id.name).toBeUndefined()
  })
})

describe('createSubIssue', () => {
  it('creates the issue then links it, returning the sub-issue url', async () => {
    const calls: { url: string; body: unknown }[] = []
    const r = await createSubIssue(
      {
        repo: 'o/r',
        parentIssueNumber: 2,
        title: 't',
        body: 'b',
        token: 'gho_1',
      },
      recordingSeq(
        calls,
        {
          status: 201,
          body: {
            id: 555,
            html_url: 'https://gh/issues/9',
          },
        },
        { status: 201, body: {} },
      ),
    )
    expect(r).toEqual({
      url: 'https://gh/issues/9',
      linked: true,
    })
    expect(calls).toHaveLength(2)
    // the sub-issue link must use the created issue's REST `id`
    // (555), NOT its `number` — that's the gotcha this guards.
    expect(
      calls[1].url.endsWith('/issues/2/sub_issues'),
    ).toBe(true)
    expect(calls[1].body).toEqual({ sub_issue_id: 555 })
  })
  it('throws auth on a 401 at issue creation', async () => {
    await expect(
      createSubIssue(
        {
          repo: 'o/r',
          parentIssueNumber: 2,
          title: 't',
          body: 'b',
          token: 'bad',
        },
        seq({
          status: 401,
          body: { message: 'Bad credentials' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'auth' })
  })
  it('throws access on a 404 at issue creation', async () => {
    await expect(
      createSubIssue(
        {
          repo: 'o/r',
          parentIssueNumber: 2,
          title: 't',
          body: 'b',
          token: 'gho_1',
        },
        seq({
          status: 404,
          body: { message: 'Not Found' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'access' })
  })
  it('does not throw on a 403 at the link step — surfaces the created url instead', async () => {
    const r = await createSubIssue(
      {
        repo: 'o/r',
        parentIssueNumber: 2,
        title: 't',
        body: 'b',
        token: 'gho_1',
      },
      seq(
        {
          status: 201,
          body: {
            id: 1,
            html_url: 'https://gh/issues/1',
          },
        },
        { status: 403, body: {} },
      ),
    )
    expect(r).toEqual({
      url: 'https://gh/issues/1',
      linked: false,
    })
  })
})
