import YAML from 'yaml'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '../figma-client'
import { toStylesTree, toComponentsTree } from '../parser'
import {
  type ToolResult,
  textResult,
  requireConnected,
  formatMutationResult,
  errorMessage,
} from './shared'

export const handleInspectStyles = async (
  { type }: { type?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  const raw = (await client.sendCommand(
    'get_styles',
    {},
  )) as {
    paint: Record<string, unknown>[]
    text: Record<string, unknown>[]
    effect: Record<string, unknown>[]
    grid: Record<string, unknown>[]
  } | null

  if (raw === null) {
    return textResult('Failed to get styles from plugin.')
  }

  if (type !== undefined) {
    const validTypes = ['paint', 'text', 'effect', 'grid']
    if (!validTypes.includes(type)) {
      return textResult(
        `Invalid style type: "${type}". Must be one of: ${validTypes.join(', ')}`,
      )
    }

    const filtered = {
      paint: [] as Record<string, unknown>[],
      text: [] as Record<string, unknown>[],
      effect: [] as Record<string, unknown>[],
      grid: [] as Record<string, unknown>[],
      [type]: raw[type as keyof typeof raw],
    }

    return textResult(toStylesTree(filtered))
  }

  return textResult(toStylesTree(raw))
}

export const handleInspectComponents = async (
  { query }: { query?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  const raw = (await client.sendCommand(
    'get_local_components',
    {},
  )) as {
    local: Record<string, unknown>[]
    remote: Record<string, unknown>[]
  } | null

  if (raw === null) {
    return textResult(
      'Failed to get components from plugin.',
    )
  }

  if (
    !Array.isArray(raw.local) ||
    !Array.isArray(raw.remote)
  ) {
    return textResult('Unexpected response from plugin')
  }

  if (query !== undefined) {
    const needle = query.toLowerCase()
    const matches = (c: Record<string, unknown>): boolean =>
      typeof c.name === 'string' &&
      c.name.toLowerCase().includes(needle)
    const filtered = {
      local: raw.local.filter(matches),
      remote: raw.remote.filter(matches),
    }

    return {
      content: [
        { type: 'text', text: toComponentsTree(filtered) },
      ],
    }
  }

  return textResult(toComponentsTree(raw))
}

// ─── bind_variable (M2 slice — design-system write, T7) ───────────────────────

/**
 * Bind a variable to a node field.
 *
 * Routed through formatMutationResult: figma-client.sendCommand ONLY rejects on
 * the WS-level error field, so a plugin-side {error} resolves successfully and
 * would be mistaken for success unless we check result.error. A degrade reply
 * — {id, warnings:[...]} with NO error (e.g. setBoundVariable unavailable, or a
 * non-bindable field) — is reported as success-with-warning, never a throw and
 * never a silent no-op (T7 feature-detect/warn honesty contract).
 */
export const handleBindVariable = async (
  {
    nodeId,
    variableId,
    field,
  }: { nodeId: string; variableId: string; field: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.BIND_VARIABLE,
      { nodeId, variableId, field },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      `Failed to bind variable ${variableId} to ${field}`,
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

// ─── get_variables (minimal — for binding read-back, no cursor) ────────────────

type VariableCollection = {
  id: string
  name: string
  modes?: unknown
  variables?: {
    id: string
    name: string
    resolvedType?: string
    valuesByMode?: Record<string, unknown>
  }[]
}

/**
 * Read local variable collections + variables + valuesByMode. Thin — exists so
 * a binding can be read back (the round-trip then shows the var() wrapper atom
 * on the bound leaf via get_node). No cursor: Rule A pagination is a later
 * fan-out concern, not part of the slice.
 */
export const handleGetVariables = async (
  { collectionId }: { collectionId?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const raw = (await client.sendCommand(
      COMMANDS.GET_VARIABLES,
      { collectionId },
    )) as { results?: VariableCollection[] } | null

    if (raw === null) {
      return textResult(
        'Failed to get variables from plugin.',
      )
    }

    const collections = raw.results ?? []
    const varCount = collections.reduce(
      (n, c) => n + (c.variables?.length ?? 0),
      0,
    )
    const header = `# ${collections.length} collections, ${varCount} variables\n\n`
    const body = YAML.stringify(
      collections.map(c => ({
        id: c.id,
        name: c.name,
        modes: c.modes,
        variables: (c.variables ?? []).map(v => ({
          id: v.id,
          name: v.name,
          type: v.resolvedType,
          valuesByMode: v.valuesByMode,
        })),
      })),
    )
    return textResult(header + body)
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
