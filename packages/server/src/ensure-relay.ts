const POLL_INTERVAL_MS = 200
const MAX_POLL_ATTEMPTS = 15

export const ensureRelay = async (
  httpUrl: string,
  port: number,
): Promise<{ started: boolean; error?: string }> => {
  // Health check — if relay is already running, return early
  try {
    const res = await fetch(`${httpUrl}/channels`)

    if (res.ok) {
      return { started: false }
    }
  } catch {
    // Not running — continue to spawn
  }

  // Resolve relay entry point path
  const relayUrl = import.meta
    .resolve('@figma-agent-bridge/relay')
  const relayPath = Bun.fileURLToPath(relayUrl)

  // Spawn detached relay process
  const proc = Bun.spawn(['bun', 'run', relayPath], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  proc.unref()

  // Poll for readiness
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await Bun.sleep(POLL_INTERVAL_MS)

    try {
      const res = await fetch(`${httpUrl}/channels`)

      if (res.ok) {
        return { started: true }
      }
    } catch {
      // Not ready yet
    }
  }

  return {
    started: false,
    error:
      'Relay process was spawned but did not become ready within 3 seconds.',
  }
}
