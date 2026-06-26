// metadata.ts — node metadata & prototype reads (get_reactions / get_plugin_data)
// plus the handoff annotations read (get_annotations).
//
// All three are degrade-aware (T7): the plugin returns a {warnings:[...]} degrade
// rather than throwing when a node is missing or an API is unavailable / editor-
// gated. The server surfaces those warnings in the emitted object and NEVER
// throws on the degrade path. A plugin-side {error} is surfaced as an error.

import YAML from 'yaml'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '../figma-client'
import { paginateList, CursorError } from '../read/paginate'
import {
  type ToolResult,
  textResult,
  requireConnected,
  formatMutationResult,
  errorMessage,
  cursorRejected,
} from './shared'

// ─── get_reactions ────────────────────────────────────────────────────────────

/**
 * Read a node's prototype reactions. The plugin returns
 * { nodeId, reactions[], warnings? } (a degrade with empty reactions + a warning
 * when the node is missing or has no reactions API). The plugin returns the full
 * doc-bounded list cheaply; the SERVER bounds the AGENT-CONTEXT by paginating it
 * through paginateList (T10) — `limit` defaults to 100, an opaque `cursor`
 * continues when truncated. The degrade `warnings` still ride on the SUCCESS
 * envelope (T7), machine-readable and never thrown.
 */
export const handleGetReactions = async (
  {
    nodeId,
    limit,
    cursor,
  }: { nodeId: string; limit?: number; cursor?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const raw = (await client.sendCommand(
      COMMANDS.GET_REACTIONS,
      { nodeId },
    )) as {
      reactions?: unknown
      warnings?: string[]
      error?: string
    } | null

    if (raw === null) {
      return textResult(
        'Failed to get reactions from plugin.',
      )
    }
    if (raw.error !== undefined) {
      return textResult(`Error: ${raw.error}`)
    }

    const results = (
      Array.isArray(raw.reactions) ? raw.reactions : []
    ) as { id?: string }[]

    // T10 — bound the AGENT-CONTEXT: slice the reactions list to one page.
    let bounded
    try {
      bounded = paginateList(results, { limit, cursor })
    } catch (err) {
      if (err instanceof CursorError) {
        return textResult(cursorRejected(err))
      }
      throw err
    }

    const out: {
      results: unknown[]
      truncated: boolean
      cursor?: string
      warnings?: string[]
    } = {
      results: bounded.page,
      truncated: bounded.truncated,
    }
    if (bounded.cursor !== undefined) {
      out.cursor = bounded.cursor
    }
    // T7 — the degrade warnings ride on the SUCCESS envelope, even when paged.
    if (raw.warnings !== undefined) {
      out.warnings = raw.warnings
    }
    return textResult(YAML.stringify(out))
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

// ─── get_plugin_data ──────────────────────────────────────────────────────────

/**
 * Read a node's plugin data (and shared plugin data when `namespace` is given).
 * The plugin returns { nodeId, pluginData, sharedPluginData?, warnings? } (a
 * degrade with empty pluginData + a warning when the node is missing). This is a
 * plain read — NOT a strict Rule-A list — so the object is emitted as-is, with
 * `warnings` surfaced when present and never thrown.
 */
export const handleGetPluginData = async (
  {
    nodeId,
    namespace,
  }: { nodeId: string; namespace?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const raw = (await client.sendCommand(
      COMMANDS.GET_PLUGIN_DATA,
      { nodeId, namespace },
    )) as {
      nodeId?: string
      pluginData?: Record<string, string>
      sharedPluginData?: Record<string, string>
      warnings?: string[]
      error?: string
    } | null

    if (raw === null) {
      return textResult(
        'Failed to get plugin data from plugin.',
      )
    }
    if (raw.error !== undefined) {
      return textResult(`Error: ${raw.error}`)
    }

    const out: {
      nodeId?: string
      pluginData: Record<string, string>
      sharedPluginData?: Record<string, string>
      warnings?: string[]
    } = {
      nodeId: raw.nodeId,
      pluginData: raw.pluginData ?? {},
    }
    if (raw.sharedPluginData !== undefined) {
      out.sharedPluginData = raw.sharedPluginData
    }
    if (raw.warnings !== undefined) {
      out.warnings = raw.warnings
    }
    return textResult(YAML.stringify(out))
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

// ─── get_annotations (editorType-gated → degrade per T7) ──────────────────────

/**
 * Read a node's (or the current selection's) annotations. The annotations API
 * is editorType-gated, so the plugin degrades to
 * { results:[], warnings:['Annotations API unavailable…'] } rather than throwing
 * when it is absent. The plugin returns the full doc-bounded list cheaply; the
 * SERVER bounds the AGENT-CONTEXT by paginating it through paginateList (T10) —
 * `limit` defaults to 100, an opaque `cursor` continues when truncated. The
 * editorType-gated degrade `warnings` still ride on the SUCCESS envelope (T7),
 * NEVER thrown.
 */
export const handleGetAnnotations = async (
  {
    nodeId,
    limit,
    cursor,
  }: { nodeId?: string; limit?: number; cursor?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const raw = (await client.sendCommand(
      COMMANDS.GET_ANNOTATIONS,
      { nodeId },
    )) as {
      results?: unknown
      warnings?: string[]
      error?: string
    } | null

    if (raw === null) {
      return textResult(
        'Failed to get annotations from plugin.',
      )
    }
    if (raw.error !== undefined) {
      return textResult(`Error: ${raw.error}`)
    }

    const results = (
      Array.isArray(raw.results) ? raw.results : []
    ) as { id?: string }[]

    // T10 — bound the AGENT-CONTEXT: slice the annotations list to one page.
    let bounded
    try {
      bounded = paginateList(results, { limit, cursor })
    } catch (err) {
      if (err instanceof CursorError) {
        return textResult(cursorRejected(err))
      }
      throw err
    }

    const out: {
      results: unknown[]
      truncated: boolean
      cursor?: string
      warnings?: string[]
    } = {
      results: bounded.page,
      truncated: bounded.truncated,
    }
    if (bounded.cursor !== undefined) {
      out.cursor = bounded.cursor
    }
    // T7 — the editorType-gated degrade warnings ride on success, even when paged.
    if (raw.warnings !== undefined) {
      out.warnings = raw.warnings
    }
    return textResult(YAML.stringify(out))
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

// ─── set_plugin_data (twin of get_plugin_data) ────────────────────────────────

/**
 * Write a single plugin-data key on a node (shared plugin data when `namespace`
 * is given). The plugin returns {id} on success or {error} when the node is
 * missing. Routed through formatMutationResult.
 */
export const handleSetPluginData = async (
  {
    nodeId,
    key,
    value,
    namespace,
  }: {
    nodeId: string
    key: string
    value: string
    namespace?: string
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.SET_PLUGIN_DATA,
      { nodeId, key, value, namespace },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to set plugin data.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

// ─── set_reactions (T7; twin of get_reactions) ────────────────────────────────

/**
 * Replace a node's prototype reactions. The plugin feature-detects
 * setReactionsAsync and degrades to {id, warnings:[…]} (T7) rather than
 * throwing when the API is unavailable or the assignment fails; only a missing
 * node yields {error}. formatMutationResult surfaces the degrade warnings as
 * success, the node-not-found error as an error.
 */
export const handleSetReactions = async (
  {
    nodeId,
    reactions,
  }: { nodeId: string; reactions: unknown[] },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.SET_REACTIONS,
      { nodeId, reactions },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to set reactions.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

// ─── set_annotations (T7 editorType-gated; twin of get_annotations) ───────────

/**
 * Replace a node's annotations. The plugin feature-detects the annotations API
 * and degrades to {id, warnings:[…]} (T7) rather than throwing when it is
 * unavailable in the current editor; only a missing node yields {error}.
 * formatMutationResult surfaces the degrade warnings as success.
 */
export const handleSetAnnotations = async (
  {
    nodeId,
    annotations,
  }: { nodeId: string; annotations: unknown[] },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.SET_ANNOTATIONS,
      { nodeId, annotations },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to set annotations.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
