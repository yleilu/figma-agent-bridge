const DEFAULT_POLL_INTERVAL_MS = 200
const DEFAULT_MAX_POLL_ATTEMPTS = 30

export type EnsureRelayOptions = {
  pollIntervalMs?: number
  maxPollAttempts?: number
}

const isRelayUp = async (
  httpUrl: string,
): Promise<boolean> => {
  try {
    const res = await fetch(`${httpUrl}/channels`)
    return res.ok
  } catch {
    return false
  }
}

export const ensureRelay = async (
  httpUrl: string,
  port: number,
  opts: EnsureRelayOptions = {},
): Promise<{
  error?: string
  proc?: ReturnType<typeof Bun.spawn>
}> => {
  const pollIntervalMs =
    opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const maxPollAttempts =
    opts.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS

  // Health check — if relay is already running, return early.
  if (await isRelayUp(httpUrl)) {
    return {}
  }

  let proc: ReturnType<typeof Bun.spawn>
  try {
    // Resolve relay entry point path.
    const relayUrl = import.meta
      .resolve('@figma-agent-bridge/relay')
    const relayPath = Bun.fileURLToPath(relayUrl)

    // Single-flight: re-check immediately before spawn in case another
    // instance won the race between the first check and now (TOCTOU).
    if (await isRelayUp(httpUrl)) {
      return {}
    }

    // Spawn detached relay process.
    proc = Bun.spawn(['bun', 'run', relayPath], {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    proc.unref()
  } catch (err) {
    return {
      error: `Failed to spawn relay process: ${(err as Error).message}`,
    }
  }

  // Poll for readiness.
  for (let i = 0; i < maxPollAttempts; i++) {
    await Bun.sleep(pollIntervalMs)

    // Early-crash detection: the child exited before becoming ready.
    if (proc.exitCode !== null) {
      return {
        error: `Relay process exited early with code ${proc.exitCode}.`,
      }
    }

    if (await isRelayUp(httpUrl)) {
      return { proc }
    }
  }

  // Timed out — kill the orphan and wait for it to exit.
  proc.kill()
  await proc.exited
  return {
    error: `Relay process was spawned but did not become ready within ${
      (pollIntervalMs * maxPollAttempts) / 1000
    } seconds.`,
  }
}
