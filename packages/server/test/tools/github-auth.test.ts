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
import { readCredentials } from '@figma-agent-bridge/server/credential-store'
import {
  handleGithubAuthStart,
  handleGithubAuthPoll,
  __resetPendingAuth,
} from '@figma-agent-bridge/server/tools/github-auth'

const seq = (...responses: unknown[]) => {
  let i = 0
  return (async () => {
    const body =
      responses[Math.min(i, responses.length - 1)]
    i += 1
    return new Response(JSON.stringify(body), {
      status: 200,
    })
  }) as unknown as typeof fetch
}
const noSleep = async () => {}

let cred: string
beforeEach(async () => {
  cred = await mkdtemp(join(tmpdir(), 'cred-'))
  process.env.CREDENTIALS_DIR = cred
  process.env.FIGMA_BRIDGE_NO_KEYCHAIN = '1'
  __resetPendingAuth()
})
afterEach(async () => {
  delete process.env.CREDENTIALS_DIR
  delete process.env.FIGMA_BRIDGE_NO_KEYCHAIN
  await rm(cred, { recursive: true, force: true })
})

describe('handleGithubAuthStart', () => {
  it('errors when no client id is configured', async () => {
    const res = await handleGithubAuthStart(
      '',
      'repo',
      seq({}),
    )
    expect(res.content[0].text).toContain('not configured')
  })

  it('returns the user code + verification uri', async () => {
    const res = await handleGithubAuthStart(
      'cid',
      'repo',
      seq({
        device_code: 'dc',
        user_code: 'WDJB-MJHT',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      }),
    )
    const data = JSON.parse(res.content[0].text)
    expect(data.user_code).toBe('WDJB-MJHT')
    expect(data.verification_uri).toContain(
      'github.com/login/device',
    )
  })
})

describe('handleGithubAuthPoll', () => {
  it('reports no login in progress', async () => {
    const res = await handleGithubAuthPoll(seq({}), noSleep)
    expect(JSON.parse(res.content[0].text).status).toBe(
      'error',
    )
  })

  it('authorizes and stores the identity', async () => {
    await handleGithubAuthStart(
      'cid',
      'repo',
      seq({
        device_code: 'dc',
        user_code: 'U',
        verification_uri: 'v',
        expires_in: 900,
        interval: 0,
      }),
    )
    const res = await handleGithubAuthPoll(
      seq(
        { error: 'authorization_pending' },
        { access_token: 'gho_1' },
        {
          login: 'lei',
          name: 'Lei',
          email: 'l@e.com',
          id: 7,
        },
      ),
      noSleep,
    )
    const data = JSON.parse(res.content[0].text)
    expect(data.status).toBe('authorized')
    expect(data.identity.login).toBe('lei')
    const c = await readCredentials()
    expect(c.token).toBe('gho_1')
    expect(c.preference).toBe('github')
  })

  it('reports denial', async () => {
    await handleGithubAuthStart(
      'cid',
      'repo',
      seq({
        device_code: 'dc',
        user_code: 'U',
        verification_uri: 'v',
        expires_in: 900,
        interval: 0,
      }),
    )
    const res = await handleGithubAuthPoll(
      seq({ error: 'access_denied' }),
      noSleep,
    )
    expect(JSON.parse(res.content[0].text).status).toBe(
      'denied',
    )
  })
})
