import { describe, it, expect } from 'bun:test'
import {
  DEFAULT_RELAY_PORT,
  resolveRelayPort,
} from './useDiscovery'

// The change-feed POC pinned this hook to 18081 (a relay with its token
// bucket disarmed) AND made it ignore the stored value, so the probe build
// could not be pointed anywhere else. Both were reverted with the harness;
// this is the regression guard, because a pinned port fails SILENTLY — the
// panel simply never finds the real relay and reads as "not running".
describe('relay port discovery', () => {
  it('defaults to the production relay port', () => {
    expect(DEFAULT_RELAY_PORT).toBe(18080)
  })

  it('falls back to the default when nothing is stored', () => {
    expect(resolveRelayPort(null)).toBe(18080)
    expect(resolveRelayPort(undefined)).toBe(18080)
  })

  it('honours a stored port over the default', () => {
    expect(resolveRelayPort(19999)).toBe(19999)
  })
})
