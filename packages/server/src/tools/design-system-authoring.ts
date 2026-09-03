// tools/design-system-authoring.ts — the M3-C design-system WRITE tools:
//   create_variables · update_variables · delete_variables · create_styles · update_styles · delete_styles · apply_style
//
// One grammar, the WRITE face (T8): style and variable VALUES are atoms, and the
// SERVER converts each atom to a Figma object before forwarding to the plugin —
// exactly like update_node/create_node (specToFigma). COLOR variable values and
// paint-style values parse via atomToPaint; text via atomToFont; effect via
// atomToEffect; grid via atomToGrid. The plugin only assigns the converted
// objects (loadFontAsync for text styles is the one plugin-side step). Each
// handler routes through formatMutationResult so a plugin-side {error} surfaces
// as an error and a {…,warnings} degrade (T7) is success-with-warning, never a
// throw and never a silent no-op.

import { COMMANDS } from '@figma-agent-bridge/shared'
import type { ScopedFigmaClient } from '../figma-client'
import {
  type StyleCategory,
  HEX_RE,
  styleValueToFigma,
  inferStyleCategory,
  colorValueToRgba,
  hexToRgba,
} from '../serialize/value-convert'
import {
  type ToolResult,
  formatMutationResult,
  errorMessage,
  errorEnvelope,
  toolError,
  pluginError,
  textResult,
} from './shared'
import { classifyMessage } from '../errors'

// ─── create_variables ─────────────────────────────────────────────────────────

type CreateVariableSpec = {
  name: string
  type: 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN'
  valuesByMode: Record<string, string | number | boolean>
  aliases?: Record<string, string>
  scopes?: string[]
  codeSyntax?: Record<string, string>
  hiddenFromPublishing?: boolean
}

/**
 * Add variables to a variable collection, creating the collection when the
 * name is unused. COLOR values are hex atoms parsed server-side to {r,g,b[,a]}
 * (the grammar paint face — hexToRgba); FLOAT/STRING/BOOLEAN pass through as
 * literals. aliases / scopes / codeSyntax / hiddenFromPublishing pass through to
 * the plugin's per-variable apply path (parity with update_variables; each
 * feature-detected + T7-degraded). Returns
 * { collectionId, modes, variables:[{id,name}], warnings }.
 *
 * I63 — the tool used to call createVariableCollection unconditionally, so a
 * second call with the same name forked a duplicate and said nothing. That
 * made a design system whose aliases live beside its raw tokens unbuildable in
 * one pass: an alias needs a target id the first call has not yet returned,
 * and the second call forked instead of appending. The collection is now
 * RESOLVED plugin-side (variable-collection-target.ts) and the reply says
 * which of create / extend happened.
 *
 * The addressing guard lives here rather than in a `.refine()` so the schema
 * keeps `.shape` for registerFileTool, and so a `batch` entry and a direct
 * call face the same rule (the search-handler precedent).
 */
export const handleCreateVariables = async (
  {
    collection,
    collectionId,
    modes,
    variables,
  }: {
    collection?: string
    collectionId?: string
    modes?: string[]
    variables: CreateVariableSpec[]
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  // Exactly one address. Both is a contradiction the plugin would have to
  // rank silently; neither names no collection at all.
  if (
    collection !== undefined &&
    collectionId !== undefined
  ) {
    return errorEnvelope(
      'INVALID_PARAM',
      'create_variables takes `collection` (a name) OR `collectionId` (an exact address), never both. The id addresses one collection and the name looks one up, so a call carrying both states two targets.',
    )
  }
  if (
    collection === undefined &&
    collectionId === undefined
  ) {
    return errorEnvelope(
      'INVALID_PARAM',
      'create_variables needs a collection: pass `collection` (a name — an existing one is EXTENDED, an unused one is created) or `collectionId` (an exact address).',
    )
  }
  try {
    // Parse COLOR valuesByMode to {r,g,b[,a]}; other types pass through.
    // aliases / scopes / codeSyntax / hiddenFromPublishing forward as-is (the
    // plugin applies them through the same per-variable path as update_variables).
    const converted = variables.map(v => ({
      name: v.name,
      type: v.type,
      valuesByMode: Object.fromEntries(
        Object.entries(v.valuesByMode).map(
          ([mode, val]) => [
            mode,
            v.type === 'COLOR'
              ? colorValueToRgba(val)
              : val,
          ],
        ),
      ),
      aliases: v.aliases,
      scopes: v.scopes,
      codeSyntax: v.codeSyntax,
      hiddenFromPublishing: v.hiddenFromPublishing,
    }))

    const result = (await client.sendCommand(
      COMMANDS.CREATE_VARIABLES,
      {
        collection,
        collectionId,
        modes,
        variables: converted,
      },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to create variables.',
    )
  } catch (err) {
    return toolError(err)
  }
}

// ─── update_variables ─────────────────────────────────────────────────────────

type UpdateVariableSpec = {
  id: string
  valuesByMode?: Record<string, string | number | boolean>
  aliases?: Record<string, string>
  scopes?: string[]
  codeSyntax?: Record<string, string>
  hiddenFromPublishing?: boolean
}

/**
 * Mode lifecycle on an existing collection (addModes / removeModes /
 * renameModes) plus per-variable edits. COLOR value edits are parsed
 * server-side; FLOAT/STRING/BOOLEAN pass through. The plugin feature-detects
 * each gated member (addMode/removeMode/renameMode/setValueForMode/scopes/
 * setVariableCodeSyntax/hiddenFromPublishing) and degrades with a warning (T7).
 * Returns { collectionId, modes, warnings[] }.
 */
export const handleUpdateVariables = async (
  {
    collectionId,
    addModes,
    removeModes,
    renameModes,
    variables,
  }: {
    collectionId: string
    addModes?: string[]
    removeModes?: string[]
    renameModes?: { from: string; to: string }[]
    variables?: UpdateVariableSpec[]
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  try {
    // Parse COLOR value edits to {r,g,b[,a]}. The variable's resolved type is
    // not known here, so a value matching a hex atom is parsed; non-hex values
    // (FLOAT/STRING/BOOLEAN) pass through unchanged.
    const convertedVars = variables?.map(v => ({
      ...v,
      valuesByMode:
        v.valuesByMode === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(v.valuesByMode).map(
                ([mode, val]) => [
                  mode,
                  // Only hex-shaped strings are parsed to {r,g,b[,a]}; all other
                  // values (FLOAT/STRING/BOOLEAN, or non-hex strings) pass through
                  // unchanged — unlike create_variables, which errors on a
                  // malformed COLOR hex. Shares HEX_RE so the hex shape is defined
                  // in exactly one place.
                  typeof val === 'string' &&
                  HEX_RE.test(val)
                    ? hexToRgba(val)
                    : val,
                ],
              ),
            ),
    }))

    const result = (await client.sendCommand(
      COMMANDS.UPDATE_VARIABLES,
      {
        collectionId,
        addModes,
        removeModes,
        renameModes,
        variables: convertedVars,
      },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to update variables.',
    )
  } catch (err) {
    return toolError(err)
  }
}

// ─── delete_variables ─────────────────────────────────────────────────────────

/**
 * Delete variables and/or collections by id. Collections are processed first
 * (removing a collection cascades its variables). Partial success (T5): one bad
 * id never sinks the rest. No value-convert touch (T8 — deletes carry no grammar).
 * Returns { results:[{id, kind:'variable'|'collection'}], errors:[{id, error, code}] }.
 */
export const handleDeleteVariables = async (
  {
    variables,
    collections,
  }: {
    variables?: string[]
    collections?: string[]
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  // "At least one non-empty" guard — INVALID_PARAM, not a silent no-op.
  const hasVariables =
    variables !== undefined && variables.length > 0
  const hasCollections =
    collections !== undefined && collections.length > 0
  if (!hasVariables && !hasCollections) {
    return errorEnvelope(
      'INVALID_PARAM',
      'At least one of `variables` or `collections` must be a non-empty array.',
    )
  }
  try {
    const reply = (await client.sendCommand(
      COMMANDS.DELETE_VARIABLES,
      { variables, collections },
    )) as {
      error?: string
      results?: {
        id: string
        kind: 'variable' | 'collection'
      }[]
      errors?: { id: string; error: string }[]
    } | null

    if (reply === null) {
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Failed to delete variables.',
      )
    }
    if (reply.error !== undefined) {
      return pluginError(reply.error)
    }

    const results = reply.results ?? []
    const errors = (reply.errors ?? []).map(e => ({
      ...e,
      code: classifyMessage(e.error),
    }))

    return textResult(
      JSON.stringify({ results, errors }, null, 2),
    )
  } catch (err) {
    return toolError(err)
  }
}

// ─── create_styles ────────────────────────────────────────────────────────────

type CreateStyleSpec = {
  type: StyleCategory
  name: string
  value: string
  description?: string
}

/**
 * Batch-create paint/text/effect/grid styles from grammar atom values with
 * PARTIAL SUCCESS (T5). The SERVER parses each entry's atom for its `type`
 * (paint→atomToPaint, text→atomToFont, effect→atomToEffect, grid→atomToGrid)
 * and forwards the converted array; the plugin loops, creating each style
 * (loadFontAsync first for text) and collecting a per-entry result/error so one
 * failure does NOT abort the rest. A SERVER-side conversion failure (a malformed
 * atom) is isolated to that entry's error and NOT sent to the plugin; a
 * placeholder keeps the sent array index-aligned with the plugin's replies, and
 * every result/error carries its ORIGINAL index. Returns
 * { results:[{id,key,name,type,index}], errors:[{index,error,code}] }.
 */
export const handleCreateStyles = async (
  { styles }: { styles: CreateStyleSpec[] },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  // Convert each entry's atom server-side, in array order. A malformed atom is
  // recorded as that entry's error and NOT sent to the plugin.
  const converted: ({
    index: number
    type: StyleCategory
    name: string
    value: unknown
    description?: string
  } | null)[] = []
  const preErrors: { index: number; error: string }[] = []

  styles.forEach((style, index) => {
    try {
      converted[index] = {
        index,
        type: style.type,
        name: style.name,
        value: styleValueToFigma(style.type, style.value),
        description: style.description,
      }
    } catch (err) {
      converted[index] = null
      preErrors.push({ index, error: errorMessage(err) })
    }
  })

  try {
    const sendable = converted.filter(
      (c): c is NonNullable<(typeof converted)[number]> =>
        c !== null,
    )
    const reply = (await client.sendCommand(
      COMMANDS.CREATE_STYLES,
      { styles: sendable },
    )) as {
      results?: {
        id: string
        key: string
        name: string
        type: StyleCategory
        index: number
      }[]
      errors?: { index: number; error: string }[]
      error?: string
    } | null

    if (reply === null) {
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Failed to create styles.',
      )
    }
    if (reply.error !== undefined) {
      return pluginError(reply.error)
    }

    // Merge the plugin's per-entry results/errors with the server-side
    // conversion errors, keeping each entry's ORIGINAL index.
    const results = reply.results ?? []
    const errors = [...preErrors, ...(reply.errors ?? [])]
      .map(e => ({ ...e, code: classifyMessage(e.error) }))
      .sort((a, b) => a.index - b.index)

    return textResult(
      JSON.stringify({ results, errors }, null, 2),
    )
  } catch (err) {
    return toolError(err)
  }
}

// ─── update_styles ────────────────────────────────────────────────────────────

type UpdateStyleSpec = {
  id?: string
  name?: string
  type?: StyleCategory
  value?: string
  newName?: string
  description?: string
}

/**
 * BATCH-edit existing styles' value / name / description with PARTIAL SUCCESS
 * (T2). Each entry is looked up by `id` OR by `name` + `type` (the plugin
 * resolves). When a `value` is supplied the SERVER infers the category from the
 * atom syntax, parses it to a Figma object, and forwards both the converted
 * value and the inferred `valueType`; the plugin validates the inferred category
 * against the resolved style's actual type and assigns. `newName`/`description`
 * apply directly. One entry's failure does NOT abort the rest. A SERVER-side
 * conversion failure (a malformed atom) is isolated to that entry's error and
 * NOT sent to the plugin (a placeholder keeps the sent array index-aligned), and
 * every result/error carries its ORIGINAL index. The partial-write contract is
 * preserved per entry: a TEXT entry whose name/description committed but whose
 * font value load failed becomes THAT entry's error (the plugin reports the
 * applied name/description in the message). Returns
 * { results:[{id,index}], errors:[{index,error,code}] }.
 */
export const handleUpdateStyles = async (
  { styles }: { styles: UpdateStyleSpec[] },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  // Convert each entry's value atom (if any) server-side, in array order. A
  // malformed atom is recorded as that entry's error and NOT sent to the plugin.
  const converted: (Record<string, unknown> | null)[] = []
  const preErrors: { index: number; error: string }[] = []

  styles.forEach((style, index) => {
    try {
      let convertedValue: unknown
      let valueType: StyleCategory | undefined
      if (style.value !== undefined) {
        valueType = inferStyleCategory(style.value)
        convertedValue = styleValueToFigma(
          valueType,
          style.value,
        )
      }
      converted[index] = {
        index,
        id: style.id,
        name: style.name,
        type: style.type,
        value: convertedValue,
        valueType,
        newName: style.newName,
        description: style.description,
      }
    } catch (err) {
      converted[index] = null
      preErrors.push({ index, error: errorMessage(err) })
    }
  })

  try {
    const sendable = converted.filter(
      (c): c is Record<string, unknown> => c !== null,
    )
    const reply = (await client.sendCommand(
      COMMANDS.UPDATE_STYLES,
      { styles: sendable },
    )) as {
      results?: { id: string; index: number }[]
      errors?: { index: number; error: string }[]
      error?: string
    } | null

    if (reply === null) {
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Failed to update styles.',
      )
    }
    if (reply.error !== undefined) {
      return pluginError(reply.error)
    }

    const results = reply.results ?? []
    const errors = [...preErrors, ...(reply.errors ?? [])]
      .map(e => ({ ...e, code: classifyMessage(e.error) }))
      .sort((a, b) => a.index - b.index)

    return textResult(
      JSON.stringify({ results, errors }, null, 2),
    )
  } catch (err) {
    return toolError(err)
  }
}

// ─── delete_styles ────────────────────────────────────────────────────────────

type DeleteStyleSpec = {
  id?: string
  name?: string
  type?: 'paint' | 'text' | 'effect' | 'grid'
}

/**
 * Delete styles by id OR by name+type (same addressing as update_styles).
 * Pure pass-through with index-tagging: each entry gets an `index` attached so
 * the plugin can reply in index-aligned partial-success shape. No value-convert
 * (T8 — deletes carry no grammar). Returns
 * { results:[{id,index}], errors:[{index,error,code}] }.
 */
export const handleDeleteStyles = async (
  { styles }: { styles: DeleteStyleSpec[] },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  // Tag every entry with its array index so the plugin can reply
  // index-aligned (mirrors handleUpdateStyles's index-tagging).
  const tagged = styles.map((entry, index) => ({
    index,
    id: entry.id,
    name: entry.name,
    type: entry.type,
  }))

  try {
    const reply = (await client.sendCommand(
      COMMANDS.DELETE_STYLES,
      { styles: tagged },
    )) as {
      results?: { id: string; index: number }[]
      errors?: { index: number; error: string }[]
      error?: string
    } | null

    if (reply === null) {
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Failed to delete styles.',
      )
    }
    if (reply.error !== undefined) {
      return pluginError(reply.error)
    }

    const results = reply.results ?? []
    const errors = (reply.errors ?? [])
      .map(e => ({ ...e, code: classifyMessage(e.error) }))
      .sort((a, b) => a.index - b.index)

    return textResult(
      JSON.stringify({ results, errors }, null, 2),
    )
  } catch (err) {
    return toolError(err)
  }
}

// ─── apply_style ──────────────────────────────────────────────────────────────

/**
 * Bind a style to a node field. The plugin maps `field` to the matching async
 * setter (fill→setFillStyleIdAsync, stroke→setStrokeStyleIdAsync,
 * text→setTextStyleIdAsync, effect→setEffectStyleIdAsync,
 * grid→setGridStyleIdAsync), feature-detects it, and degrades with a warning
 * when the setter is unavailable on the node (T7). Returns { id, warnings[] }.
 */
export const handleApplyStyle = async (
  {
    nodeId,
    styleId,
    field,
  }: {
    nodeId: string
    styleId: string
    field: string
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  try {
    const result = (await client.sendCommand(
      COMMANDS.APPLY_STYLE,
      { nodeId, styleId, field },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to apply style.',
    )
  } catch (err) {
    return toolError(err)
  }
}
