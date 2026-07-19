import {
  chmod,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type IdentityPreference = 'anonymous' | 'github'

export interface StoredIdentity {
  login: string
  name?: string
  email?: string
}

export interface Credentials {
  preference?: IdentityPreference
  token?: string
  identity?: StoredIdentity
}

const SERVICE = 'figma-agent-bridge'
const SECRET_NAME = 'credentials'

type Secrets = {
  get(o: {
    service: string
    name: string
  }): Promise<string | null>
  set(o: {
    service: string
    name: string
    value: string
  }): Promise<void>
  delete(o: {
    service: string
    name: string
  }): Promise<boolean>
}

// test seam: inject a fake keychain to exercise the Bun.secrets branch
let secretsOverride: Secrets | null = null
export const setSecretsForTest = (
  s: Secrets | null,
): void => {
  secretsOverride = s
}

const credentialsFile = (): string =>
  join(
    process.env.CREDENTIALS_DIR ??
      join(homedir(), '.figma-agent-bridge'),
    'credentials.json',
  )

// Bun.secrets is experimental + v1.2.21+; feature-detect and
// fall back to a 0600 file.
const useKeychain = (): boolean => {
  if (process.env.FIGMA_BRIDGE_NO_KEYCHAIN) {
    return false
  }
  if (secretsOverride !== null) {
    return true
  }
  if (typeof Bun === 'undefined') {
    return false
  }
  const bunSecrets = (
    Bun as unknown as { secrets?: unknown }
  ).secrets
  return bunSecrets !== null && bunSecrets !== undefined
}

const secrets = (): Secrets =>
  secretsOverride ??
  (Bun as unknown as { secrets: Secrets }).secrets

export const readCredentials =
  async (): Promise<Credentials> => {
    let raw: string | null = null
    if (useKeychain()) {
      raw = await secrets().get({
        service: SERVICE,
        name: SECRET_NAME,
      })
    } else {
      try {
        raw = await readFile(credentialsFile(), 'utf8')
      } catch {
        raw = null
      }
    }
    if (!raw) {
      return {}
    }
    try {
      return JSON.parse(raw) as Credentials
    } catch {
      return {}
    }
  }

export const writeCredentials = async (
  c: Credentials,
): Promise<void> => {
  const value = JSON.stringify(c)
  if (useKeychain()) {
    await secrets().set({
      service: SERVICE,
      name: SECRET_NAME,
      value,
    })
    return
  }
  const file = credentialsFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, value, { mode: 0o600 })
  if (process.platform !== 'win32') {
    await chmod(file, 0o600)
  }
}

export const setToken = async (
  token: string,
  identity: StoredIdentity,
): Promise<void> => {
  const c = await readCredentials()
  await writeCredentials({
    ...c,
    preference: 'github',
    token,
    identity,
  })
}

export const clearToken = async (): Promise<void> => {
  const c = await readCredentials()
  await writeCredentials({ preference: c.preference })
}

export const setPreference = async (
  preference: IdentityPreference,
): Promise<void> => {
  const c = await readCredentials()
  await writeCredentials({ ...c, preference })
}
