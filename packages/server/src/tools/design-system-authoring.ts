// tools/design-system-authoring.ts — the M3-C design-system WRITE tools:
//   create_variables · update_variables · delete_variables · create_styles · update_styles · apply_style
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
  textResult,
} from './shared'

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
 * Create a variable collection (+ optional extra modes) and its variables with
 * per-mode values. COLOR values are hex atoms parsed server-side to {r,g,b[,a]}
 * (the grammar paint face — hexToRgba); FLOAT/STRING/BOOLEAN pass through as
 * literals. aliases / scopes / codeSyntax / hiddenFromPublishing pass through to
 * the plugin's per-variable apply path (parity with update_variables; each
 * feature-detected + T7-degraded). Returns
 * { collectionId, modes, variables:[{id,name}], warnings }.
 */
export const handleCreateVariables = async (
  {
    collection,
    modes,
    variables,
  }: {
    collection: string
    modes?: string[]
    variables: CreateVariableSpec[]
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
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
      { collection, modes, variables: converted },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to create variables.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

// ─── update_variables ─────────────────────────────────────────────────────────

type UpdateVariableSpec = {
  id: string
  valuesByMode?: Record<string, string | number | boolean>
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
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

// ─── delete_variables ─────────────────────────────────────────────────────────

/**
 * Delete variables and/or collections by id. Collections are processed first
 * (removing a collection cascades its variables). Partial success (T5): one bad
 * id never sinks the rest. No value-convert touch (T8 — deletes carry no grammar).
 * Returns { results:[{id, kind:'variable'|'collection'}], errors:[{id, error}] }.
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
    return textResult(
      'Error: At least one of `variables` or `collections` must be a non-empty array.',
    )
  }
  try {
    const result = (await client.sendCommand(
      COMMANDS.DELETE_VARIABLES,
      { variables, collections },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to delete variables.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
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
 * { results:[{id,key,name,type,index}], errors:[{index,error}] }.
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
      return textResult('Failed to create styles.')
    }
    if (reply.error !== undefined) {
      return textResult(`Error: ${reply.error}`)
    }

    // Merge the plugin's per-entry results/errors with the server-side
    // conversion errors, keeping each entry's ORIGINAL index.
    const results = reply.results ?? []
    const errors = [
      ...preErrors,
      ...(reply.errors ?? []),
    ].sort((a, b) => a.index - b.index)

    return textResult(
      JSON.stringify({ results, errors }, null, 2),
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
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
 * { results:[{id,index}], errors:[{index,error}] }.
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
      return textResult('Failed to update styles.')
    }
    if (reply.error !== undefined) {
      return textResult(`Error: ${reply.error}`)
    }

    const results = reply.results ?? []
    const errors = [
      ...preErrors,
      ...(reply.errors ?? []),
    ].sort((a, b) => a.index - b.index)

    return textResult(
      JSON.stringify({ results, errors }, null, 2),
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
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
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
