import { describe, it, expect } from 'bun:test'
import {
  startDeviceAuth,
  pollDeviceAuth,
  fetchIdentity,
  postIssueComment,
} from '@figma-agent-bridge/server/github-client'

const jsonFetch = (
  status: number,
  body: unknown,
): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
    })) as unknown as typeof fetch

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

describe('postIssueComment', () => {
  it('posts a comment and returns its html_url', async () => {
    const r = await postIssueComment(
      {
        repo: 'o/r',
        issueNumber: 2,
        body: 'hi',
        token: 'gho_1',
      },
      jsonFetch(201, { html_url: 'https://gh/c/9' }),
    )
    expect(r.commentUrl).toBe('https://gh/c/9')
  })
  it('throws auth on 401', async () => {
    await expect(
      postIssueComment(
        {
          repo: 'o/r',
          issueNumber: 2,
          body: 'hi',
          token: 'bad',
        },
        jsonFetch(401, { message: 'Bad credentials' }),
      ),
    ).rejects.toMatchObject({ code: 'auth' })
  })
  it('throws access on 404', async () => {
    await expect(
      postIssueComment(
        {
          repo: 'o/r',
          issueNumber: 2,
          body: 'hi',
          token: 'gho_1',
        },
        jsonFetch(404, { message: 'Not Found' }),
      ),
    ).rejects.toMatchObject({ code: 'access' })
  })
})
