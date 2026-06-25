// tools/search.ts — the one finder (Rule A; server-side match + projection +
// cursor).
//
// The PLUGIN scans the requested scope (document | page | node | selection) and
// returns the raw candidate nodes — it does NOT filter. The SERVER owns:
//   • match     — buildMatcher predicate (name glob / regex / type array / …)
//   • fields    — projectNode allow-list projection
//   • limit     — page size (default 50)
//   • cursor    — opaque resume token (encodeCursor/decodeCursor) over the
//                 post-match list, version-stamped so a stale cursor (the
//                 candidate set changed between calls) is reported, not silently
//                 resumed at the wrong position.
//
// Emits { results, truncated, cursor? } as YAML. `cursor` is present only when
// more results remain after this page.

import { createHash } from 'node:crypto'
import YAML from 'yaml'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type {
  Match,
  Profile,
} from '@figma-agent-bridge/shared/read-model'
import type { NodeSpec } from '@figma-agent-bridge/shared/node-spec'
import type { FigmaClient } from '../figma-client'
import { buildMatcher } from '../read/match'
import { projectNode } from '../read/project'
import { encodeCursor, decodeCursor } from '../read/cursor'
import {
  type ToolResult,
  textResult,
  requireConnected,
  errorMessage,
} from './shared'

const DEFAULT_LIMIT = 50

type SearchScope =
  | 'document'
  | 'page'
  | 'node'
  | 'selection'

/**
 * Version-stamp for the candidate list. A cursor minted against one candidate
 * set must not silently resume against a different one — we hash the ordered
 * ids so a changed set yields a different treeVersion (→ decodeCursor STALE).
 */
const versionOf = (candidates: { id?: string }[]): string =>
  createHash('sha1')
    .update(candidates.map(c => c.id ?? '').join('\n'))
    .digest('base64url')
    .slice(0, 12)

export const handleSearch = async (
  params: {
    scope?: SearchScope
    pageId?: string
    nodeId?: string
    match?: Match
    fields?: string[]
    profile?: Profile
    limit?: number
    cursor?: string
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const raw = (await client.sendCommand(COMMANDS.SEARCH, {
      scope: params.scope ?? 'document',
      pageId: params.pageId,
      nodeId: params.nodeId,
    })) as { results: Record<string, unknown>[] } | null

    if (raw === null) {
      return textResult(
        'Search failed: no response from plugin.',
      )
    }
    if (!Array.isArray(raw.results)) {
      return textResult('Unexpected response from plugin')
    }

    // 1 — match (server-side filter, incl. type array via buildMatcher).
    const matcher =
      params.match !== undefined
        ? buildMatcher(params.match)
        : null
    const matched = (
      matcher === null
        ? raw.results
        : raw.results.filter(n =>
            matcher(n as unknown as NodeSpec),
          )
    ) as { id?: string }[]

    // 2 — cursor: resolve the resume position over the matched list.
    const treeVersion = versionOf(matched)
    let start = 0
    if (params.cursor !== undefined) {
      const decoded = decodeCursor(
        params.cursor,
        treeVersion,
      )
      if (!decoded.ok) {
        return textResult(
          `Cursor rejected (${decoded.reason}) — re-run the search to get a fresh cursor.`,
        )
      }
      start = decoded.pos
    }

    // 3 — limit: slice the page.
    const limit = params.limit ?? DEFAULT_LIMIT
    const end = start + limit
    const page = matched.slice(start, end)
    const truncated = end < matched.length

    // 4 — fields/profile projection over the page.
    const projected = page.map(n =>
      projectNode(n as unknown as NodeSpec, {
        fields: params.fields,
        profile: params.profile,
      }),
    )

    const out: {
      results: unknown[]
      truncated: boolean
      cursor?: string
    } = { results: projected, truncated }
    if (truncated) {
      out.cursor = encodeCursor({ pos: end, treeVersion })
    }

    return textResult(YAML.stringify(out))
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
