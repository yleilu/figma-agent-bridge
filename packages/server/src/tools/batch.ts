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
//   errors:  [{ index, op, error, code }]              — the failures, summarized
// `warnings?` carries the SAME server-side writer warnings a direct call would
// emit (e.g. GRID-only `layout` keys on an H/V mode), so a batched op is not a
// silent lossy conversion (D3/T7).
// A SERVER-side conversion failure (e.g. a malformed atom), a failed entry
// VALIDATION or a missing op is recorded as that entry's error WITHOUT being
// sent to the plugin, and the entry is sent as a no-op marker so the plugin's
// results array stays index-aligned.

import { z } from 'zod'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type {
  NodeSpecPatch,
  SlotEntry,
} from '@figma-agent-bridge/shared/node-spec'
import {
  applyStyleParamsSchema,
  batchOpSchema,
  bindVariableParamsSchema,
  booleanOpParamsSchema,
  cloneNodeParamsSchema,
  combineVariantsParamsSchema,
  createPageParamsSchema,
  createStylesParamsSchema,
  createVariablesParamsSchema,
  deleteNodeParamsSchema,
  deleteStylesParamsSchema,
  deleteVariablesParamsSchema,
  duplicatePageParamsSchema,
  fileTargetParamsSchema,
  flattenParamsSchema,
  groupNodesParamsSchema,
  reorderChildrenParamsSchema,
  reparentNodeParamsSchema,
  setAnnotationsParamsSchema,
  setCurrentPageParamsSchema,
  setFocusParamsSchema,
  setInstanceParamsSchema,
  setPluginDataParamsSchema,
  setReactionsParamsSchema,
  setSelectionParamsSchema,
  swapComponentParamsSchema,
  transformGroupParamsSchema,
  updateComponentParamsSchema,
  updateNodeParamsSchema,
  updateStylesParamsSchema,
  updateVariablesParamsSchema,
} from '@figma-agent-bridge/shared/tool-params'
import type { ScopedFigmaClient } from '../figma-client'
import {
  oneWayClampWarnings,
  slotEntryToFigma,
  specToFigma,
  unknownPatchKeyWarnings,
} from '../serialize/node-spec-writer'
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
  toolError,
  pluginError,
  errorEnvelope,
} from './shared'
import {
  type ErrorCode,
  classify,
  classifyMessage,
} from '../errors'
import {
  createStyleCatalogue,
  resolveStyleReferences,
  sendConvertedWrite,
} from '../serialize/style-refs'

type BatchEntry = Record<string, unknown> & { op?: string }

/** A converted op ready for the plugin: its command + the plugin-side params. */
type ConvertedOp = {
  op: string
  params: Record<string, unknown>
  /** Server-side lossy-conversion warnings (e.g. an unbindable wrapper). */
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

// ─── per-op entry VALIDATION ───────────────────────────────────────────────────
//
// `batchEntrySchema` is `.passthrough()` by design — it cannot know which op an
// entry will route to, so it validates only the routing key and promises that
// "the per-op param shape is enforced where each command already enforces it".
// That enforcement lives in `fileTool(...)` registration (index.ts), which batch
// never goes through: it calls the converters directly. So an entry used to
// reach specToFigma unvalidated and die there as a server-side TypeError,
// reported as PLUGIN_ERROR — the code that means "Figma failed and the server
// cannot say more" — for a request Figma never received.
//
// The fix reuses the op's OWN registered schema rather than re-stating field
// rules here: one contract, so batch cannot drift from the direct call again.

/** The batch op set, as the enum that is its source of truth. */
type BatchOp = z.infer<typeof batchOpSchema>

/**
 * Addressing/identity keys that belong to the CALL, not to an entry: `fileTool`
 * has already validated them off the top-level params. Read off the schema so a
 * new envelope key cannot leave a stale copy here.
 */
const CALL_KEYS = Object.keys(fileTargetParamsSchema.shape)

/** An op's registered param schema, reduced to what a batch ENTRY carries. */
const entrySchema = (
  schema: z.AnyZodObject,
): z.AnyZodObject => {
  const shape: z.ZodRawShape = { ...schema.shape }
  for (const key of CALL_KEYS) {
    delete shape[key]
  }
  return z.object(shape)
}

/**
 * Every op `batch` accepts → the schema `index.ts` registers for that op.
 * TOTAL BY TYPE: the key type is the `batchOpSchema` enum itself, so adding an
 * op to that enum without wiring its schema here is a compile error, not a
 * silent return to the unvalidated path. "batch entry validation covers every
 * op" in batch.test.ts asserts the same thing at runtime.
 */
export const BATCH_ENTRY_SCHEMAS: Record<
  BatchOp,
  z.AnyZodObject
> = {
  [COMMANDS.UPDATE_NODE]: entrySchema(
    updateNodeParamsSchema,
  ),
  [COMMANDS.DELETE_NODE]: entrySchema(
    deleteNodeParamsSchema,
  ),
  [COMMANDS.SET_SELECTION]: entrySchema(
    setSelectionParamsSchema,
  ),
  [COMMANDS.SET_FOCUS]: entrySchema(setFocusParamsSchema),
  [COMMANDS.REPARENT_NODE]: entrySchema(
    reparentNodeParamsSchema,
  ),
  [COMMANDS.REORDER_CHILDREN]: entrySchema(
    reorderChildrenParamsSchema,
  ),
  [COMMANDS.CLONE_NODE]: entrySchema(cloneNodeParamsSchema),
  [COMMANDS.BOOLEAN_OP]: entrySchema(booleanOpParamsSchema),
  [COMMANDS.FLATTEN]: entrySchema(flattenParamsSchema),
  [COMMANDS.GROUP_NODES]: entrySchema(
    groupNodesParamsSchema,
  ),
  [COMMANDS.TRANSFORM_GROUP]: entrySchema(
    transformGroupParamsSchema,
  ),
  [COMMANDS.APPLY_STYLE]: entrySchema(
    applyStyleParamsSchema,
  ),
  [COMMANDS.UPDATE_COMPONENT]: entrySchema(
    updateComponentParamsSchema,
  ),
  [COMMANDS.COMBINE_VARIANTS]: entrySchema(
    combineVariantsParamsSchema,
  ),
  [COMMANDS.SWAP_COMPONENT]: entrySchema(
    swapComponentParamsSchema,
  ),
  [COMMANDS.SET_INSTANCE]: entrySchema(
    setInstanceParamsSchema,
  ),
  [COMMANDS.BIND_VARIABLE]: entrySchema(
    bindVariableParamsSchema,
  ),
  [COMMANDS.CREATE_STYLES]: entrySchema(
    createStylesParamsSchema,
  ),
  [COMMANDS.UPDATE_STYLES]: entrySchema(
    updateStylesParamsSchema,
  ),
  [COMMANDS.DELETE_STYLES]: entrySchema(
    deleteStylesParamsSchema,
  ),
  [COMMANDS.CREATE_VARIABLES]: entrySchema(
    createVariablesParamsSchema,
  ),
  [COMMANDS.UPDATE_VARIABLES]: entrySchema(
    updateVariablesParamsSchema,
  ),
  [COMMANDS.DELETE_VARIABLES]: entrySchema(
    deleteVariablesParamsSchema,
  ),
  [COMMANDS.SET_PLUGIN_DATA]: entrySchema(
    setPluginDataParamsSchema,
  ),
  [COMMANDS.SET_REACTIONS]: entrySchema(
    setReactionsParamsSchema,
  ),
  [COMMANDS.SET_ANNOTATIONS]: entrySchema(
    setAnnotationsParamsSchema,
  ),
  [COMMANDS.CREATE_PAGE]: entrySchema(
    createPageParamsSchema,
  ),
  [COMMANDS.SET_CURRENT_PAGE]: entrySchema(
    setCurrentPageParamsSchema,
  ),
  [COMMANDS.DUPLICATE_PAGE]: entrySchema(
    duplicatePageParamsSchema,
  ),
}

/**
 * `op` is batch's ROUTING key, so an op whose own params also carry a field
 * called `op` (only `boolean_op`) cannot express it in an entry — the router
 * consumes the key. Say so instead of reporting a bare "op: Required" at an
 * agent that plainly supplied one.
 */
const ROUTING_KEY_NOTE =
  "`op` is batch's routing key, so this op's own `op` param cannot be carried in an entry — call the tool directly."

/**
 * Parse one entry against its op's registered schema. Returns the message
 * naming the offending field(s), or null when the entry is well-formed. The
 * caller records a failure as that entry's INVALID_PARAM error and never sends
 * it to the plugin — one bad entry does not abort its siblings (D3).
 */
const validateEntry = (
  op: string,
  params: Record<string, unknown>,
): string | null => {
  const schema = BATCH_ENTRY_SCHEMAS[op as BatchOp] as
    | z.AnyZodObject
    | undefined
  if (schema === undefined) {
    return `Unknown op "${op}".`
  }
  const parsed = schema.safeParse(params)
  if (parsed.success) {
    return null
  }
  const issues = parsed.error.errors
    .map(issue => {
      const where = issue.path.join('.')
      return where === ''
        ? issue.message
        : `${where}: ${issue.message}`
    })
    .join('; ')
  const routingCollision = parsed.error.errors.some(
    issue =>
      issue.path.length === 1 && issue.path[0] === 'op',
  )
  return `Invalid ${op} params — ${issues}.${
    routingCollision ? ` ${ROUTING_KEY_NOTE}` : ''
  }`
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
    patch?: NodeSpecPatch
  }
  // D3/T7: thread the writer warnings sink so a batched update_node surfaces the
  // SAME per-op warnings (e.g. GRID-only layout keys, an unknown patch key)
  // a direct update_node does — no longer a silent lossy conversion.
  const spec = specToFigma(patch ?? {}, warnings, nodeId)
  warnings?.push(
    ...unknownPatchKeyWarnings(patch ?? {}, spec),
  )
  // B57 — the one-way min/max clamp note, so a batched update says exactly
  // what a direct one says. A batch is where a family gets re-floored.
  warnings?.push(...oneWayClampWarnings(patch ?? {}))
  return { nodeId, spec }
}

const convertUpdateComponent = (
  params: Record<string, unknown>,
  warnings?: string[],
): Record<string, unknown> => {
  // B30: a slot entry may carry a spec, and a batched update_component must
  // convert it on the SAME write face the standalone handler uses — otherwise
  // atom strings would reach the plugin as-is and be assigned raw.
  const { slots } = params as { slots?: SlotEntry[] }
  if (slots === undefined) {
    return params
  }
  return {
    ...params,
    slots: slots.map(entry =>
      slotEntryToFigma(entry, warnings),
    ),
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

const convertDeleteStyles = (
  params: Record<string, unknown>,
): Record<string, unknown> => {
  // A delete carries no grammar (T8 — nothing to convert), which is why this
  // op reached batch with no converter at all. But CONVERTERS also carries the
  // INDEX-TAGGING the plugin's index-aligned reply depends on: it answers
  // {results:[{id,index}], errors:[{index,error}]} built from `entry.index`,
  // so an untagged entry comes back with index undefined and JSON.stringify
  // drops it. The agent then cannot map one style's failure back to its input
  // (tool-surface.md:371). The standalone handleDeleteStyles tags them; this
  // makes the batch path agree.
  const { styles } = params as {
    styles: Record<string, unknown>[]
  }
  if (!Array.isArray(styles)) {
    return params
  }
  return {
    ...params,
    styles: styles.map((entry, index) => ({
      index,
      ...entry,
    })),
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
 * a `var()` wrapper the surface cannot bind) surfaces per-op (D3/T7).
 */
const CONVERTERS: Record<
  string,
  (
    params: Record<string, unknown>,
    warnings?: string[],
  ) => Record<string, unknown>
> = {
  [COMMANDS.UPDATE_NODE]: convertUpdateNode,
  [COMMANDS.UPDATE_COMPONENT]: convertUpdateComponent,
  [COMMANDS.CREATE_STYLES]: convertCreateStyles,
  [COMMANDS.UPDATE_STYLES]: convertUpdateStyles,
  [COMMANDS.DELETE_STYLES]: convertDeleteStyles,
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
  // Resolve, VALIDATE and convert each entry server-side, in array order. A
  // missing op, an entry its op's schema rejects, or a malformed atom is
  // recorded as that entry's error and NOT sent to the plugin; a placeholder
  // keeps the sent ops index-aligned with the plugin's replies.
  const converted: (ConvertedOp | null)[] = []
  const preErrors: Record<number, EntryResult> = {}
  // Codes for pre-errors that already KNOW their classification. Kept beside
  // the results rows rather than inside them: an entry's result shape is
  // {index,op,ok,result?,error?,warnings?} and the code belongs to errors[].
  const preErrorCodes: Record<number, ErrorCode> = {}
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
    // Validate BEFORE converting: a field the op's schema rejects would
    // otherwise reach the pure converters and fail as an opaque server-side
    // TypeError classified PLUGIN_ERROR.
    const invalid = validateEntry(op, opParams(entry))
    if (invalid !== null) {
      preErrors[index] = {
        index,
        op,
        ok: false,
        error: invalid,
      }
      preErrorCodes[index] = 'INVALID_PARAM'
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
      // A converter that raised a TYPED failure (a styled field written as a
      // mix, an over-cap context) already knows its code; classifying its
      // message afterwards would blame Figma for the agent's parameters.
      preErrorCodes[index] = classify(err)
      converted[index] = null
    }
  })

  // The styled-field references, resolved against ONE read of the file's
  // styles for the whole batch — before any op reaches the document. Batch runs
  // the gate PER OP rather than only on the way out, because partial success
  // needs the failure attributed to its own entry: a reference that resolves to
  // nothing (or to a style of the wrong type for the slot) fails ITS OWN entry,
  // exactly as a malformed atom does, and the rest of the batch still runs
  // (D3). The same catalogue then rides out through sendConvertedWrite below,
  // where the ops it already cleared are a no-op walk.
  const catalogue = createStyleCatalogue(client)
  for (const [index, op] of converted.entries()) {
    if (op === null) {
      continue
    }
    const opWarnings = op.warnings ?? []
    try {
      await resolveStyleReferences(
        op.params,
        catalogue,
        opWarnings,
      )
      if (opWarnings.length > 0) {
        op.warnings = opWarnings
      }
    } catch (err) {
      preErrors[index] = {
        index,
        op: effectiveOps[index] ?? null,
        ok: false,
        error: errorMessage(err),
      }
      preErrorCodes[index] = classify(err)
      converted[index] = null
    }
  }

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

    const pluginReply = (await sendConvertedWrite(
      client,
      COMMANDS.BATCH,
      {
        ops: sendable.map(({ op, params }) => ({
          op,
          params,
        })),
      },
      { catalogue },
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
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Failed to run batch.',
      )
    }
    if (
      'error' in pluginReply &&
      pluginReply.error !== undefined
    ) {
      return pluginError(pluginReply.error)
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
        // Server-side writer warnings for this op (e.g. update_node GRID-only
        // layout keys on an H/V mode), collected during conversion (D3/T7).
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
        // A pre-error the server raised itself already knows its code; only a
        // message from the plugin (or a converter throw) needs classifying.
        code:
          preErrorCodes[r.index] ??
          classifyMessage(r.error ?? ''),
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
    return toolError(err)
  }
}
