// tools/design-system-authoring.ts — the M3-C design-system WRITE tools:
//   create_variables · update_variables · create_styles · update_styles · apply_style
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
import {
  atomToPaint,
  atomToFont,
  atomToEffect,
  hexToRgba,
  atomToGrid,
} from '../grammar'
import type { FigmaClient } from '../figma-client'
import {
  type ToolResult,
  requireConnected,
  formatMutationResult,
  errorMessage,
  textResult,
} from './shared'

type StyleCategory = 'paint' | 'text' | 'effect' | 'grid'

// ─── value conversion (grammar WRITE face) ────────────────────────────────────

/**
 * Convert a style VALUE atom to its Figma object for a KNOWN category. paint →
 * Paint, text → FontName, effect → Effect, grid → LayoutGrid. Throws on a
 * malformed atom (the caller catches and reports an error — never a throw out of
 * the handler).
 */
const styleValueToFigma = (
  category: StyleCategory,
  value: string,
): unknown => {
  switch (category) {
    case 'paint':
      return atomToPaint(value)
    case 'text':
      return atomToFont(value)
    case 'effect':
      return atomToEffect(value)
    case 'grid':
      return atomToGrid(value)
    default:
      throw new Error(`Unknown style category: ${category}`)
  }
}

/**
 * Infer the style category from an atom's syntactic shape. update_styles does
 * not carry a `type` (the style id determines it), so the server infers the
 * category from the head/literal: font(...) → text; shadow/inner-shadow/blur/
 * bg-blur → effect; columns/rows/grid → grid; anything else (bare hex, solid,
 * gradients, image/video/pattern) → paint. The inferred category rides alongside
 * the parsed value so the plugin can validate it against the resolved style's
 * actual type and warn on a mismatch (T7), never apply a wrong-typed value.
 */
/** 6- or 8-char uppercase/lowercase hex (no shorthand) — the grammar's color form. */
const HEX_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/

/**
 * Parse a COLOR variable value (a hex atom) to {r,g,b,a}. Validates the hex
 * shape first so a malformed atom throws a clear error (the handler catches it
 * and reports an error — never a throw out of the handler, never a NaN color).
 */
const colorValueToRgba = (val: unknown): unknown => {
  const s = String(val)
  if (!HEX_RE.test(s)) {
    throw new Error(
      `COLOR variable value must be a 6/8-char hex (e.g. "#3B82F6"); got "${s}"`,
    )
  }
  return hexToRgba(s)
}

const inferStyleCategory = (
  value: string,
): StyleCategory => {
  const head = value.trim().match(/^([A-Za-z-]+)\s*\(/)
  const kind = head?.[1]?.toLowerCase()
  if (kind === 'font') {
    return 'text'
  }
  if (
    kind === 'shadow' ||
    kind === 'inner-shadow' ||
    kind === 'blur' ||
    kind === 'bg-blur'
  ) {
    return 'effect'
  }
  if (
    kind === 'columns' ||
    kind === 'rows' ||
    kind === 'grid'
  ) {
    return 'grid'
  }
  return 'paint'
}

// ─── create_variables ─────────────────────────────────────────────────────────

type CreateVariableSpec = {
  name: string
  type: 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN'
  valuesByMode: Record<string, string | number | boolean>
}

/**
 * Create a variable collection (+ optional extra modes) and its variables with
 * per-mode values. COLOR values are hex atoms parsed server-side to {r,g,b[,a]}
 * (the grammar paint face — hexToRgba); FLOAT/STRING/BOOLEAN pass through as
 * literals. Returns { collectionId, modes, variables:[{id,name}] }.
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
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    // Parse COLOR valuesByMode to {r,g,b[,a]}; other types pass through.
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
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

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

// ─── create_styles ────────────────────────────────────────────────────────────

/**
 * Create one paint/text/effect/grid style from a grammar atom value. The SERVER
 * parses the atom for the given `type` (paint→atomToPaint, text→atomToFont,
 * effect→atomToEffect, grid→atomToGrid) and forwards the converted object; the
 * plugin creates the style and assigns it (loadFontAsync first for text).
 * Returns { id, key, name, type }.
 */
export const handleCreateStyles = async (
  {
    type,
    name,
    value,
    description,
  }: {
    type: StyleCategory
    name: string
    value: string
    description?: string
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const converted = styleValueToFigma(type, value)
    const result = (await client.sendCommand(
      COMMANDS.CREATE_STYLES,
      { type, name, value: converted, description },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to create style.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

// ─── update_styles ────────────────────────────────────────────────────────────

/**
 * Edit an existing style's value / name / description. The style's category is
 * not in the params (the id determines it), so when a `value` is supplied the
 * SERVER infers the category from the atom syntax, parses the value to a Figma
 * object, and forwards both the converted value and the inferred `valueType`.
 * The plugin resolves the style, validates the inferred category against the
 * style's actual type (warns on mismatch, T7), and assigns. name/description
 * apply directly. Returns { id, warnings[] }.
 */
export const handleUpdateStyles = async (
  {
    styleId,
    value,
    name,
    description,
  }: {
    styleId: string
    value?: string
    name?: string
    description?: string
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    let convertedValue: unknown
    let valueType: StyleCategory | undefined
    if (value !== undefined) {
      valueType = inferStyleCategory(value)
      convertedValue = styleValueToFigma(valueType, value)
    }
    const result = (await client.sendCommand(
      COMMANDS.UPDATE_STYLES,
      {
        styleId,
        value: convertedValue,
        valueType,
        name,
        description,
      },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to update style.',
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
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

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
