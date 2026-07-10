// tools/search.ts — the one finder (Rule A; server-side match + projection +
// cursor).
//
// The PLUGIN scans the requested scope (document | page | node | selection) and
// returns the raw candidate nodes — it does NOT filter. The SERVER owns:
//   • match     — buildMatcher predicate (name glob / regex / type array / …)
//   • fields    — projectNode allow-list projection
//   • limit     — page size (default 50)
//   • cursor    — opaque resume token over the post-match list, version-stamped
//                 so a stale cursor (the candidate set changed between calls) is
//                 reported, not silently resumed at the wrong position.
//
// limit+cursor are applied by the shared `paginateList` helper (read/paginate),
// the one implementation behind every bounded list read (T10).
//
// Emits { results, truncated, cursor? } as YAML. `cursor` is present only when
// more results remain after this page.

import YAML from 'yaml'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type {
  Match,
  Profile,
} from '@figma-agent-bridge/shared/read-model'
import type { NodeSpec } from '@figma-agent-bridge/shared/node-spec'
import type { ScopedFigmaClient } from '../figma-client'
import { buildMatcher } from '../read/match'
import { projectNode } from '../read/project'
import { contextSummaryOf } from '../read/context-summary'
import { paginateList, CursorError } from '../read/paginate'
import {
  type ToolResult,
  textResult,
  errorMessage,
  cursorRejected,
} from './shared'

const DEFAULT_LIMIT = 50

type SearchScope =
  | 'document'
  | 'page'
  | 'node'
  | 'selection'

/**
 * Conditional-collection hints for the plugin scan (B3 + B4).
 *
 * The reverse-lookup match keys (componentKey / styleId / variableId /
 * instancesOf) and the `characters` projection require PER-CANDIDATE async
 * Figma calls (getMainComponentAsync, style ids, boundVariables, TEXT
 * .characters). Those are expensive, so the plugin only pays them when the
 * request actually needs them — the server tells it WHICH via these flags:
 *
 *   collectComponentRef — match.componentKey OR match.instancesOf
 *                         (the instance's main component key + name)
 *   collectStyleId      — match.styleId   (fill/text/effect/stroke/grid styleId)
 *   collectVariableId   — match.variableId (boundVariables ids)
 *   collectCharacters   — fields includes 'characters' (TEXT .characters)
 *
 * Returns only the flags that are TRUE, so an unhinted scan stays byte-for-byte
 * the same request it was before B3/B4 (no cost on the common path).
 */
export const buildCollectHints = (params: {
  match?: Match
  fields?: string[]
}): Record<string, true> => {
  const hints: Record<string, true> = {}
  const m = params.match
  if (
    m?.componentKey !== undefined ||
    m?.instancesOf !== undefined
  ) {
    hints.collectComponentRef = true
  }
  if (m?.styleId !== undefined) {
    hints.collectStyleId = true
  }
  if (m?.variableId !== undefined) {
    hints.collectVariableId = true
  }
  if (params.fields?.includes('characters')) {
    hints.collectCharacters = true
  }
  return hints
}

export const handleSearch = async (
  params: {
    scope?: SearchScope
    pageId?: string
    nodeId?: string
    depth?: number
    match?: Match
    fields?: string[]
    profile?: Profile
    limit?: number
    cursor?: string
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  try {
    // The plugin scans the scope and returns flat candidate nodes (it does NOT
    // match/project/paginate — that is the server's job below). `depth` bounds
    // the scan SCOPE (descent depth) only; it is forwarded verbatim and
    // omitted when not given so the plugin applies its scan-all default.
    // When `match` requests a reverse-lookup key (componentKey / styleId /
    // variableId / instancesOf) or `fields`/`profile` requests `characters`,
    // the plugin must collect that metadata per candidate — forward the hints
    // so it only pays that async cost when actually needed.
    const raw = (await client.sendCommand(COMMANDS.SEARCH, {
      scope: params.scope ?? 'document',
      pageId: params.pageId,
      nodeId: params.nodeId,
      ...(params.depth !== undefined
        ? { depth: params.depth }
        : {}),
      ...buildCollectHints(params),
    })) as {
      results?: Record<string, unknown>[]
      error?: string
    } | null

    if (raw === null) {
      return textResult(
        'Search failed: no response from plugin.',
      )
    }
    // An unresolvable node/page scope qualifier resolves as {error} (not a WS
    // reject); surface it (T7) so a typo'd id is distinguishable from no-match.
    if (raw.error !== undefined) {
      return textResult(`Error: ${raw.error}`)
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

    // 2/3 — cursor + limit: bound the matched list to one page via the shared
    // paginateList helper (the one implementation behind every list read, T10).
    // It version-stamps the matched id-set and rejects a STALE/MALFORMED cursor
    // with a typed CursorError, which we surface (search keeps its own default
    // limit of 50; paginateList defaults to 100 for other list reads).
    let bounded
    try {
      bounded = paginateList(matched, {
        limit: params.limit ?? DEFAULT_LIMIT,
        cursor: params.cursor,
      })
    } catch (err) {
      if (err instanceof CursorError) {
        return textResult(cursorRejected(err))
      }
      throw err
    }

    // 4 — fields/profile projection over the page. Bounded readers emit the
    // capped `contextSummary` slice, never the raw `context` (post-projection,
    // not projectable — the raw value only round-trips via get_node/get_nodes).
    const projected = bounded.page.map(n => {
      const out = projectNode(n as unknown as NodeSpec, {
        fields: params.fields,
        profile: params.profile,
      }) as { context?: unknown; contextSummary?: string }
      const summary = contextSummaryOf(
        (n as { context?: string }).context,
      )
      delete out.context
      if (summary !== undefined) {
        out.contextSummary = summary
      }
      return out
    })

    const out: {
      results: unknown[]
      truncated: boolean
      cursor?: string
    } = { results: projected, truncated: bounded.truncated }
    if (bounded.cursor !== undefined) {
      out.cursor = bounded.cursor
    }

    return textResult(YAML.stringify(out))
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
