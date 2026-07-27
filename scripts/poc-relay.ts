// scripts/poc-relay.ts — the change-feed POC relay
// (docs/scratch/plans/2026-07-26-change-feed.md, Task 1a). THROWAWAY: deleted
// with the rest of the probe harness in Task 7.
//
// WHY A SEPARATE RELAY. The shipped relay meters every inbound frame through a
// per-connection token bucket — RATE_TOKENS_PER_SEC=50, RATE_BURST=100, see
// consumeToken() in packages/relay/src/relay.ts — and a frame it cannot pay for
// is DROPPED with no error to either side. Probe frames ride the same
// `type: 'message'` envelope as command replies, on the same socket, so at
// production sizing a probe burst both loses probe rows and starves the replies
// whose timing the POC is measuring. A distorted measurement is worse than no
// measurement, so the POC runs its own relay with the bucket sized out of the
// way.
//
// This process starts a SECOND relay on its own port. It modifies nothing:
// startRelay already accepts the bucket sizing as an option (added for the
// in-process harness self-test), so the shipped relay's behaviour on 18080 is
// untouched and no shipped code path can reach these options.
//
// Measurement D is deliberately re-run against the PRODUCTION relay
// (`bun run dev:relay`), which is the point at which production bucket
// behaviour is back under test.
import { DEFAULT_PORT } from '@figma-agent-bridge/shared/constants'
import {
  startRelay,
  type StartRelayOptions,
} from '@figma-agent-bridge/relay/relay'

/** The POC relay's port. Deliberately not DEFAULT_PORT (18080). */
export const POC_RELAY_PORT = 18081

/**
 * Bucket sizing that cannot drop a probe frame. Five orders of magnitude above
 * the feed's own FEED_FRAMES_PER_SEC budget and three above anything a
 * documentchange storm can emit, so the bucket is out of the measurement
 * entirely rather than merely generous.
 */
export const POC_RELAY_OPTS: StartRelayOptions = {
  rateBurst: 100_000,
  rateTokensPerSec: 100_000,
}

/**
 * Resolve the port to listen on, refusing the production one. Disarming the
 * bucket on 18080 would silently change the behaviour every other part of the
 * system is measured against — including Measurement D, which exists precisely
 * to observe the production bucket.
 */
export const resolvePocPort = (
  raw: string | undefined,
): number => {
  if (raw === undefined || raw === '') {
    return POC_RELAY_PORT
  }
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `[poc-relay] POC_RELAY_PORT is not a port: ${raw}`,
    )
  }
  if (port === DEFAULT_PORT) {
    throw new Error(
      `[poc-relay] refusing to run on the production port ${DEFAULT_PORT} — ` +
        'the POC relay disarms the token bucket and must never stand in for the real relay',
    )
  }
  return port
}

if (import.meta.main) {
  const port = resolvePocPort(process.env.POC_RELAY_PORT)
  startRelay(port, POC_RELAY_OPTS)
  console.log(
    `[poc-relay] listening on ${port} (bucket disarmed)`,
  )
}
