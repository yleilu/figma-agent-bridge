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
import { recordFeedback } from '@figma-agent-bridge/server/feedback-store'
import { writeCredentials } from '@figma-agent-bridge/server/credential-store'
import {
  handleListFeedback,
  handleSendFeedback,
} from '@figma-agent-bridge/server/tools/feedback-send'

const ok = (body: unknown, status = 200) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
    })) as unknown as typeof fetch

let dir: string
let cred: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fb-'))
  cred = await mkdtemp(join(tmpdir(), 'cred-'))
  process.env.FEEDBACK_DIR = dir
  process.env.CREDENTIALS_DIR = cred
  process.env.FIGMA_BRIDGE_NO_KEYCHAIN = '1'
  process.env.WORKER_URL = 'https://worker.test'
  process.env.WORKER_SECRET = 'sek'
})
afterEach(async () => {
  delete process.env.FEEDBACK_DIR
  delete process.env.CREDENTIALS_DIR
  delete process.env.FIGMA_BRIDGE_NO_KEYCHAIN
  delete process.env.WORKER_URL
  delete process.env.WORKER_SECRET
  await rm(dir, { recursive: true, force: true })
  await rm(cred, { recursive: true, force: true })
})

describe('handleListFeedback', () => {
  it('returns pending items + null identity when unset', async () => {
    await recordFeedback(
      { category: 'bugs', title: 't', description: 'd' },
      '0.0.1',
    )
    const res = await handleListFeedback({})
    const data = JSON.parse(res.content[0].text)
    expect(data.pending).toHaveLength(1)
    expect(data.identity).toBeNull()
  })

  it('returns the remembered identity but never the token', async () => {
    await writeCredentials({
      preference: 'github',
      token: 'gho_x',
      identity: { login: 'lei', email: 'l@e.com' },
    })
    const res = await handleListFeedback({})
    const data = JSON.parse(res.content[0].text)
    expect(data.identity.preference).toBe('github')
    expect(data.identity.login).toBe('lei')
    expect(data.identity.token).toBeUndefined()
  })
})

describe('handleSendFeedback', () => {
  it('anonymous: posts to the Worker and marks sent', async () => {
    const it0 = await recordFeedback(
      { category: 'bugs', title: 't', description: 'd' },
      '0.0.1',
    )
    const res = await handleSendFeedback(
      {
        send: [it0.path],
        discard: [],
        identity: 'anonymous',
      },
      ok({ comment_url: 'https://gh/c/1' }),
    )
    const data = JSON.parse(res.content[0].text)
    expect(data.results[0].status).toBe('sent')
    expect(data.results[0].commentUrl).toBe(
      'https://gh/c/1',
    )
  })

  it('discards unselected items (deletes files)', async () => {
    const keep = await recordFeedback(
      { category: 'bugs', title: 'keep', description: 'd' },
      '0.0.1',
    )
    const drop = await recordFeedback(
      { category: 'bugs', title: 'drop', description: 'd' },
      '0.0.1',
    )
    await handleSendFeedback(
      {
        send: [],
        discard: [drop.path],
        identity: 'anonymous',
      },
      ok({ comment_url: 'x' }),
    )
    const list = JSON.parse(
      (await handleListFeedback({})).content[0].text,
    )
    expect(
      list.pending.map((i: { path: string }) => i.path),
    ).toEqual([keep.path])
  })

  it('add: records a new item and files it', async () => {
    const res = await handleSendFeedback(
      {
        send: [],
        discard: [],
        add: {
          category: 'proposals',
          title: 'user idea',
          description: 'please add X',
        },
        identity: 'anonymous',
      },
      ok({ comment_url: 'https://gh/c/2' }),
    )
    const data = JSON.parse(res.content[0].text)
    expect(data.results[0].status).toBe('sent')
  })

  it('a stale path fails only that item, not the batch', async () => {
    const good = await recordFeedback(
      { category: 'bugs', title: 'good', description: 'd' },
      '0.0.1',
    )
    const res = await handleSendFeedback(
      {
        send: ['bugs/missing.md', good.path],
        discard: [],
        identity: 'anonymous',
      },
      ok({ comment_url: 'https://gh/c/3' }),
    )
    const data = JSON.parse(res.content[0].text)
    expect(data.results).toHaveLength(2)
    const byPath = Object.fromEntries(
      data.results.map(
        (r: { path: string; status: string }) => [
          r.path,
          r.status,
        ],
      ),
    )
    expect(byPath['bugs/missing.md']).toBe('failed')
    expect(byPath[good.path]).toBe('sent')
  })

  it('github 401: clears the token and reports auth-required', async () => {
    await writeCredentials({
      preference: 'github',
      token: 'bad',
      identity: { login: 'lei' },
    })
    const it0 = await recordFeedback(
      { category: 'bugs', title: 't', description: 'd' },
      '0.0.1',
    )
    const res = await handleSendFeedback(
      { send: [it0.path], discard: [] }, // identity defaults to remembered 'github'
      ok({ message: 'Bad credentials' }, 401),
    )
    const data = JSON.parse(res.content[0].text)
    expect(data.results[0].status).toBe('auth-required')
    const { readCredentials } =
      await import('@figma-agent-bridge/server/credential-store')
    expect((await readCredentials()).token).toBeUndefined()
  })
})
