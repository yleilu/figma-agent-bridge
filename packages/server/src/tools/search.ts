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
// A scan row is CHEAP — id / name / type / size, plus `characters` on request —
// because the scan crosses the whole document. So a projection that asks for a
// field the row does not hold (`fills`, `component`, `layout`, …) fetches those
// nodes' specs in one GET_NODES, AFTER match and limit have bounded the page
// (B50). D2 is one contract on every node-returning read; the scan's own row is
// an optimisation, never a smaller vocabulary.
//
// limit+cursor are applied by the shared `paginateList` helper (read/paginate),
// the one implementation behind every bounded list read (T10).
//
// Emits { results, truncated, cursor?, warnings? } as JSON. `cursor` is present
// only when more results remain after this page; `warnings` only when the scan
// had to skip a candidate it could not read (T7).

import { COMMANDS } from '@figma-agent-bridge/shared'
import {
  SEARCH_FIELDS,
  searchFieldRejection,
} from '@figma-agent-bridge/shared/tool-params'
import type {
  Match,
  Profile,
} from '@figma-agent-bridge/shared/read-model'
import type { NodeSpec } from '@figma-agent-bridge/shared/node-spec'
import type { ScopedFigmaClient } from '../figma-client'
import { toNodeSpec } from '../serialize/node-spec-reader'
import { buildMatcher } from '../read/match'
import { PROFILES, projectNode } from '../read/project'
import { contextSummaryOf } from '../read/context-summary'
import { paginateList, CursorError } from '../read/paginate'
import {
  type ToolResult,
  textResult,
  toolError,
  pluginError,
  errorEnvelope,
  cursorRejected,
} from './shared'

const DEFAULT_LIMIT = 50

/**
 * How many rows one page may HYDRATE (I61).
 *
 * `limit` is the caller's number, and B50 bounded the hydration by it — which
 * is bounded only in the sense that any number is. A projection reaching past
 * the scan row costs one per-node export EACH, so a big `limit` buys that many
 * exports inside one 30-second command:
 *
 *   Live 2026-08-27, an 838-node file:
 *     search({match:{type:['INSTANCE']}, fields:['id','name','component'],
 *             limit:500})  →  {"error":"Command cmd-… timed out","code":"TIMEOUT"}
 *   The SAME projection, scoped per page at limit:100, succeeded on all four
 *   pages and returned 480 instances.
 *
 * So a heavy projection's page is clipped to 100 — the size that is proven to
 * come back on this exact projection, and the shared `paginateList` default
 * every other list read uses. The cursor already exists, so the caller loses
 * nothing but one round trip, and the reply SAYS the tool clipped the page
 * rather than letting a short page read as a short document.
 *
 * The cap is on the HYDRATION, not on `search`: a projection the scan row
 * already answers (`id`/`name`/`type`/`size`/`characters`) pays nothing and
 * keeps the caller's `limit` untouched. This is the get_components shape —
 * gate the O(document) half, surface the truncation (T10) — applied to the
 * half that actually costs.
 */
export const HYDRATION_CAP = 100

/** What a clipped page says: what happened, why, and how to continue. */
const hydrationCapWarning = (
  asked: number,
  fields: readonly string[] | null,
): string =>
  `search: limit ${asked} was clipped to ${HYDRATION_CAP} for this page. ` +
  'The requested projection (' +
  (fields === null
    ? "profile:'full'"
    : fields.map(f => '`' + f + '`').join(', ')) +
  ') reaches past the scan row, so every result costs one node read — and a ' +
  'wider page than this times out rather than answering. Pass the returned ' +
  '`cursor` for the next ' +
  String(HYDRATION_CAP) +
  ', or narrow `scope` to one page.'

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

/**
 * What a search CANDIDATE already carries, so a projection over these alone
 * needs no second read.
 *
 * The plugin's scan builds a flat row per node — `id`, `name`, `type`, `size`,
 * plus `characters` when the `collectCharacters` hint is on. Everything else in
 * the projection vocabulary (`fills`, `component`, `layout`, `effects`, `text`,
 * …) lives on the node's EXPORT, which a document-wide scan does not pay for.
 */
const CANDIDATE_FIELDS = new Set([
  'id',
  'name',
  'type',
  'size',
  'characters',
])

/**
 * How many children a result has — a search-only projection (I58).
 *
 * `search` returns a FLAT list in DFS order, and a flat list of ids says what
 * exists while saying nothing about what contains what. `childCount` is the one
 * field that lets a caller rebuild the tree, and it was not in the vocabulary
 * at all: asking for it dropped it silently, so a document sweep read exactly
 * like a document where nothing has children.
 *
 * It rides over from the hydrated NodeSpec rather than from the scan row: the
 * reader turns each child into an IdStub at `depth: 0`, so the count is exact
 * and costs nothing beyond the fetch `fields` already forces.
 */
const CHILD_COUNT = 'childCount'

/**
 * The field names a selector asks for: the explicit list, the profile's set, or
 * `null` for `profile:'full'` — which means EVERY field, not a list.
 *
 * An absent selector answers `[]`: nothing was asked for, so nothing is owed
 * beyond the candidate row search has always returned. An out-of-enum profile
 * also answers `[]`, matching `projectNode`, which returns the node unchanged
 * rather than throwing (B4).
 */
const selectedFields = (sel: {
  fields?: string[]
  profile?: Profile
}): readonly string[] | null => {
  if (sel.fields?.length) {
    return sel.fields
  }
  if (sel.profile === 'full') {
    return null
  }
  if (sel.profile !== undefined) {
    return PROFILES[sel.profile] ?? []
  }
  return []
}

/**
 * Does this projection reach past the candidate row?
 *
 * `fields:['id','name','type','fills']` did — and `fills` came back on no
 * result at all, with no warning, because the projection ran over a row that
 * never had it (B50). A dropped field is indistinguishable from a negative
 * result, so a white-frame sweep came back clean on frames that were white.
 * D2 governs: `fields`/`profile` mean the same thing on every node-returning
 * read, so the ones the scan cannot supply are FETCHED.
 */
const needsNodeSpecs = (sel: {
  fields?: string[]
  profile?: Profile
}): boolean => {
  const keys = selectedFields(sel)
  return (
    keys === null ||
    keys.some(k => !CANDIDATE_FIELDS.has(k))
  )
}

/**
 * The full NodeSpec for each row of ONE page of results, by index.
 *
 * Bounded by construction: this runs AFTER match + limit, so it asks for at
 * most `limit` ids (50 by default) however large the scan was. `depth: 0` is
 * the fidelity reader's own default — a search result is a row, not a tree, so
 * its children stay id-stubs.
 *
 * Degrades per id (T7): an id the plugin can no longer resolve answers
 * `{id, error}`, which leaves that row as the candidate the scan built and puts
 * the reason in `warnings` — a thin row has to SAY it is thin.
 */
const fetchNodeSpecs = async (
  ids: string[],
  client: ScopedFigmaClient,
  warnings: string[],
): Promise<(NodeSpec | undefined)[]> => {
  if (ids.length === 0) {
    return []
  }
  const raw = (await client.sendCommand(
    COMMANDS.GET_NODES,
    {
      nodeIds: ids,
      depth: 0,
    },
  )) as Record<string, unknown>[] | null
  if (!Array.isArray(raw)) {
    warnings.push(
      'search: the requested fields were not read back — the plugin returned no node specs',
    )
    return ids.map(() => undefined)
  }
  return ids.map((id, i) => {
    const entry = raw[i]
    if (entry === undefined || entry === null) {
      warnings.push(
        `search: ${id} was not read back; the requested fields are missing on that result`,
      )
      return undefined
    }
    if (typeof entry.error === 'string') {
      warnings.push(
        `search: ${id} could not be read (${entry.error}); the requested fields are missing on that result`,
      )
      return undefined
    }
    return toNodeSpec(entry, { depth: 0 })
  })
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
    // I58 — an entry `fields` cannot supply is REFUSED, before anything is
    // scanned. Dropping it silently is the same failure B50 was: a field that
    // never appears reads as a field the node does not carry, and the caller
    // draws the opposite conclusion from the one the data supports. Checked
    // here rather than in the schema so a `batch` entry and a direct call are
    // held to the same vocabulary as an MCP call.
    const unknownFields = (params.fields ?? []).filter(
      f => !SEARCH_FIELDS.has(f),
    )
    if (unknownFields.length > 0) {
      return errorEnvelope(
        'INVALID_PARAM',
        searchFieldRejection(unknownFields),
      )
    }

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
      incomplete?: unknown
      degraded?: unknown
      warnings?: unknown
      error?: string
    } | null

    if (raw === null) {
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Search failed: no response from plugin.',
      )
    }
    // An unresolvable node/page scope qualifier resolves as {error} (not a WS
    // reject); surface it (T7) so a typo'd id is distinguishable from no-match.
    if (raw.error !== undefined) {
      return pluginError(raw.error)
    }
    if (!Array.isArray(raw.results)) {
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Unexpected response from plugin',
      )
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
    //
    // I61 — a projection that must HYDRATE is clipped to HYDRATION_CAP first.
    // The page is what decides how many per-node reads step 3½ pays for, so
    // this is the only place the cost can be bounded, and clipping it here
    // keeps the cursor contract intact: the caller continues, it does not lose
    // rows.
    const askedLimit = params.limit ?? DEFAULT_LIMIT
    const hydrating = needsNodeSpecs(params)
    const pageLimit = hydrating
      ? Math.min(askedLimit, HYDRATION_CAP)
      : askedLimit
    let bounded
    try {
      bounded = paginateList(matched, {
        limit: pageLimit,
        cursor: params.cursor,
      })
    } catch (err) {
      if (err instanceof CursorError) {
        return textResult(cursorRejected(err))
      }
      throw err
    }

    // 3½ — the fields the scan cannot supply (D2, B50). Asked for only when
    // the projection reaches past the candidate row, and only over the page
    // the two steps above already bounded — so the common scan pays nothing
    // and the expensive one pays for `limit` nodes, not for the document.
    const hydrateWarnings: string[] = []
    // I61 — said BEFORE the fetch, so the note stands even if the hydration
    // then degrades per row: a clipped page and a thin row are two different
    // facts and the caller needs both.
    if (hydrating && pageLimit < askedLimit) {
      hydrateWarnings.push(
        hydrationCapWarning(
          askedLimit,
          selectedFields(params),
        ),
      )
    }
    const specs = hydrating
      ? await fetchNodeSpecs(
          bounded.page.map(n => n.id ?? ''),
          client,
          hydrateWarnings,
        )
      : []

    // 4 — fields/profile projection over the page. Bounded readers emit the
    // capped `contextSummary` slice, never the raw `context` (post-projection,
    // not projectable — the raw value only round-trips via get_node/get_nodes).
    //
    // The allow-list stays EXACT: a caller who wants `id` lists `id`, so
    // `fields:['characters']` returning id-less rows is the contract, not a
    // bug. Nothing is merged in behind the caller's back.
    const projected = bounded.page.map((n, i) => {
      const candidate = n as unknown as NodeSpec
      const spec = specs[i]
      // The node's own spec is the richer source, but the ROW keeps the id the
      // scan reported: that is the id the matcher matched, the id the cursor
      // version-stamped, and the id the caller drills with. `characters` is a
      // search-only projection (no NodeSpec field holds it), so it rides over
      // from the candidate.
      const carried: Record<string, unknown> = {}
      if (candidate.id !== undefined) {
        carried.id = candidate.id
      }
      if ('characters' in candidate) {
        carried.characters = (
          candidate as Record<string, unknown>
        ).characters
      }
      // Only when it was asked for BY NAME (I58). `profile:'full'` is identity
      // over the NodeSpec, and `childCount` is not one of its fields — adding
      // it there would put a key in every full result that `get_node` does not
      // emit for the same node.
      if (
        params.fields?.includes(CHILD_COUNT) === true &&
        spec !== undefined
      ) {
        carried[CHILD_COUNT] = spec.children?.length ?? 0
      }
      const source: NodeSpec =
        spec === undefined
          ? candidate
          : ({ ...spec, ...carried } as NodeSpec)
      const out = projectNode(source, {
        fields: params.fields,
        profile: params.profile,
      }) as { context?: unknown; contextSummary?: string }
      const summary = contextSummaryOf(
        (source as { context?: string }).context ??
          (n as { context?: string }).context,
      )
      delete out.context
      if (summary !== undefined) {
        out.contextSummary = summary
      }
      // I85 — a `position` on a search row is ABSOLUTE, and a `position` in a
      // `get_node` tree is PARENT-RELATIVE, because a search row is hydrated by
      // a read ENTERED at that node: there is no parent bbox to subtract from
      // it (node-spec-reader.ts, `positionOf`). Nothing said so, and two
      // reviewers mis-scored a round on it — every overflow, alignment and
      // containment check reads one number against the other. Emitted only
      // beside a position, so a row that carries none says nothing, and
      // server-derived like `contextSummary` rather than a NodeSpec field.
      if (
        (out as { position?: unknown }).position !==
        undefined
      ) {
        ;(out as { positionFrame?: string }).positionFrame =
          'absolute'
      }
      return out
    })

    const out: {
      results: unknown[]
      truncated: boolean
      incomplete?: true
      degraded?: number
      cursor?: string
      warnings?: string[]
    } = { results: projected, truncated: bounded.truncated }
    if (bounded.cursor !== undefined) {
      out.cursor = bounded.cursor
    }
    // B72 — `truncated` is about THIS PAGE of results: more matched, ask again
    // with the cursor. `incomplete` is about the SCAN: part of the document was
    // unreachable, so the match set itself is short and no cursor will finish
    // it. The two were conflated once and a document scan that had lost 13% of
    // the file answered `truncated:false` — a positive assertion that nothing
    // was missing. A caller counting anything has to be able to tell them
    // apart, so they are separate keys and this one is omitted when clean.
    if (raw.incomplete === true) {
      out.incomplete = true
    }
    // B85 — `degraded` is the third fact, and it is about ROWS, not about the
    // set: this many results are present and cannot answer a match on
    // `styleId`, `context`, `componentKey` or `instancesOf`, because they came
    // from an ancestor's export and an export carries none of those. From
    // `results` alone that is indistinguishable from a node the style is not
    // on — a style census read `results: 1` where three nodes carried the
    // style and two of them were plainly glowing in the PNG. Counted rather
    // than only narrated, so a completeness check can test it. Omitted at
    // zero, like the other two.
    if (
      typeof raw.degraded === 'number' &&
      raw.degraded > 0
    ) {
      out.degraded = raw.degraded
    }
    // A candidate the plugin could not read is skipped THERE and named here
    // (T7) — a scan that crossed an unreachable node returns the rest of the
    // document rather than an error, and the shortfall is stated instead of
    // being read as "no such node". Carried on the SUCCESS envelope, omitted
    // when the scan was clean, so its presence is the signal. A row whose
    // requested fields could not be fetched joins the same list, for the same
    // reason: a thin row must say it is thin.
    const scanWarnings = Array.isArray(raw.warnings)
      ? (raw.warnings as string[])
      : []
    const allWarnings = [
      ...scanWarnings,
      ...hydrateWarnings,
    ]
    if (allWarnings.length > 0) {
      out.warnings = allWarnings
    }

    return textResult(JSON.stringify(out, null, 2))
  } catch (err) {
    return toolError(err)
  }
}
