// tools/with-file.ts — the file-addressing registration path (B3).
//
// registerFileTool is the ONE way a file-addressed tool reaches server.tool. A
// scoped-client handler `(params, scoped: ScopedFigmaClient)` is structurally
// incompatible with server.tool's `(args, extra: RequestHandlerExtra)` callback,
// so it CANNOT be registered raw — a forgotten wrapper is a COMPILE error, not a
// silent WRONG_FILE. registerSessionTool is the explicit exemption for the 3
// non-file tools (connect / status / record_feedback).

import type {
  McpServer,
  ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
  ZodRawShape,
  ZodTypeAny,
  objectOutputType,
} from 'zod'
import type {
  FigmaClient,
  ScopedFigmaClient,
} from '../figma-client'
import { PluginDisconnectedError } from '../figma-client'
import {
  requireFile,
  errorEnvelope,
  type ToolResult,
} from './shared'

/**
 * The params a FILE-ADDRESSED handler actually receives: the schema's inferred
 * output MINUS the identity fields the withFile wrapper strips into `meta`
 * (`fileKey`, always present via the Task 3 mixin; `sessionId`, reserved). Deriving
 * this from the schema shape `S` binds the handler's param type to its schema, so
 * pairing the wrong handler with a schema is a compile error (see registerFileTool).
 */
type FileHandlerParams<S extends ZodRawShape> = Omit<
  objectOutputType<S, ZodTypeAny>,
  'fileKey' | 'sessionId' | 'agentId' | 'agentType'
>

/**
 * Registration wrapper for every FILE-ADDRESSED tool (B3). Reads `fileKey` from
 * the validated params, gates via requireFile (ASK/error/INCOMPATIBLE on miss),
 * MOVES the identity fields (`fileKey`, `sessionId`) out of the forwarded params
 * into `meta` (via forFile), and calls the handler with a file-scoped client.
 * Exported for direct unit testing; production code registers via registerFileTool.
 */
export const withFile =
  <P extends Record<string, unknown>, R>(
    client: FigmaClient,
    handler: (
      params: P,
      client: ScopedFigmaClient,
    ) => Promise<R>,
  ) =>
  async (
    args: P & {
      fileKey: string
      sessionId?: string
      agentId?: string
      agentType?: string
    },
  ): Promise<R | ToolResult> => {
    const gate = await requireFile(client, args.fileKey)
    if (!gate.ok) {
      return gate.result
    }
    const { fileKey, sessionId, agentId, agentType, ...rest } = args
    const scoped = client.forFile(fileKey, {
      sessionId,
      agentId,
      agentType,
    })
    try {
      return await handler(rest as unknown as P, scoped)
    } catch (e) {
      if (e instanceof PluginDisconnectedError) {
        return errorEnvelope('DISCONNECTED', e.message)
      }
      throw e
    }
  }

/**
 * The one way to register a FILE-ADDRESSED tool. It enforces two contracts:
 *
 *  1. MUST-WRAP (fully enforced): the handler is `ScopedFigmaClient`-typed, so it
 *     cannot reach `server.tool` any other way — its 2nd param is incompatible
 *     with the SDK's `RequestHandlerExtra`. A forgotten wrapper is a compile error.
 *  2. SCHEMA↔HANDLER param binding (PARTIALLY enforced): the handler's param type
 *     is DERIVED from the schema shape `S` (`FileHandlerParams<S>` = the schema
 *     output minus the stripped identity fields), NOT a free generic. So the
 *     DANGEROUS mismatch — a handler that REQUIRES a field the schema doesn't
 *     supply, or types one differently (e.g. component-index's `fileId`) — is a
 *     compile error, because that handler is not assignable to `(params:
 *     FileHandlerParams<S>, …)`.
 *
 *     RESIDUAL GAP (not catchable here): a handler whose params are a loose,
 *     all-OPTIONAL superset of the schema's is still accepted, because TypeScript's
 *     function-parameter contravariance lets a tolerant handler accept a stricter
 *     caller. Concretely `registerFileTool(…, deleteNodeParamsSchema, handleInspect)`
 *     still compiles: handleInspect's params are all optional, so it happily
 *     accepts delete_node's `{ nodeId }`. Making that a compile error needs
 *     invariant param matching, which TS function types don't express without
 *     inference-breaking conditional gymnastics — so the EXACT schema↔handler
 *     pairing is pinned by each tool's per-tool test, not by this type alone.
 *
 * `schema.shape` must already carry fileTargetParamsSchema (Task 3). `R` stays a
 * free type var because not every handler returns a bare `ToolResult` — export
 * returns image content too — so its result is inferred, not pinned to ToolResult.
 */
export const registerFileTool = <S extends ZodRawShape, R>(
  server: McpServer,
  client: FigmaClient,
  name: string,
  schema: { shape: S },
  handler: (
    params: FileHandlerParams<S>,
    client: ScopedFigmaClient,
  ) => Promise<R>,
): void => {
  // The cast is the ONE thing given up: TS can't resolve the withFile closure's
  // param type against `server.tool`'s overloaded ShapeOutput for a generic `S`,
  // so we assert ToolCallback<S>. The schema↔param binding lives on the `handler`
  // parameter and is checked BEFORE this cast; the cast only bridges the wrapper
  // to the SDK signature, it does not erase that binding.
  server.tool(
    name,
    schema.shape,
    withFile(client, handler) as unknown as ToolCallback<S>,
  )
}

/**
 * The escape hatch for the 3 NON-file tools (connect / status / record_feedback):
 * they address the connection, not a per-call file, so they take the REAL client
 * and are NOT gated by requireFile. Naming it explicitly documents the exemption.
 */
export const registerSessionTool = <S extends ZodRawShape>(
  server: McpServer,
  name: string,
  schema: { shape: S },
  handler: ToolCallback<S>,
): void => {
  server.tool(name, schema.shape, handler)
}
