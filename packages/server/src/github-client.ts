import type { StoredIdentity } from './credential-store'

const DEVICE_CODE_URL =
  'https://github.com/login/device/code'
const TOKEN_URL =
  'https://github.com/login/oauth/access_token'
const API = 'https://api.github.com'
const UA = 'figma-agent-bridge'

export class GithubError extends Error {
  code: 'auth' | 'access' | 'http'
  constructor(
    code: 'auth' | 'access' | 'http',
    message: string,
  ) {
    super(message)
    this.code = code
  }
}

export interface DeviceAuth {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export const startDeviceAuth = async (
  clientId: string,
  scope: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceAuth> => {
  const res = await fetchImpl(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ client_id: clientId, scope }),
  })
  if (!res.ok) {
    throw new GithubError(
      'http',
      `device/code responded ${res.status}`,
    )
  }
  const d = (await res.json()) as {
    device_code: string
    user_code: string
    verification_uri: string
    expires_in: number
    interval: number
  }
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    expiresIn: d.expires_in,
    interval: d.interval,
  }
}

export type PollStatus =
  | 'authorized'
  | 'pending'
  | 'slow_down'
  | 'expired'
  | 'denied'

export interface PollResult {
  status: PollStatus
  accessToken?: string
  interval?: number
}

export const pollDeviceAuth = async (
  clientId: string,
  deviceCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PollResult> => {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type:
        'urn:ietf:params:oauth:grant-type:device_code',
    }),
  })
  const d = (await res.json()) as {
    access_token?: string
    error?: string
    interval?: number
  }
  if (d.access_token) {
    return {
      status: 'authorized',
      accessToken: d.access_token,
    }
  }
  switch (d.error) {
    case 'authorization_pending':
      return { status: 'pending' }
    case 'slow_down':
      return { status: 'slow_down', interval: d.interval }
    case 'access_denied':
      return { status: 'denied' }
    case 'expired_token':
      return { status: 'expired' }
    default:
      throw new GithubError(
        'http',
        `token endpoint error: ${d.error ?? 'unknown'}`,
      )
  }
}

export const fetchIdentity = async (
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredIdentity> => {
  const res = await fetchImpl(`${API}/user`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': UA,
    },
  })
  if (!res.ok) {
    throw new GithubError(
      res.status === 401 ? 'auth' : 'http',
      `GET /user responded ${res.status}`,
    )
  }
  const u = (await res.json()) as {
    login: string
    name: string | null
    email: string | null
    id: number
  }
  const email =
    u.email ?? `${u.id}+${u.login}@users.noreply.github.com`
  return {
    login: u.login,
    ...(u.name ? { name: u.name } : {}),
    email,
  }
}

// Shared GitHub write helper: maps status → typed GithubError, returns parsed JSON.
const ghSend = async (
  fetchImpl: typeof fetch,
  method: string,
  url: string,
  token: string,
  body: unknown,
): Promise<unknown> => {
  const res = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': UA,
    },
    body: JSON.stringify(body),
  })
  if (res.status === 401) {
    throw new GithubError(
      'auth',
      'GitHub token rejected (401)',
    )
  }
  if (res.status === 403 || res.status === 404) {
    throw new GithubError(
      'access',
      `No repo write access (${res.status})`,
    )
  }
  if (!res.ok) {
    throw new GithubError(
      'http',
      `${method} ${url} responded ${res.status}`,
    )
  }
  return res.status === 204 ? {} : res.json()
}

export interface CreateSubIssueArgs {
  repo: string
  parentIssueNumber: number
  title: string
  body: string
  token: string
}

// Two steps: create the item as its own issue, then link it as a
// sub-issue under the category parent. `sub_issue_id` is the new
// issue's REST `id` — NOT its `number`. A failed create means
// nothing was filed, so that step still throws. A failed link
// leaves a real, already-filed issue behind — so that step never
// throws; it reports `linked: false` instead, so callers can mark
// the item sent (not pending) and avoid filing a duplicate on retry.
export const createSubIssue = async (
  args: CreateSubIssueArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<{ url: string; linked: boolean }> => {
  const created = (await ghSend(
    fetchImpl,
    'POST',
    `${API}/repos/${args.repo}/issues`,
    args.token,
    { title: args.title, body: args.body },
  )) as { id?: number; html_url?: string }
  if (!created.id || !created.html_url) {
    throw new GithubError(
      'http',
      'issue-create response missing id/html_url',
    )
  }
  try {
    await ghSend(
      fetchImpl,
      'POST',
      `${API}/repos/${args.repo}/issues/${args.parentIssueNumber}/sub_issues`,
      args.token,
      { sub_issue_id: created.id },
    )
  } catch {
    return { url: created.html_url, linked: false }
  }
  return { url: created.html_url, linked: true }
}
