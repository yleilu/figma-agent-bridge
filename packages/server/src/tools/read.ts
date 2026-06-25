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
import {
  toPageLayoutTree,
  truncateChildren,
} from '../parser'
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

export const handleInspectPageLayout = async (
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const raw = (await client.sendCommand(
      'get_page_layout',
      {},
    )) as {
      pageName: string
      frames: Record<string, unknown>[]
    } | null
    if (raw === null) {
      return textResult(
        'Failed to get page layout from plugin.',
      )
    }

    const tree = toPageLayoutTree(raw)

    return textResult(tree)
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

export const handleGetNodes = async (
  { nodeIds, depth }: { nodeIds: string[]; depth?: number },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const raw = (await client.sendCommand('get_nodes', {
      nodeIds,
    })) as Record<string, unknown>[] | null
    if (raw === null) {
      return textResult('Failed to get nodes from plugin.')
    }

    if (!Array.isArray(raw)) {
      return textResult('Unexpected response from plugin')
    }

    const effectiveDepth = depth ?? 3
    const truncated = raw.map(node =>
      truncateChildren(node, effectiveDepth, 0),
    )
    const json = JSON.stringify(truncated, null, 2)

    return textResult(json)
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

export const handleListPages = async (
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const raw = (await client.sendCommand(
      'get_pages',
      {},
    )) as
      | {
          id: string
          name: string
          isCurrent: boolean
          childCount: number
        }[]
      | null
    if (raw === null) {
      return textResult('Failed to get pages from plugin.')
    }

    const header = `# ${raw.length} pages\n\n`
    const yamlStr = YAML.stringify(
      raw.map(p => ({
        id: p.id,
        name: p.name,
        current: p.isCurrent,
        frames: p.childCount,
      })),
    )

    return textResult(header + yamlStr)
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
