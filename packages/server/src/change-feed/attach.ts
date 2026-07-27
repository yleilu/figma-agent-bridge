// Wires the ChangeFeed to the transport: the push handler, and the two
// server-side disconnect arms (change-feed.md, The two broken-baseline states).
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { DocumentChangedParams } from '@figma-agent-bridge/shared/change-feed'
import { createDocumentChangedHandler } from '../component-index/document-changed'
import type { FigmaClient } from '../figma-client'
import type { ChangeFeed } from './feed'

export const attachChangeFeed = (
  client: FigmaClient,
  feed: ChangeFeed,
  markIndexStale: (fileKey: string) => void,
): void => {
  // One frame, two consumers. The routability guard (a push whose meta.fileKey
  // is absent or empty is dropped silently — it cannot be routed to a buffer,
  // and inventing a route would violate B3) and the index's staleness signal
  // both stay owned by the component-index handler; this module composes it
  // rather than copying the rule, so the two can never disagree about which
  // pushes exist.
  const routeFrame = createDocumentChangedHandler({
    markStale: markIndexStale,
  })

  client.onRequest(
    COMMANDS.DOCUMENT_CHANGED,
    (params, meta) => {
      const routed = routeFrame(params, meta)
      if (!routed.ok) {
        return { ok: false }
      }
      feed.ingest(
        routed.fileKey,
        params as DocumentChangedParams,
        { epoch: meta.epoch, seq: meta.seq },
      )
      return { ok: true }
    },
  )

  // The client socket closed → the history has a hole on every file we watch.
  client.onSocketClose(() => {
    feed.markAllGap()
  })
  // connection-liveness.md — the watchdog dropped this one file.
  client.onFileDead(fileKey => {
    feed.markGap(fileKey)
  })
}
