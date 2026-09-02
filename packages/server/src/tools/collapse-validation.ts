// collapse-validation.ts — one line for a validation failure, not 6KB (I87).
//
// Operator-filed 2026-09-02. `create_tree` with a nested FRAME carrying
// `"radius": 18` answered:
//
//   MCP error -32602: Input validation error: Invalid arguments for tool
//   create_tree: [ …~6KB of invalid_union / unionErrors… ]
//
// The cause — `Expected string, received number at
// tree.children.3.children.0.radius` — sat three union levels down and was
// repeated four times, once per branch that also failed. Every branch of a
// union reports the WHOLE subtree it could not accept, so a recursive spec
// schema multiplies one mistake by the depth of the tree.
//
// THE REJECTION IS CORRECT AND IS NOT TOUCHED. B18 ruled that a value atom IS
// a string; `radius: 18` is a real error. What is wrong is that the reply
// buries its own cause, and the asymmetry that produces the mistake —
// `layout.gap`, `size` and `opacity` all take a number — makes the cause worth
// spelling out rather than merely locating.
//
// WHERE IT ATTACHES. The MCP SDK validates a tool's arguments BEFORE the tool
// callback runs, and it takes `error.message` verbatim into the reply
// (`server/mcp.js` → `getParseErrorMessage`, which reads `.message` first).
// Zod's own `.message` is `JSON.stringify(issues)`, which is the dump. So the
// registered schema is wrapped: it parses exactly as before, and on a failure
// its error carries the collapsed sentence as its message. `issues` is left
// untouched — nothing is thrown away, only summarised.

import { ZodError, type ZodIssue } from 'zod'
import type { ZodObject, ZodRawShape } from 'zod'

/** A candidate cause: one concrete issue, and how deep it was found. */
type Candidate = { issue: ZodIssue; depth: number }

/** The union branches an `invalid_union` issue carries, if any. */
const branchesOf = (issue: ZodIssue): ZodError[] => {
  const branches = (issue as { unionErrors?: unknown })
    .unionErrors
  return Array.isArray(branches)
    ? (branches as ZodError[])
    : []
}

/**
 * The DEEPEST concrete issue in a zod error, unions descended.
 *
 * Deepest by PATH LENGTH, because that is the issue that names an actual field
 * of the caller's payload. A union failure at the top says only "none of these
 * shapes matched", which is exactly the sentence that told the operator
 * nothing.
 *
 * Ties keep the FIRST one found: the branches are ordered as the schema
 * declares them, and the first declared branch is the shape the caller most
 * likely meant.
 */
const deepestIssue = (
  error: ZodError,
): ZodIssue | undefined => {
  let best: Candidate | undefined
  const visit = (issues: readonly ZodIssue[]): void => {
    for (const issue of issues) {
      const branches = branchesOf(issue)
      if (branches.length > 0) {
        for (const branch of branches) {
          visit(branch.issues)
        }
        continue
      }
      const depth = issue.path.length
      if (best === undefined || depth > best.depth) {
        best = { issue, depth }
      }
    }
  }
  visit(error.issues)
  return best?.issue
}

/** `tree.children.0.radius` — the path a caller can find in its own payload. */
const pathOf = (issue: ZodIssue): string =>
  issue.path.length === 0
    ? '(the arguments)'
    : issue.path.join('.')

/**
 * The atom rule, spelled out for the mistake that keeps producing it.
 *
 * Only for a string-expected / number-received leaf, because that is the one
 * case where the caller's value is right and its TYPE is wrong, and where
 * writing the same value in quotes is the whole fix. Anything else gets zod's
 * own sentence, which is already specific.
 */
const atomHint = (issue: ZodIssue): string => {
  const invalid = issue as {
    code?: string
    expected?: unknown
    received?: unknown
  }
  if (
    invalid.code !== 'invalid_type' ||
    invalid.expected !== 'string' ||
    invalid.received !== 'number'
  ) {
    return ''
  }
  return ' Every value atom is a string — write it in quotes, e.g. "18".'
}

/**
 * The one line a validation failure is worth.
 *
 * Falls back to zod's own message when there is no issue to name at all, so a
 * shape this does not anticipate still says something rather than nothing.
 */
export const collapsedValidationMessage = (
  error: ZodError,
): string => {
  const issue = deepestIssue(error)
  if (issue === undefined) {
    return error.message
  }
  const { code } = issue as { code?: string }
  const detail =
    code === 'invalid_type'
      ? 'expected ' +
        String((issue as { expected?: unknown }).expected) +
        ', received ' +
        String((issue as { received?: unknown }).received)
      : issue.message
  // The NAMES an `unrecognized_keys` issue carries live on the issue, not in
  // its message — this surface replaces that message with its own sentence
  // about mis-nesting (strict-params.ts), so collapsing without the keys would
  // drop the one thing the caller has to act on.
  const { keys } = issue as { keys?: unknown }
  const named =
    code === 'unrecognized_keys' && Array.isArray(keys)
      ? (keys as unknown[]).map(String).join(', ') + ': '
      : ''
  return (
    pathOf(issue) +
    ': ' +
    named +
    detail +
    '.' +
    atomHint(issue)
  )
}

/** Replace a zod error's MESSAGE, keeping its issues exactly as they are. */
const restated = (error: ZodError): ZodError => {
  const collapsed = new ZodError(error.issues)
  // `message` is a prototype GETTER on ZodError (`JSON.stringify(issues)`), so
  // an own property is what shadows it. The issues ride along untouched for
  // anything that reads them.
  Object.defineProperty(collapsed, 'message', {
    value: collapsedValidationMessage(error),
    enumerable: false,
    configurable: true,
  })
  return collapsed
}

/**
 * The same schema, whose refusals carry one line instead of the dump.
 *
 * A PROTOTYPE WRAPPER, not a re-wrap. `Object.create(schema)` keeps `.shape`,
 * `._def`, `.strict()` and `instanceof` intact — the SDK reads `.shape` to
 * advertise the tool and to decide the schema needs no normalising (B52: a
 * re-wrap silently drops `.strict()`, which once inverted `search` into a
 * match-all). Only the four parse entry points are overridden, and each of
 * them delegates to the original schema, so what validates is unchanged.
 */
export const withCollapsedErrors = <S extends ZodRawShape>(
  schema: ZodObject<S>,
): ZodObject<S> => {
  const wrapped = Object.create(schema) as ZodObject<S>
  type Parse = ZodObject<S>['safeParse']
  type ParseAsync = ZodObject<S>['safeParseAsync']
  const safeParse: Parse = (data, params) => {
    const result = schema.safeParse(data, params)
    return result.success
      ? result
      : { success: false, error: restated(result.error) }
  }
  const safeParseAsync: ParseAsync = async (
    data,
    params,
  ) => {
    const result = await schema.safeParseAsync(data, params)
    return result.success
      ? result
      : { success: false, error: restated(result.error) }
  }
  Object.assign(wrapped, {
    safeParse,
    safeParseAsync,
    parse: (data: unknown, params?: unknown) => {
      const result = safeParse(
        data,
        params as Parameters<Parse>[1],
      )
      if (!result.success) {
        throw result.error
      }
      return result.data
    },
    parseAsync: async (data: unknown, params?: unknown) => {
      const result = await safeParseAsync(
        data,
        params as Parameters<ParseAsync>[1],
      )
      if (!result.success) {
        throw result.error
      }
      return result.data
    },
  })
  return wrapped
}
