const DEFAULT_POLL_INTERVAL_MS = 200
const DEFAULT_MAX_POLL_ATTEMPTS = 30

export type EnsureRelayOptions = {
  pollIntervalMs?: number
  maxPollAttempts?: number
  /**
   * Override the spawn argv vector. Used in tests to inject the correct
   * entry-point path when `process.argv[1]` is the test runner, not index.ts.
   * In production (dev or compiled binary), leave this undefined.
   */
  _relayArgvOverride?: string[]
}

/**
 * Builds the argv vector for spawning the relay subprocess.
 * Exported for unit testing the dev-vs-compiled branch logic.
 *
 * - Compiled binary (argv[1] starts with '/$bunfs/'): [execPath, '--relay']
 * - Dev (argv[1] is a real script path): [execPath, argv[1], '--relay']
 */
export const buildRelayArgv = (
  execPath: string,
  argv1: string | undefined,
): string[] => {
  const compiled = argv1?.startsWith('/$bunfs/') ?? false
  return compiled
    ? [execPath, '--relay']
    : [execPath, argv1 ?? execPath, '--relay']
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
    // Single-flight: re-check immediately before spawn in case another
    // instance won the race between the first check and now (TOCTOU).
    if (await isRelayUp(httpUrl)) {
      return {}
    }

    // Build spawn argv: compiled binary omits the script path; dev includes it.
    const relayArgv =
      opts._relayArgvOverride ??
      buildRelayArgv(process.execPath, process.argv[1])

    // Spawn detached relay process using the binary itself.
    proc = Bun.spawn(relayArgv, {
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
