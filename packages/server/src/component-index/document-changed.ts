// The `document_changed` push handler (change-feed.md, "The push frame").
// Extracted from index.ts so the wire contract it reads is pinned by a test
// rather than by a copy of itself: the frame's ARRIVAL used to be the
// component index's stale signal, and after the wire cut the frame fires for
// every change type, so the discriminator is now `params.indexStale`.
import type { Meta } from '@figma-agent-bridge/shared'

/** The slice of IndexManager this handler needs. */
type StaleMarker = {
  markStale(fileKey: string): void
}

export const createDocumentChangedHandler =
  (indexManager: StaleMarker) =>
  (
    params: Record<string, unknown>,
    meta: Meta,
  ): { ok: boolean } => {
    const { fileKey } = meta
    // A push whose meta.fileKey is absent or empty is DROPPED, silently: it
    // cannot be routed to a buffer, and inventing a route would violate B3.
    if (
      typeof fileKey !== 'string' ||
      fileKey.length === 0
    ) {
      return { ok: false }
    }
    // Frame arrival is NOT the staleness signal — the frame now fires for
    // all change types (component-index.md). The plugin computes this flag
    // PRE-filter over the raw batch, so the agent's own component writes
    // still mark the index stale.
    if (params.indexStale === true) {
      indexManager.markStale(fileKey)
    }
    return { ok: true }
  }
