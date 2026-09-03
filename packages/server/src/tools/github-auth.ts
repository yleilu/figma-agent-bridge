import {
  fetchIdentity,
  pollDeviceAuth,
  startDeviceAuth,
} from '../github-client'
import { setToken } from '../credential-store'
import {
  type ToolResult,
  textResult,
  toolError,
  errorEnvelope,
} from './shared'

interface PendingAuth {
  deviceCode: string
  clientId: string
  intervalSec: number
  expiresAt: number
}

let pending: PendingAuth | null = null

// test-only reset hook
export const resetPendingAuth = (): void => {
  pending = null
}

// Per-call wall-clock budget. Under the MCP client's 60s
// default request timeout, so a still-pending poll returns
// {status:'pending'} before the client cancels; the agent
// then re-invokes.
const POLL_BUDGET_MS = 45_000

type Sleep = (ms: number) => Promise<void>
const realSleep: Sleep = ms =>
  new Promise(r => setTimeout(r, ms))

// clientId/scope are passed in from index.ts (which reads the
// OAUTH_CLIENT_ID / OAUTH_SCOPE constants) so this module stays
// constant-free and easy to test.
export const handleGithubAuthStart = async (
  clientId: string,
  scope: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult> => {
  if (!clientId) {
    return errorEnvelope(
      'API_UNAVAILABLE',
      'GitHub login is not configured (no OAuth client id). Use anonymous.',
    )
  }
  try {
    const d = await startDeviceAuth(
      clientId,
      scope,
      fetchImpl,
    )
    pending = {
      deviceCode: d.deviceCode,
      clientId,
      intervalSec: d.interval,
      expiresAt: Date.now() + d.expiresIn * 1000,
    }
    return textResult(
      JSON.stringify({
        user_code: d.userCode,
        verification_uri: d.verificationUri,
        expires_in: d.expiresIn,
        interval: d.interval,
      }),
    )
  } catch (err) {
    return toolError(err)
  }
}

export const handleGithubAuthPoll = async (
  fetchImpl: typeof fetch = fetch,
  sleep: Sleep = realSleep,
): Promise<ToolResult> => {
  if (!pending) {
    return textResult(
      JSON.stringify({
        status: 'error',
        message:
          'No login in progress — call github_auth_start first.',
      }),
    )
  }
  const deadline = Date.now() + POLL_BUDGET_MS
  let intervalMs = pending.intervalSec * 1000
  try {
    while (Date.now() < deadline) {
      if (Date.now() > pending.expiresAt) {
        pending = null
        return textResult(
          JSON.stringify({ status: 'expired' }),
        )
      }
      const r = await pollDeviceAuth(
        pending.clientId,
        pending.deviceCode,
        fetchImpl,
      )
      if (r.status === 'authorized' && r.accessToken) {
        const identity = await fetchIdentity(
          r.accessToken,
          fetchImpl,
        )
        await setToken(r.accessToken, identity)
        pending = null
        return textResult(
          JSON.stringify({
            status: 'authorized',
            identity,
          }),
        )
      }
      if (r.status === 'denied') {
        pending = null
        return textResult(
          JSON.stringify({ status: 'denied' }),
        )
      }
      if (r.status === 'expired') {
        pending = null
        return textResult(
          JSON.stringify({ status: 'expired' }),
        )
      }
      if (r.status === 'slow_down' && r.interval) {
        intervalMs = r.interval * 1000
      }
      await sleep(intervalMs)
    }
    // budget elapsed, still pending — the agent re-invokes
    return textResult(JSON.stringify({ status: 'pending' }))
  } catch (err) {
    return toolError(err)
  }
}
