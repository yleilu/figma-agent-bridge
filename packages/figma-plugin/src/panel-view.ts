export type Mismatch = {
  plugin: string
  server: string
}

export type PanelView =
  | { kind: 'connecting' }
  | { kind: 'offline' }
  | { kind: 'mismatch'; plugin: string; server: string }
  | { kind: 'idle' }
  | { kind: 'roster' }

// The single source of truth for which fallback/roster tier renders.
// Precedence: connecting → offline → version mismatch (PRE-EMPTS the roster,
// version-handshake.md) → idle → roster. Pure, so it is unit-testable without
// a React harness.
export const selectPanelView = (
  status: 'disconnected' | 'connecting' | 'connected',
  mismatch: Mismatch | null,
  rowCount: number,
): PanelView => {
  if (status === 'connecting') {
    return { kind: 'connecting' }
  }
  if (status === 'disconnected') {
    return { kind: 'offline' }
  }
  if (mismatch !== null) {
    return {
      kind: 'mismatch',
      plugin: mismatch.plugin,
      server: mismatch.server,
    }
  }
  return rowCount === 0
    ? { kind: 'idle' }
    : { kind: 'roster' }
}
