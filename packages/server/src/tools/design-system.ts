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
import type { ScopedFigmaClient } from '../figma-client'
import { paginateList, CursorError } from '../read/paginate'
import { contextSummaryOf } from '../read/context-summary'
import {
  type ToolResult,
  textResult,
  formatMutationResult,
  errorEnvelope,
  toolError,
  pluginError,
  cursorRejected,
} from './shared'

// ─── get_styles (Rule A; the server renders each style VALUE to an atom) ──────

type StyleEntry = {
  id: string
  name: string
  value?: unknown
  description?: string
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
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  try {
    const raw = (await client.sendCommand(
      COMMANDS.GET_STYLES,
      {
        type,
        id,
      },
    )) as (StylesReply & { error?: string }) | null

    if (raw === null) {
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Failed to get styles from plugin.',
      )
    }
    // A style getter that throws plugin-side resolves as {error} (not a WS
    // reject); surface it (T7) instead of swallowing it into an empty list.
    if (raw.error !== undefined) {
      return pluginError(raw.error)
    }

    const results: {
      id: string
      name: string
      type: StyleCategory
      value: unknown
      description?: string
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
          ...(entry.description
            ? { description: entry.description }
            : {}),
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
    return textResult(JSON.stringify(out, null, 2))
  } catch (err) {
    return toolError(err)
  }
}

// ─── get_components (Rule A; key + variant axes + `properties` == write twin) ─

type ComponentEntry = {
  id?: string
  name?: unknown
  key?: string
  type?: string
  page?: string | null
  description?: string
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
 * list shape, and emits JSON.
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
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  try {
    const raw = (await client.sendCommand(
      COMMANDS.GET_COMPONENTS,
      { query, includeRemote },
    )) as {
      local?: unknown
      remote?: unknown
      warnings?: unknown
      scanTruncated?: boolean
      scanned?: number
      found?: number
      error?: string
    } | null

    if (raw === null) {
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Failed to get components from plugin.',
      )
    }
    // A getter that throws plugin-side (e.g. get_variantProperties on a
    // ComponentSet with conflicting variants → "Component set for node has
    // existing errors") resolves as {error}, not a WS reject; surface it (T7)
    // instead of masking it behind the generic "Unexpected response" — the
    // sibling reads get_styles/list_fonts already do this.
    if (raw.error !== undefined) {
      return pluginError(raw.error)
    }

    if (
      !Array.isArray(raw.local) ||
      !Array.isArray(raw.remote)
    ) {
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Unexpected response from plugin',
      )
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

    // Bounded reader: replace each entry's raw `context` with the capped
    // read-only `contextSummary` slice (post-projection, not projectable). The
    // raw value only round-trips via the fidelity reads (get_node/get_nodes).
    const results = [...local, ...remote].map(entry => {
      const summary = contextSummaryOf(
        (entry as { context?: string }).context,
      )
      delete (entry as { context?: unknown }).context
      if (summary !== undefined) {
        ;(
          entry as { contextSummary?: string }
        ).contextSummary = summary
      }
      return entry
    })

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
    const warnings: string[] = Array.isArray(raw.warnings)
      ? (raw.warnings as string[]).slice()
      : []

    // B8 — remote scan budget (T10): when the plugin's instance-scan hit the
    // MAX_INSTANCES budget it sets scanTruncated:true on the reply. Surface a
    // WARNING so the agent knows the remote list is partial and can instruct the
    // user to narrow the query or raise maxInstances.
    if (raw.scanTruncated === true) {
      const budget = raw.scanned ?? 'unknown'
      warnings.push(
        `remote-component scan truncated at ${budget} instances; results may be incomplete — narrow the query or raise maxInstances`,
      )
    }
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
    if (warnings.length > 0) {
      envelope.warnings = warnings
    }

    return textResult(JSON.stringify(envelope, null, 2))
  } catch (err) {
    return toolError(err)
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
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  try {
    const raw = (await client.sendCommand(
      COMMANDS.LIST_FONTS,
      { query },
    )) as { results?: unknown; error?: string } | null

    if (raw === null) {
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Failed to list fonts from plugin.',
      )
    }
    // A thrown listAvailableFontsAsync() resolves as {error} (not a WS reject);
    // surface it (T7) rather than masking a hard failure as "no fonts".
    if (raw.error !== undefined) {
      return pluginError(raw.error)
    }
    // A non-array results payload is a malformed reply, not an empty font set —
    // do not coerce it to [] (which would read as a clean "no fonts available").
    if (!Array.isArray(raw.results)) {
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Unexpected response from plugin',
      )
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
    return textResult(JSON.stringify(out, null, 2))
  } catch (err) {
    return toolError(err)
  }
}

// ─── bind_variable (M2 slice — design-system write, T7; M13 — mode param) ────

/** Mode entry shape for the `mode` param. */
type ModeEntry = {
  modeId?: string
  modeName?: string
  clearMode?: boolean
}

/**
 * Bind a variable to a node field and/or pin a frame to a variable-collection
 * mode (M13 — setExplicitVariableModeForCollection).
 *
 * Routed through formatMutationResult: figma-client.sendCommand ONLY rejects on
 * the WS-level error field, so a plugin-side {error} resolves successfully and
 * would be mistaken for success unless we check result.error. A degrade reply
 * — {id, warnings:[...]} with NO error (e.g. setBoundVariable unavailable, or a
 * non-bindable field) — is reported as success-with-warning, never a throw and
 * never a silent no-op (T7 feature-detect/warn honesty contract).
 *
 * Empty call guard: at least one of {field+variableId, mode} must be present.
 * Enforced here (not in schema .refine()) because .refine() returns ZodEffects
 * which lacks .shape — breaking registerFileTool's spread.
 */
export const handleBindVariable = async (
  {
    nodeId,
    variableId,
    field,
    clear,
    mode,
  }: {
    nodeId: string
    variableId?: string
    field?: string
    clear?: boolean
    mode?: Record<string, ModeEntry>
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  // Empty-call guard: must have a field binding, a field CLEAR, or a mode map.
  const hasFieldBinding =
    variableId !== undefined && field !== undefined
  const hasFieldClear =
    clear === true && field !== undefined
  const hasModeMap =
    mode !== undefined && Object.keys(mode).length > 0
  if (!hasFieldBinding && !hasFieldClear && !hasModeMap) {
    return errorEnvelope(
      'INVALID_PARAM',
      'bind_variable requires at least one of: (variableId + field) for a field binding, ' +
        '(field + clear:true) to remove one, or mode for a mode pin.',
    )
  }
  // `clear` is the INVERSE of a binding, so naming a variable alongside it says
  // two opposite things about the same field. Refuse rather than guess (T7).
  if (clear === true && variableId !== undefined) {
    return errorEnvelope(
      'INVALID_PARAM',
      'bind_variable takes `clear: true` OR `variableId`, never both — one removes the ' +
        'binding on `field` and the other creates it. Drop whichever you did not mean.',
    )
  }
  if (clear === true && field === undefined) {
    return errorEnvelope(
      'INVALID_PARAM',
      'bind_variable `clear: true` needs the `field` to clear (e.g. field: "itemSpacing").',
    )
  }

  try {
    // Build the command params: include field binding keys only when present.
    const params: Record<string, unknown> = { nodeId }
    if (variableId !== undefined) {
      params.variableId = variableId
    }
    if (field !== undefined) {
      params.field = field
    }
    if (clear === true) {
      params.clear = true
    }
    if (mode !== undefined) {
      params.mode = mode
    }

    const result = (await client.sendCommand(
      COMMANDS.BIND_VARIABLE,
      params,
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      `Failed to bind variable${variableId ? ` ${variableId} to ${field ?? ''}` : ''} / mode on node ${nodeId}`,
    )
  } catch (err) {
    return toolError(err)
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

type RawMode = { modeId: string; name: string }

type VariableCollection = {
  id: string
  name: string
  modes?: unknown
  variables?: RawVariable[]
}

/**
 * Translate a plugin-side mode-keyed alias map {modeId: targetId} to the
 * agent-facing shape {modeName: targetId} — the SAME shape create/update_variables
 * consume — using the collection's modes array (T2 read-shape == write-shape).
 * An empty or missing map returns undefined (omitted from output).
 */
const translateAliases = (
  rawAliases: unknown,
  modes: RawMode[],
): Record<string, string> | undefined => {
  if (
    rawAliases === null ||
    rawAliases === undefined ||
    typeof rawAliases !== 'object' ||
    Array.isArray(rawAliases)
  ) {
    return undefined
  }
  const aliasMap = rawAliases as Record<string, string>
  const modeIdToName: Record<string, string> = {}
  for (const m of modes) {
    modeIdToName[m.modeId] = m.name
  }
  const out: Record<string, string> = {}
  for (const [modeId, targetId] of Object.entries(
    aliasMap,
  )) {
    const modeName = modeIdToName[modeId]
    if (modeName !== undefined) {
      out[modeName] = targetId
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
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

/**
 * Render one variable's per-mode values into the shape a WRITE consumes (I70).
 *
 * Two things happen here. COLOR values render to hex atoms (alias refs and
 * FLOAT/STRING/BOOLEAN pass through). And the map is RE-KEYED from the plugin's
 * mode IDs to mode NAMES — the vocabulary `create_variables` and
 * `update_variables` take — so a read feeds a write with no hand-built
 * modeId→name join against the sibling `modes` array. `aliases` was fixed for
 * exactly this in B2 and the same T2 gap was left open one field over.
 *
 * Lossless where the join fails. A value under a mode the collection does not
 * name keeps its raw id key, and so does the SECOND of two modes sharing a
 * name: dropping either to keep the keys uniform would be the silent loss this
 * whole batch exists to remove, and the id is at least something a caller can
 * look up.
 */
const renderVariableValues = (
  valuesByMode: Record<string, unknown> | undefined,
  modes: RawMode[],
): Record<string, unknown> | undefined => {
  if (valuesByMode === undefined) {
    return undefined
  }
  const nameOf: Record<string, string> = {}
  for (const m of modes) {
    nameOf[m.modeId] = m.name
  }
  const out: Record<string, unknown> = {}
  for (const [modeId, value] of Object.entries(
    valuesByMode,
  )) {
    const name = nameOf[modeId]
    const key =
      name !== undefined && !(name in out) ? name : modeId
    out[key] = isRgbaColor(value) ? rgbaToHex(value) : value
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
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  try {
    const raw = (await client.sendCommand(
      COMMANDS.GET_VARIABLES,
      { collectionId },
    )) as { results?: VariableCollection[] } | null

    if (raw === null) {
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Failed to get variables from plugin.',
      )
    }

    const collections = raw.results ?? []
    const results = collections.map(c => {
      // Build modeId→name lookup from the collection's modes array.
      const modes = Array.isArray(c.modes)
        ? (c.modes as RawMode[])
        : []
      return {
        id: c.id,
        name: c.name,
        modes: c.modes,
        variables: (c.variables ?? []).map(v => {
          // B2: translate plugin's mode-keyed {modeId:targetId} → {modeName:targetId}
          // so the read shape matches the write shape consumed by create/update_variables.
          const aliases = translateAliases(v.aliases, modes)
          const entry: Record<string, unknown> = {
            id: v.id,
            name: v.name,
            type: v.resolvedType,
            valuesByMode: renderVariableValues(
              v.valuesByMode,
              modes,
            ),
            scopes: v.scopes,
            codeSyntax: v.codeSyntax,
            hiddenFromPublishing: v.hiddenFromPublishing,
          }
          if (aliases !== undefined) {
            entry.aliases = aliases
          }
          return entry
        }),
      }
    })

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
    return textResult(JSON.stringify(out, null, 2))
  } catch (err) {
    return toolError(err)
  }
}
