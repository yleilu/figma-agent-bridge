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
import type { FigmaClient } from '../figma-client'
import { toNodeSpec } from '../serialize/node-spec-reader'
import { truncateTree, isStub } from '../read/truncate-tree'
import { buildMatcher } from '../read/match'
import { projectNode } from '../read/project'
import {
  type ToolResult,
  textResult,
  requireConnected,
  errorMessage,
} from './shared'

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
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const raw = (await client.sendCommand(
      COMMANDS.INSPECT,
      {
        nodeId,
        pageId,
        depth,
      },
    )) as Record<string, unknown> | null
    if (raw === null) {
      return textResult(
        `Node not found: ${nodeId ?? pageId ?? 'selection'}`,
      )
    }

    // Serialize the full tree first; the read model decides what survives.
    const full = toNodeSpec(raw, { depth: -1 })
    const { view, truncated } = truncateTree(full, {
      depth,
      budget,
    })

    const matcher =
      match !== undefined ? buildMatcher(match) : null
    const projected = projectView(
      view,
      { fields, profile },
      matcher,
    )

    return textResult(
      YAML.stringify({ view: projected, truncated }),
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

// ─── get_node (fidelity-first NodeSpec read; NEVER budget-truncated) ───────────

/**
 * Read a single node as a canonical NodeSpec with atom-grammar leaves.
 *
 * Fidelity-first: sends COMMANDS.GET_NODE → toNodeSpec(depth) (children past
 * the boundary collapse to IdStubs; depth=0 default) → projectNode(fields/
 * profile) → YAML. It does NOT route through read/budget — get_node is never
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
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
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
      return textResult(`Node not found: ${nodeId}`)
    }

    const spec = toNodeSpec(raw, { depth: depth ?? 0 })
    const projected = projectNode(spec, { fields, profile })

    return textResult(YAML.stringify(projected))
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
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
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
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
      return textResult('Failed to get nodes from plugin.')
    }

    if (!Array.isArray(raw)) {
      return textResult('Unexpected response from plugin')
    }

    const results: Partial<NodeSpec>[] = []
    const errors: { id: string; error: string }[] = []
    for (const entry of raw) {
      if (
        entry !== null &&
        typeof entry.error === 'string'
      ) {
        errors.push({
          id: (entry.id as string) ?? '',
          error: entry.error,
        })
        continue
      }
      const spec = toNodeSpec(entry, { depth: depth ?? 0 })
      results.push(projectNode(spec, { fields, profile }))
    }

    return textResult(YAML.stringify({ results, errors }))
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

// ─── list_pages (Rule A list read → { docName, results, truncated, cursor? }) ──

/**
 * Enumerate the document's pages. Sends COMMANDS.LIST_PAGES; the plugin returns
 * { docName, results:[{id,name,isCurrent,childCount}] }. The page set is
 * naturally bounded, so the Rule A receipt is always { truncated:false } with
 * no cursor — the uniform list shape is kept for contract symmetry.
 */
export const handleListPages = async (
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

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
      }[]
    } | null
    if (raw === null) {
      return textResult('Failed to get pages from plugin.')
    }

    return textResult(
      YAML.stringify({
        docName: raw.docName,
        results: raw.results,
        truncated: false,
      }),
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
