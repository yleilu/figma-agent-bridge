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
import {
  readCredentials,
  writeCredentials,
  setToken,
  clearToken,
  setPreference,
  setSecretsForTest,
} from '@figma-agent-bridge/server/credential-store'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cred-'))
  process.env.CREDENTIALS_DIR = dir
  process.env.FIGMA_BRIDGE_NO_KEYCHAIN = '1'
})
afterEach(async () => {
  setSecretsForTest(null)
  delete process.env.CREDENTIALS_DIR
  delete process.env.FIGMA_BRIDGE_NO_KEYCHAIN
  await rm(dir, { recursive: true, force: true })
})

describe('credential-store (file backend)', () => {
  it('returns empty credentials when nothing is stored', async () => {
    expect(await readCredentials()).toEqual({})
  })

  it('round-trips a full credential blob', async () => {
    await writeCredentials({
      preference: 'github',
      token: 'gho_x',
      identity: { login: 'lei', name: 'Lei' },
    })
    const c = await readCredentials()
    expect(c.preference).toBe('github')
    expect(c.token).toBe('gho_x')
    expect(c.identity?.login).toBe('lei')
  })

  it('setToken stores token + identity + preference=github', async () => {
    await setToken('gho_y', { login: 'lei' })
    const c = await readCredentials()
    expect(c.token).toBe('gho_y')
    expect(c.preference).toBe('github')
    expect(c.identity?.login).toBe('lei')
  })

  it('clearToken removes the token but keeps the preference', async () => {
    await setToken('gho_y', { login: 'lei' })
    await clearToken()
    const c = await readCredentials()
    expect(c.token).toBeUndefined()
    expect(c.identity).toBeUndefined()
    expect(c.preference).toBe('github')
  })

  it('setPreference records anonymous without a token', async () => {
    await setPreference('anonymous')
    expect((await readCredentials()).preference).toBe(
      'anonymous',
    )
  })
})

describe('credential-store (keychain backend, feature-detected)', () => {
  it('reads/writes through the injected keychain, not the file', async () => {
    // turn OFF the file-forcing flag so the feature-detect picks
    // up the injected keychain
    delete process.env.FIGMA_BRIDGE_NO_KEYCHAIN
    const kc = new Map<string, string>()
    setSecretsForTest({
      get: async ({ service, name }) =>
        kc.get(`${service}:${name}`) ?? null,
      set: async ({ service, name, value }) => {
        kc.set(`${service}:${name}`, value)
      },
      delete: async ({ service, name }) =>
        kc.delete(`${service}:${name}`),
    })
    await writeCredentials({
      preference: 'github',
      token: 'gho_k',
      identity: { login: 'lei' },
    })
    expect(kc.size).toBe(1) // went to the keychain, not the file
    const c = await readCredentials()
    expect(c.token).toBe('gho_k')
  })
})
