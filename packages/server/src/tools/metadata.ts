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
import {
  type ToolResult,
  textResult,
  requireConnected,
  errorMessage,
} from './shared'

// ─── get_reactions ────────────────────────────────────────────────────────────

/**
 * Read a node's prototype reactions. The plugin returns
 * { nodeId, reactions[], warnings? } (a degrade with empty reactions + a warning
 * when the node is missing or has no reactions API). The server emits the
 * Rule-A list shape { results, truncated:false } and includes `warnings` when
 * present so the degrade is machine-readable, never thrown.
 */
export const handleGetReactions = async (
  { nodeId }: { nodeId: string },
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

    const results = Array.isArray(raw.reactions)
      ? raw.reactions
      : []
    const out: {
      results: unknown[]
      truncated: boolean
      warnings?: string[]
    } = { results, truncated: false }
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
 * { results:[], truncated:false, warnings:['Annotations API unavailable…'] }
 * rather than throwing when it is absent. The server emits the Rule-A shape and
 * surfaces the warning, NEVER throwing on the degrade.
 */
export const handleGetAnnotations = async (
  { nodeId }: { nodeId?: string },
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

    const results = Array.isArray(raw.results)
      ? raw.results
      : []
    const out: {
      results: unknown[]
      truncated: boolean
      warnings?: string[]
    } = { results, truncated: false }
    if (raw.warnings !== undefined) {
      out.warnings = raw.warnings
    }
    return textResult(YAML.stringify(out))
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
