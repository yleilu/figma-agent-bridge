import YAML from 'yaml'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type {
  Match,
  Profile,
} from '@figma-agent-bridge/shared/read-model'
import type {
  NodeSpec,
  NodeSpecOrStub,
} from '@figma-agent-bridge/shared/node-spec'
import type { ScopedFigmaClient } from '../figma-client'
import { toNodeSpec } from '../serialize/node-spec-reader'
import { truncateTree, isStub } from '../read/truncate-tree'
import { buildMatcher } from '../read/match'
import { projectNode } from '../read/project'
import { contextSummaryOf } from '../read/context-summary'
import { depthProjectionConflict } from '../read/depth-projection'
import { paginateList, CursorError } from '../read/paginate'
import {
  type ToolResult,
  textResult,
  toolError,
  pluginError,
  errorEnvelope,
  cursorRejected,
} from './shared'
import { classifyMessage, type ErrorCode } from '../errors'

type ReadSelectors = {
  fields?: string[]
  profile?: Profile
}

/**
 * Walk the surviving (post-truncation) view applying match + projection.
 * Stubs pass through untouched; children filtered out by `match` are dropped.
 */
const projectView = (
  node: NodeSpecOrStub,
  sel: ReadSelectors,
  matcher: ((n: NodeSpec) => boolean) | null,
): NodeSpecOrStub => {
  if (isStub(node)) {
    return node
  }
  const { children } = node
  const out = projectNode(node, sel) as NodeSpec
  const summary = contextSummaryOf(
    (node as { context?: string }).context,
  )
  delete (out as { context?: unknown }).context
  if (summary !== undefined) {
    ;(out as { contextSummary?: string }).contextSummary =
      summary
  }
  if (Array.isArray(children)) {
    const kept = children
      .filter(c =>
        matcher === null || isStub(c) ? true : matcher(c),
      )
      .map(c => projectView(c, sel, matcher))
    // Only surface children when the projection kept the `children` field.
    if ('children' in out) {
      out.children = kept
    }
  }
  return out
}

// ─── inspect (Rule B: depth + budget + truncation receipt) ────────────────────

/**
 * Inspect a node/page tree. Serializes deep (depth=-1) via toNodeSpec, then
 * hands the tree to the read model: truncateTree applies depth + budget
 * (delegating to read/budget when a budget is set), collapsing boundary/wide
 * nodes to IdStubs and accumulating the truncation receipt. match + project
 * then narrow the surviving view. Returns { view, truncated:[{id,childCount}] }
 * as YAML.
 *
 * Multi-selection (M2 chunk F): with no nodeId/pageId, inspect() targets the
 * current selection. When >1 node is selected the plugin returns an ARRAY of
 * raw exports; the handler assembles a FOREST under a synthetic
 * { type: 'SELECTION', children: [<nodeSpec>, …] } root. That root carries no
 * real id, so depth/budget/receipt run across the WHOLE set naturally and every
 * receipt id stays a real, drillable node id. Single-select (1 export) and the
 * id/page targets keep the bare { view: <nodeSpec>, truncated } shape.
 */
export const handleInspect = async (
  {
    nodeId,
    pageId,
    depth,
    budget,
    fields,
    profile,
    match,
  }: {
    nodeId?: string
    pageId?: string
    depth?: number
    budget?: number
    fields?: string[]
    profile?: Profile
    match?: Match
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  // I64 — `depth` must never be silently inert. A descent whose projection
  // drops `children` throws away the one field the descent produces, and the
  // reply then reads as a node that has no children at all. Refused here,
  // before the scope is walked, on the same terms search refuses a field it
  // cannot supply (I58).
  const conflict = depthProjectionConflict({
    depth,
    fields,
    profile,
  })
  if (conflict !== null) {
    return errorEnvelope('INVALID_PARAM', conflict)
  }
  try {
    const raw = (await client.sendCommand(
      COMMANDS.INSPECT,
      {
        nodeId,
        pageId,
        // RESOLVED, not raw: the plugin uses `depth` to bound which nodes it
        // enriches, and it has no budget of its own to reason from. A
        // budget-only read fills as deep as the budget reaches (truncateTree's
        // own rule), so the enrichment has to reach that far too — otherwise a
        // descendant the budget kept would come back incomplete.
        depth: depth ?? (budget !== undefined ? -1 : 0),
      },
    )) as
      | Record<string, unknown>
      | Record<string, unknown>[]
      | null
    if (raw === null) {
      return errorEnvelope(
        'NODE_NOT_FOUND',
        `Node not found: ${nodeId ?? pageId ?? 'selection'}`,
      )
    }
    if (
      raw !== null &&
      typeof (raw as { error?: unknown }).error === 'string'
    ) {
      return pluginError((raw as { error: string }).error)
    }

    // Multi-selection → assemble a forest under a synthetic SELECTION root so
    // depth/budget/receipt bound the WHOLE set at once. Single export (array or
    // not) keeps the bare single-node view. Serialize each child deep; the read
    // model then decides what survives across the forest.
    const isForest = Array.isArray(raw)
    const full: NodeSpec = isForest
      ? {
          type: 'SELECTION',
          children: raw.map(n =>
            toNodeSpec(n, { depth: -1 }),
          ),
        }
      : toNodeSpec(raw, { depth: -1 })
    // The synthetic SELECTION root eats one level, so `depth` needs adjusting
    // before it reaches truncateTree. Four cases, one per thing the caller asked.
    const forestDepth = (): number | undefined => {
      if (depth === undefined && budget !== undefined) {
        // Budget-only: the budget decides how deep to fill. Forcing a depth
        // here truncates the tree before the budget fill ever runs — which is
        // exactly the regression this shape used to have, back when a budget
        // made truncateTree ignore depth and this bump looked harmless.
        return undefined
      }
      if (depth === undefined) {
        // Nothing asked for: show the selected nodes themselves — a bare
        // depth=0 would show the wrapper and stub everything under it.
        return 1
      }
      if (depth < 0) {
        // -1 is every level; the wrapper changes nothing.
        return depth
      }
      // A level cap counts from the selected nodes, so skip past the wrapper.
      return depth + 1
    }
    const effectiveDepth = isForest ? forestDepth() : depth
    const { view, truncated } = truncateTree(full, {
      depth: effectiveDepth,
      budget,
    })

    const matcher =
      match !== undefined ? buildMatcher(match) : null
    // For the forest, the synthetic SELECTION root's ONLY payload is its
    // children — the selected nodes themselves. A non-`full` projection drops
    // the root's `children`, which would erase the whole forest. So instead of
    // projecting the wrapper away, pass the SELECTION root through untouched and
    // project each selected child against the selector. Single-node inspect
    // keeps the original whole-view projection (descendants drop gracefully).
    const projected =
      isForest &&
      !isStub(view) &&
      Array.isArray(view.children)
        ? {
            ...view,
            children: view.children.map(c =>
              projectView(c, { fields, profile }, matcher),
            ),
          }
        : projectView(view, { fields, profile }, matcher)

    return textResult(
      YAML.stringify({ view: projected, truncated }),
    )
  } catch (err) {
    return toolError(err)
  }
}

// ─── get_node (fidelity-first NodeSpec read; NEVER budget-truncated) ───────────

/**
 * Read a single node as a canonical NodeSpec with atom-grammar leaves.
 *
 * Fidelity-first: sends COMMANDS.GET_NODE → toNodeSpec(depth) (children past
 * the boundary collapse to IdStubs; depth=0 default) → projectNode(fields/
 * profile) → JSON. It does NOT route through read/budget — get_node is never
 * size-truncated.
 */
export const handleGetNode = async (
  {
    nodeId,
    depth,
    fields,
    profile,
  }: {
    nodeId: string
    depth?: number
    fields?: string[]
    profile?: Profile
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  // I64 — see handleInspect. One rule across all three readers.
  const conflict = depthProjectionConflict({
    depth,
    fields,
    profile,
  })
  if (conflict !== null) {
    return errorEnvelope('INVALID_PARAM', conflict)
  }
  try {
    const raw = (await client.sendCommand(
      COMMANDS.GET_NODE,
      {
        nodeId,
        depth,
      },
    )) as Record<string, unknown> | null
    if (raw === null) {
      return errorEnvelope(
        'NODE_NOT_FOUND',
        `Node not found: ${nodeId}`,
      )
    }
    if (
      raw !== null &&
      typeof (raw as { error?: unknown }).error === 'string'
    ) {
      return pluginError((raw as { error: string }).error)
    }

    const spec = toNodeSpec(raw, { depth: depth ?? 0 })
    const projected = projectNode(spec, { fields, profile })

    return textResult(JSON.stringify(projected, null, 2))
  } catch (err) {
    return toolError(err)
  }
}

// ─── get_nodes (multi-id NodeSpec read → { results, errors[] }) ────────────────

/**
 * Read several nodes by id. Sends COMMANDS.GET_NODES with {nodeIds, depth?,
 * fields?}; the plugin returns one entry per id (a raw export, or {id, error}
 * for a miss). Each raw export is serialized via toNodeSpec(depth) + projected
 * (fields), successes collected into `results` and misses into `errors`.
 *
 * Like get_node this is fidelity-first — depth past the boundary collapses
 * children to IdStubs; it is NEVER budget-truncated.
 */
export const handleGetNodes = async (
  {
    nodeIds,
    depth,
    fields,
    profile,
  }: {
    nodeIds: string[]
    depth?: number
    fields?: string[]
    profile?: Profile
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  // I64 — see handleInspect. One rule across all three readers.
  const conflict = depthProjectionConflict({
    depth,
    fields,
    profile,
  })
  if (conflict !== null) {
    return errorEnvelope('INVALID_PARAM', conflict)
  }
  try {
    const raw = (await client.sendCommand(
      COMMANDS.GET_NODES,
      {
        nodeIds,
        depth,
        fields,
      },
    )) as Record<string, unknown>[] | null
    if (raw === null) {
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Failed to get nodes from plugin.',
      )
    }

    if (!Array.isArray(raw)) {
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Unexpected response from plugin',
      )
    }

    const results: Partial<NodeSpec>[] = []
    const errors: {
      id: string
      error: string
      code: ErrorCode
    }[] = []
    for (const entry of raw) {
      if (
        entry !== null &&
        typeof entry.error === 'string'
      ) {
        errors.push({
          id: (entry.id as string) ?? '',
          error: entry.error,
          code: classifyMessage(entry.error),
        })
        continue
      }
      const spec = toNodeSpec(entry, { depth: depth ?? 0 })
      results.push(projectNode(spec, { fields, profile }))
    }

    return textResult(
      JSON.stringify({ results, errors }, null, 2),
    )
  } catch (err) {
    return toolError(err)
  }
}

// ─── list_pages (Rule A list read → { docName, results, truncated, cursor? }) ──

/**
 * Enumerate the document's pages. Sends COMMANDS.LIST_PAGES; the plugin returns
 * { docName, results:[{id,name,isCurrent,childCount}] }. The plugin returns the
 * full doc-bounded page list cheaply; the SERVER bounds the AGENT-CONTEXT by
 * paginating it through paginateList (T10) — `limit` defaults to 100, an opaque
 * `cursor` continues when truncated. `docName` stays on the envelope alongside
 * the bounded page.
 */
export const handleListPages = async (
  { limit, cursor }: { limit?: number; cursor?: string },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  try {
    const raw = (await client.sendCommand(
      COMMANDS.LIST_PAGES,
      {},
    )) as {
      docName: string
      results: {
        id: string
        name: string
        isCurrent: boolean
        childCount: number
        /** The page's own agent-authored note, when it has one (I84). */
        context?: string
      }[]
    } | null
    if (raw === null) {
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Failed to get pages from plugin.',
      )
    }

    // I84 — the page's own note, as the CAPPED summary a bounded reader
    // carries (self-describing-nodes.md). The DS census note lives on a PAGE
    // node and `search` never returns a PAGE row — 0 of 1533 on the 2026-09-02
    // artifact, on both scopes — so a reviewer had to reconstruct that note
    // from the operator's transcript to score the census reconciliation at all.
    // `list_pages` is the read that already returns a row per page, so the
    // summary rides there. The RAW note never does: `get_node` on the page id
    // is where it is read in full.
    const rows = (raw.results ?? []).map(page => {
      const { context, ...rest } = page
      const summary = contextSummaryOf(context)
      return summary === undefined
        ? rest
        : { ...rest, contextSummary: summary }
    })

    // T10 — bound the AGENT-CONTEXT: slice the page list to one page.
    let bounded
    try {
      bounded = paginateList(rows, {
        limit,
        cursor,
      })
    } catch (err) {
      if (err instanceof CursorError) {
        return textResult(cursorRejected(err))
      }
      throw err
    }

    const out: {
      docName: string
      results: unknown[]
      truncated: boolean
      cursor?: string
    } = {
      docName: raw.docName,
      results: bounded.page,
      truncated: bounded.truncated,
    }
    if (bounded.cursor !== undefined) {
      out.cursor = bounded.cursor
    }
    return textResult(JSON.stringify(out, null, 2))
  } catch (err) {
    return toolError(err)
  }
}
