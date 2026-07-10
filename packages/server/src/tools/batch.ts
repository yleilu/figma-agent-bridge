// tools/batch.ts — the one generic batch tool (D3, T5).
//
// `batch({ op?, ops: [ {op?, nodeId, ...params}, ... ] }) → { results, errors[] }`
//
// N WRITE ops over EXISTING targets, executed in ARRAY ORDER with PARTIAL
// SUCCESS — one failing entry does NOT abort the rest. A top-level `op` sets the
// default op for every entry (homogeneous: same op, N targets); each entry may
// override it with its own `op` (heterogeneous). An entry's effective op is
// `entry.op ?? topLevelOp`.
//
// EXECUTION MODEL — one round-trip (the PREFERRED model). The server converts
// each op's params on the grammar WRITE FACE here (reusing the SAME pure
// converters the individual handlers use — specToFigma + value-convert) and
// sends ONE COMMANDS.BATCH carrying the converted ops. The plugin loops the ops
// through its existing command switch (handleCommand acting as dispatchCommand),
// collecting a per-op result/error. So N relay round-trips collapse to 1.
//
// PARTIAL-SUCCESS SHAPE (documented):
//   results: [{ index, op, ok, result?, error?, warnings? }] — one per op, in order
//   errors:  [{ index, op, error }]                   — the failures, summarized
// `warnings?` carries the SAME server-side writer warnings a direct call would
// emit (e.g. update_node per-side stroke collapse), so a batched op is not a
// silent lossy conversion (D3/T7).
// A SERVER-side conversion failure (e.g. a malformed atom) or a missing op is
// recorded as that entry's error WITHOUT being sent to the plugin, and the entry
// is sent as a no-op marker so the plugin's results array stays index-aligned.

import { COMMANDS } from '@figma-agent-bridge/shared'
import type { NodeSpec } from '@figma-agent-bridge/shared/node-spec'
import type { ScopedFigmaClient } from '../figma-client'
import { specToFigma } from '../serialize/node-spec-writer'
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
  errorMessage,
  textResult,
} from './shared'

type BatchEntry = Record<string, unknown> & { op?: string }

/** A converted op ready for the plugin: its command + the plugin-side params. */
type ConvertedOp = {
  op: string
  params: Record<string, unknown>
  /** Server-side lossy-conversion warnings (e.g. per-side stroke collapse). */
  warnings?: string[]
}

/** The per-entry result the server returns to the agent. */
type EntryResult = {
  index: number
  op: string | null
  ok: boolean
  result?: unknown
  error?: string
  /** Server-side writer warnings for this op (D3/T7), when any. */
  warnings?: string[]
}

// ─── per-op param conversion (grammar WRITE face) ──────────────────────────────
//
// Most write ops take their params straight through to the plugin (the same as
// their individual handlers, which do no server-side conversion). The few that
// consume grammar ATOMS convert them here with the SHARED pure converters so the
// behavior is identical to update_node / create_styles / … called directly.

/** Strip the routing `op` key; the rest are the op's own params. */
const opParams = (
  entry: BatchEntry,
): Record<string, unknown> => {
  const rest = { ...entry }
  delete rest.op
  return rest
}

const convertUpdateNode = (
  params: Record<string, unknown>,
  warnings?: string[],
): Record<string, unknown> => {
  const { nodeId, patch } = params as {
    nodeId?: string
    patch?: Partial<NodeSpec>
  }
  // D3/T7: thread the writer warnings sink so a batched update_node surfaces the
  // SAME per-op warnings (e.g. per-side stroke collapse) a direct update_node
  // does — no longer a silent lossy conversion.
  return {
    nodeId,
    spec: specToFigma(patch ?? {}, warnings),
  }
}

const convertCreateStyles = (
  params: Record<string, unknown>,
): Record<string, unknown> => {
  // create_styles is an array-create: convert each entry's value atom and carry
  // the original index (matching the standalone handler's plugin protocol so the
  // plugin loops with partial success).
  const { styles } = params as {
    styles: {
      type: StyleCategory
      name: string
      value: string
      description?: string
    }[]
  }
  return {
    styles: styles.map((s, index) => ({
      index,
      type: s.type,
      name: s.name,
      value: styleValueToFigma(s.type, s.value),
      description: s.description,
    })),
  }
}

const convertUpdateStyles = (
  params: Record<string, unknown>,
): Record<string, unknown> => {
  // update_styles is an array-edit: infer + convert each entry's value atom and
  // carry the original index (matching the standalone handler's plugin protocol
  // so the plugin loops with partial success).
  const { styles } = params as {
    styles: {
      id?: string
      name?: string
      type?: StyleCategory
      value?: string
      newName?: string
      description?: string
    }[]
  }
  return {
    styles: styles.map((s, index) => {
      let convertedValue: unknown
      let valueType: StyleCategory | undefined
      if (s.value !== undefined) {
        valueType = inferStyleCategory(s.value)
        convertedValue = styleValueToFigma(
          valueType,
          s.value,
        )
      }
      return {
        index,
        id: s.id,
        name: s.name,
        type: s.type,
        value: convertedValue,
        valueType,
        newName: s.newName,
        description: s.description,
      }
    }),
  }
}

const convertCreateVariables = (
  params: Record<string, unknown>,
): Record<string, unknown> => {
  const { collection, modes, variables } = params as {
    collection: string
    modes?: string[]
    variables: {
      name: string
      type: 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN'
      valuesByMode: Record<
        string,
        string | number | boolean
      >
    }[]
  }
  const converted = variables.map(v => ({
    name: v.name,
    type: v.type,
    valuesByMode: Object.fromEntries(
      Object.entries(v.valuesByMode).map(([mode, val]) => [
        mode,
        v.type === 'COLOR' ? colorValueToRgba(val) : val,
      ]),
    ),
  }))
  return { collection, modes, variables: converted }
}

const convertUpdateVariables = (
  params: Record<string, unknown>,
): Record<string, unknown> => {
  const {
    collectionId,
    addModes,
    removeModes,
    renameModes,
    variables,
  } = params as {
    collectionId: string
    addModes?: string[]
    removeModes?: string[]
    renameModes?: { from: string; to: string }[]
    variables?: {
      id: string
      valuesByMode?: Record<
        string,
        string | number | boolean
      >
      scopes?: string[]
      codeSyntax?: Record<string, string>
      hiddenFromPublishing?: boolean
    }[]
  }
  const convertedVars = variables?.map(v => ({
    ...v,
    valuesByMode:
      v.valuesByMode === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(v.valuesByMode).map(
              ([mode, val]) => [
                mode,
                typeof val === 'string' && HEX_RE.test(val)
                  ? hexToRgba(val)
                  : val,
              ],
            ),
          ),
  }))
  return {
    collectionId,
    addModes,
    removeModes,
    renameModes,
    variables: convertedVars,
  }
}

/**
 * Ops that need grammar atom → Figma object conversion before the plugin runs.
 * Each converter takes an optional warnings sink so a lossy conversion (e.g.
 * per-side stroke collapse on update_node) surfaces per-op (D3/T7).
 */
const CONVERTERS: Record<
  string,
  (
    params: Record<string, unknown>,
    warnings?: string[],
  ) => Record<string, unknown>
> = {
  [COMMANDS.UPDATE_NODE]: convertUpdateNode,
  [COMMANDS.CREATE_STYLES]: convertCreateStyles,
  [COMMANDS.UPDATE_STYLES]: convertUpdateStyles,
  [COMMANDS.CREATE_VARIABLES]: convertCreateVariables,
  [COMMANDS.UPDATE_VARIABLES]: convertUpdateVariables,
}

/**
 * Convert one entry's params for `op`. Pass-through for ops with no server-side
 * grammar conversion; the CONVERTERS map handles the atom-consuming ones. Throws
 * on a malformed atom (the caller records it as that entry's error). Collects
 * any server-side writer warnings onto the returned op (D3/T7).
 */
const convertOp = (
  op: string,
  entry: BatchEntry,
): ConvertedOp => {
  const params = opParams(entry)
  const convert = CONVERTERS[op]
  const warnings: string[] = []
  const converted = convert
    ? convert(params, warnings)
    : params
  return {
    op,
    params: converted,
    warnings: warnings.length > 0 ? warnings : undefined,
  }
}

// ─── handler ───────────────────────────────────────────────────────────────────

export const handleBatch = async (
  {
    op: defaultOp,
    ops,
  }: { op?: string; ops: BatchEntry[] },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  // Resolve + convert each entry server-side, in array order. A missing op or a
  // malformed atom is recorded as that entry's error and NOT sent to the plugin;
  // a placeholder keeps the sent ops index-aligned with the plugin's replies.
  const converted: (ConvertedOp | null)[] = []
  const preErrors: Record<number, EntryResult> = {}
  const effectiveOps: (string | null)[] = []

  ops.forEach((entry, index) => {
    const op = entry.op ?? defaultOp
    effectiveOps[index] = op ?? null
    if (op === undefined) {
      preErrors[index] = {
        index,
        op: null,
        ok: false,
        error:
          'No op for this entry: set a top-level `op` or a per-entry `op`.',
      }
      converted[index] = null
      return
    }
    try {
      converted[index] = convertOp(op, entry)
    } catch (err) {
      preErrors[index] = {
        index,
        op,
        ok: false,
        error: errorMessage(err),
      }
      converted[index] = null
    }
  })

  try {
    // Send ONE command carrying only the validly-converted ops; the plugin loops
    // them through its command switch and returns a per-op {ok,result|error}.
    const sendable = converted
      .map((c, index) =>
        c === null ? null : { index, ...c },
      )
      .filter(
        (c): c is ConvertedOp & { index: number } =>
          c !== null,
      )

    const pluginReply = (await client.sendCommand(
      COMMANDS.BATCH,
      {
        ops: sendable.map(({ op, params }) => ({
          op,
          params,
        })),
      },
    )) as
      | {
          results?: {
            ok: boolean
            result?: unknown
            error?: string
          }[]
        }
      | { error?: string }
      | null

    if (pluginReply === null) {
      return textResult('Failed to run batch.')
    }
    if (
      'error' in pluginReply &&
      pluginReply.error !== undefined
    ) {
      return textResult(`Error: ${pluginReply.error}`)
    }

    const pluginResults =
      ('results' in pluginReply && pluginReply.results) ||
      []

    // Re-merge the plugin's per-op replies with the server-side pre-errors,
    // restoring original array order. Build the original-index → sent-position
    // map ONCE (O(n)) instead of a findIndex scan per entry (O(n²)).
    const sentPosByIndex = new Map<number, number>()
    sendable.forEach((s, sentPos) => {
      sentPosByIndex.set(s.index, sentPos)
    })
    const results: EntryResult[] = ops.map(
      (_entry, index) => {
        if (preErrors[index] !== undefined) {
          return preErrors[index]
        }
        const sentPos = sentPosByIndex.get(index) ?? -1
        const reply = pluginResults[sentPos] as
          | {
              ok: boolean
              result?: unknown
              error?: string
            }
          | undefined
        const op = effectiveOps[index] ?? null
        // Server-side writer warnings for this op (e.g. update_node per-side
        // stroke collapse), collected during conversion (D3/T7).
        const opWarnings = converted[index]?.warnings
        if (reply === undefined) {
          return {
            index,
            op,
            ok: false,
            error: 'No result returned for this op.',
          }
        }
        if (reply.ok) {
          const entry: EntryResult = {
            index,
            op,
            ok: true,
            result: reply.result,
          }
          if (opWarnings !== undefined) {
            entry.warnings = opWarnings
          }
          return entry
        }
        return { index, op, ok: false, error: reply.error }
      },
    )

    const errors = results
      .filter(r => !r.ok)
      .map(r => ({
        index: r.index,
        op: r.op,
        error: r.error,
      }))

    // batch ALWAYS succeeds at the tool level (D3 partial success): a per-op
    // failure lives inside `errors[]`, not as a top-level `error` key, so this
    // is unconditionally the success path. Serialize it directly rather than
    // routing through formatMutationResult (whose error-key branch can never
    // fire here). The plugin-level {error} short-circuit was already handled
    // above (the `'error' in pluginReply` guard).
    return textResult(
      JSON.stringify({ results, errors }, null, 2),
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
