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
import { paginateList, CursorError } from '../read/paginate'
import {
  type ToolResult,
  textResult,
  requireConnected,
  formatMutationResult,
  errorMessage,
  cursorRejected,
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
 * and flattens into the Rule-A list shape. The `type` / `id` filters are applied
 * server-side. The plugin returns the full doc-bounded list cheaply; the SERVER
 * bounds the AGENT-CONTEXT by paginating the rendered list through paginateList
 * (T10) — `limit` defaults to 100, an opaque `cursor` continues when truncated.
 */
export const handleGetStyles = async (
  {
    type,
    id,
    limit,
    cursor,
  }: {
    type?: string
    id?: string
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
    const raw = (await client.sendCommand(
      COMMANDS.GET_STYLES,
      {
        type,
        id,
      },
    )) as (StylesReply & { error?: string }) | null

    if (raw === null) {
      return textResult('Failed to get styles from plugin.')
    }
    // A style getter that throws plugin-side resolves as {error} (not a WS
    // reject); surface it (T7) instead of swallowing it into an empty list.
    if (raw.error !== undefined) {
      return textResult(`Error: ${raw.error}`)
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

    // T10 — bound the AGENT-CONTEXT: slice the rendered list to one page.
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
    } = {
      results: bounded.page,
      truncated: bounded.truncated,
    }
    if (bounded.cursor !== undefined) {
      out.cursor = bounded.cursor
    }
    return textResult(YAML.stringify(out))
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

// ─── get_components (Rule A; key + variant axes + `properties` == write twin) ─

type ComponentEntry = {
  id?: string
  name?: unknown
  key?: string
  type?: string
  page?: string | null
  // `properties`: the SAME {id,name,type,defaultValue,variantOptions?} array
  // shape + key update_component emits (read == write, T2).
  properties?: unknown[]
  variantAxes?: Record<string, string[]>
  defaults?: Record<string, unknown>
  [k: string]: unknown
}

/**
 * List local + remote components. The plugin builds the rich per-entry shape
 * (key, type, page, `properties` [== update_component's property array, T2],
 * variantAxes, defaults); the SERVER applies the case-insensitive substring
 * `query` filter (literal, not glob), flattens local ⧺ remote into the Rule-A
 * list shape, and emits YAML.
 *
 * T10 — two layers of bounding:
 *  - `includeRemote` (default **false**) is threaded to the plugin and gates the
 *    O(document) all-instances remote-discovery scan (walk every INSTANCE's
 *    mainComponent to index library mains). That scan timed out live on a real
 *    UI-kit document; making it opt-in is the primary fix. Default false → the
 *    plugin returns only the cheap LOCAL component/set scan, `remote` is empty.
 *  - `limit`/`cursor` page the flattened list SERVER-side via `paginateList`
 *    (the same helper the other bounded list reads use). The plugin returns its
 *    full (local-only by default) list; the server bounds the agent context.
 */
export const handleGetComponents = async (
  {
    query,
    includeRemote = false,
    limit,
    cursor,
  }: {
    query?: string
    includeRemote?: boolean
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
    const raw = (await client.sendCommand(
      COMMANDS.GET_COMPONENTS,
      { query, includeRemote },
    )) as {
      local?: unknown
      remote?: unknown
      warnings?: unknown
      error?: string
    } | null

    if (raw === null) {
      return textResult(
        'Failed to get components from plugin.',
      )
    }
    // A getter that throws plugin-side (e.g. get_variantProperties on a
    // ComponentSet with conflicting variants → "Component set for node has
    // existing errors") resolves as {error}, not a WS reject; surface it (T7)
    // instead of masking it behind the generic "Unexpected response" — the
    // sibling reads get_styles/list_fonts already do this.
    if (raw.error !== undefined) {
      return textResult(`Error: ${raw.error}`)
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

    // T10 — bound the flattened list to one page server-side (same helper as the
    // other list reads). A STALE/MALFORMED cursor is surfaced cleanly, never
    // silently resumed.
    let bounded
    try {
      bounded = paginateList(results, { limit, cursor })
    } catch (err) {
      if (err instanceof CursorError) {
        return textResult(cursorRejected(err))
      }
      throw err
    }

    // Bug A degrade (T7): when one malformed set throws during the plugin's
    // per-set variant projection, that set degrades to a warning and the rest
    // still return. The warnings[] rides on the SUCCESS envelope (never thrown);
    // a clean read carries no `warnings` key.
    const warnings = Array.isArray(raw.warnings)
      ? (raw.warnings as string[])
      : undefined
    const envelope: {
      results: unknown[]
      truncated: boolean
      cursor?: string
      warnings?: string[]
    } = {
      results: bounded.page,
      truncated: bounded.truncated,
    }
    if (bounded.cursor !== undefined) {
      envelope.cursor = bounded.cursor
    }
    if (warnings !== undefined && warnings.length > 0) {
      envelope.warnings = warnings
    }

    return textResult(YAML.stringify(envelope))
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

// ─── list_fonts (Rule A; families grouped by the plugin) ──────────────────────

// `id?` is declared (even though the plugin keys fonts by `family`, not `id`)
// only so FontFamily is structurally assignable to paginateList's
// `{ id?: string }` constraint. With no `id`, the cursor's version stamp falls
// back to the list LENGTH (the joined-empty-ids hash differs by entry count),
// so a changed font set is still reported STALE — fonts rarely change mid-read.
type FontFamily = {
  id?: string
  family?: unknown
  styles?: string[]
}

/**
 * List available fonts, grouped by family ({ family, styles }) by the plugin.
 * The SERVER optionally applies the case-insensitive `query` substring filter
 * (double-filtering with the plugin is harmless) and emits the Rule-A shape. The
 * host font list is large, so the SERVER bounds the AGENT-CONTEXT by paginating
 * the POST-FILTER list through paginateList (T10) — `limit` defaults to 100, an
 * opaque `cursor` continues when truncated.
 */
export const handleListFonts = async (
  {
    query,
    limit,
    cursor,
  }: { query?: string; limit?: number; cursor?: string },
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
    )) as { results?: unknown; error?: string } | null

    if (raw === null) {
      return textResult('Failed to list fonts from plugin.')
    }
    // A thrown listAvailableFontsAsync() resolves as {error} (not a WS reject);
    // surface it (T7) rather than masking a hard failure as "no fonts".
    if (raw.error !== undefined) {
      return textResult(`Error: ${raw.error}`)
    }
    // A non-array results payload is a malformed reply, not an empty font set —
    // do not coerce it to [] (which would read as a clean "no fonts available").
    if (!Array.isArray(raw.results)) {
      return textResult('Unexpected response from plugin')
    }

    let results = raw.results as FontFamily[]

    if (query !== undefined) {
      const needle = query.toLowerCase()
      results = results.filter(
        f =>
          typeof f.family === 'string' &&
          f.family.toLowerCase().includes(needle),
      )
    }

    // T10 — bound the AGENT-CONTEXT: page the POST-FILTER list (the slice is
    // over the filtered families, not the raw host list).
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
    } = {
      results: bounded.page,
      truncated: bounded.truncated,
    }
    if (bounded.cursor !== undefined) {
      out.cursor = bounded.cursor
    }
    return textResult(YAML.stringify(out))
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
 * pass through), projects the enhanced members, and wraps them in the Rule-A
 * list envelope — the SAME shape as the shipped sibling reads (get_styles /
 * get_components / list_fonts). The plugin returns the full collection list
 * cheaply; the SERVER bounds the AGENT-CONTEXT by paginating the top-level
 * COLLECTIONS list through paginateList (T10) — `limit` defaults to 100, an
 * opaque `cursor` continues when truncated.
 */
export const handleGetVariables = async (
  {
    collectionId,
    limit,
    cursor,
  }: {
    collectionId?: string
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
    const results = collections.map(c => ({
      id: c.id,
      name: c.name,
      modes: c.modes,
      variables: (c.variables ?? []).map(v => ({
        id: v.id,
        name: v.name,
        type: v.resolvedType,
        valuesByMode: renderVariableValues(v.valuesByMode),
        aliases: v.aliases,
        scopes: v.scopes,
        codeSyntax: v.codeSyntax,
        hiddenFromPublishing: v.hiddenFromPublishing,
      })),
    }))

    // T10 — bound the AGENT-CONTEXT: page the top-level collections list.
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
    } = {
      results: bounded.page,
      truncated: bounded.truncated,
    }
    if (bounded.cursor !== undefined) {
      out.cursor = bounded.cursor
    }
    return textResult(YAML.stringify(out))
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
