import YAML from 'yaml'
import { COMMANDS } from '@figma-agent-bridge/shared'
import {
  paintToAtom,
  effectToAtom,
  fontToAtom,
  gridToAtom,
  rgbaToHex,
} from '../grammar'
import type {
  FigmaPaint,
  FigmaEffect,
  FigmaFontName,
  FigmaLayoutGrid,
} from '../grammar'
import type { FigmaClient } from '../figma-client'
import {
  type ToolResult,
  textResult,
  requireConnected,
  formatMutationResult,
  errorMessage,
} from './shared'

// ─── get_styles (Rule A; the server renders each style VALUE to an atom) ──────

type StyleEntry = {
  id: string
  name: string
  value?: unknown
}

type StylesReply = {
  paint?: unknown
  text?: unknown
  effect?: unknown
  grid?: unknown
}

const STYLE_CATEGORIES = [
  'paint',
  'text',
  'effect',
  'grid',
] as const
type StyleCategory = (typeof STYLE_CATEGORIES)[number]

// Render a single style VALUE to its view atom. Defensive: a malformed value
// falls back to the raw passthrough so one bad style never crashes the read.
const renderStyleValue = (
  category: StyleCategory,
  value: unknown,
): unknown => {
  if (value === undefined || value === null) {
    return value
  }
  try {
    switch (category) {
      case 'paint':
        return paintToAtom(value as FigmaPaint)
      case 'text':
        return fontToAtom(value as FigmaFontName)
      case 'effect':
        return effectToAtom(value as FigmaEffect)
      case 'grid':
        return gridToAtom(value as FigmaLayoutGrid)
      default:
        return value
    }
  } catch {
    return value
  }
}

const asEntries = (raw: unknown): StyleEntry[] =>
  Array.isArray(raw) ? (raw as StyleEntry[]) : []

/**
 * List local styles. The plugin sends each style's raw VALUE pre-shaped per
 * category ({ paint, text, effect, grid } of { id, name, value }); the SERVER
 * renders each value to a view atom (paint→hex, text→font, effect/grid→head)
 * and flattens into the Rule-A list shape { results, truncated:false }. The
 * `type` / `id` filters are applied server-side; the read is bounded (no cursor).
 */
export const handleGetStyles = async (
  {
    type,
    id,
    cursor,
  }: { type?: string; id?: string; cursor?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const raw = (await client.sendCommand(
      COMMANDS.GET_STYLES,
      {
        type,
        id,
        cursor,
      },
    )) as StylesReply | null

    if (raw === null) {
      return textResult('Failed to get styles from plugin.')
    }

    const results: {
      id: string
      name: string
      type: StyleCategory
      value: unknown
    }[] = []

    for (const category of STYLE_CATEGORIES) {
      if (type !== undefined && type !== category) {
        continue
      }
      for (const entry of asEntries(raw[category])) {
        if (id !== undefined && entry.id !== id) {
          continue
        }
        results.push({
          id: entry.id,
          name: entry.name,
          type: category,
          value: renderStyleValue(category, entry.value),
        })
      }
    }

    return textResult(
      YAML.stringify({ results, truncated: false }),
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

// ─── get_components (Rule A; carries key + variant axes + property defs) ──────

type ComponentEntry = {
  id?: string
  name?: unknown
  key?: string
  type?: string
  page?: string | null
  propertyDefinitions?: unknown[]
  variantAxes?: Record<string, string[]>
  defaults?: Record<string, unknown>
  [k: string]: unknown
}

/**
 * List local + remote components. The plugin builds the rich per-entry shape
 * (key, type, page, propertyDefinitions, variantAxes, defaults); the SERVER
 * applies the case-insensitive substring `query` filter (literal, not glob),
 * flattens local ⧺ remote into the Rule-A list shape, and emits YAML.
 */
export const handleGetComponents = async (
  { query }: { query?: string; cursor?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const raw = (await client.sendCommand(
      COMMANDS.GET_COMPONENTS,
      { query },
    )) as {
      local?: unknown
      remote?: unknown
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

    let local = raw.local as ComponentEntry[]
    let remote = raw.remote as ComponentEntry[]

    if (query !== undefined) {
      const needle = query.toLowerCase()
      const matches = (c: ComponentEntry): boolean =>
        typeof c.name === 'string' &&
        c.name.toLowerCase().includes(needle)
      local = local.filter(matches)
      remote = remote.filter(matches)
    }

    const results = [...local, ...remote]

    return textResult(
      YAML.stringify({ results, truncated: false }),
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

// ─── list_fonts (Rule A; families grouped by the plugin) ──────────────────────

type FontFamily = { family?: unknown; styles?: string[] }

/**
 * List available fonts, grouped by family ({ family, styles }) by the plugin.
 * The SERVER optionally applies the case-insensitive `query` substring filter
 * (double-filtering with the plugin is harmless) and emits the Rule-A shape.
 */
export const handleListFonts = async (
  { query }: { query?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const raw = (await client.sendCommand(
      COMMANDS.LIST_FONTS,
      { query },
    )) as { results?: unknown } | null

    if (raw === null) {
      return textResult('Failed to list fonts from plugin.')
    }

    let results = Array.isArray(raw.results)
      ? (raw.results as FontFamily[])
      : []

    if (query !== undefined) {
      const needle = query.toLowerCase()
      results = results.filter(
        f =>
          typeof f.family === 'string' &&
          f.family.toLowerCase().includes(needle),
      )
    }

    return textResult(
      YAML.stringify({ results, truncated: false }),
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
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

// ─── get_variables (enhanced: scopes/codeSyntax/aliases; COLOR→hex atoms) ──────

type RawVariable = {
  id: string
  name: string
  resolvedType?: string
  valuesByMode?: Record<string, unknown>
  aliases?: unknown
  scopes?: unknown
  codeSyntax?: unknown
  hiddenFromPublishing?: unknown
}

type VariableCollection = {
  id: string
  name: string
  modes?: unknown
  variables?: RawVariable[]
}

// A raw COLOR value is { r,g,b } numeric (optional a). An alias is
// { type:'VARIABLE_ALIAS', id } — preserved intact, never coerced to a hex.
const isRgbaColor = (
  v: unknown,
): v is { r: number; g: number; b: number; a?: number } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Record<string, unknown>).r === 'number' &&
  typeof (v as Record<string, unknown>).g === 'number' &&
  typeof (v as Record<string, unknown>).b === 'number'

const renderVariableValues = (
  valuesByMode: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (valuesByMode === undefined) {
    return undefined
  }
  const out: Record<string, unknown> = {}
  for (const [modeId, value] of Object.entries(
    valuesByMode,
  )) {
    // COLOR values render to hex atoms; alias refs and FLOAT/STRING/BOOLEAN
    // pass through unchanged.
    out[modeId] = isRgbaColor(value)
      ? rgbaToHex(value)
      : value
  }
  return out
}

/**
 * Read local variable collections + variables. The plugin sends per-variable
 * scopes / codeSyntax / hiddenFromPublishing / aliases plus raw valuesByMode;
 * the SERVER renders COLOR valuesByMode to hex atoms (aliases and other types
 * pass through) and projects the enhanced members. No cursor (P4 concern).
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
          valuesByMode: renderVariableValues(
            v.valuesByMode,
          ),
          aliases: v.aliases,
          scopes: v.scopes,
          codeSyntax: v.codeSyntax,
          hiddenFromPublishing: v.hiddenFromPublishing,
        })),
      })),
    )
    return textResult(header + body)
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
