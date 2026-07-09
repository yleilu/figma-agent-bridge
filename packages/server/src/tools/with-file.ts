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
import type { ZodRawShape } from 'zod'
import type {
  FigmaClient,
  ScopedFigmaClient,
} from '../figma-client'
import { requireFile, type ToolResult } from './shared'

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
    args: P & { fileKey: string; sessionId?: string },
  ): Promise<R | ToolResult> => {
    const gate = await requireFile(client, args.fileKey)
    if (!gate.ok) {
      return gate.result
    }
    const { fileKey, sessionId, ...rest } = args
    const scoped = client.forFile(fileKey, { sessionId })
    return handler(rest as unknown as P, scoped)
  }

/**
 * The one way to register a FILE-ADDRESSED tool. The handler is scoped-client
 * typed, so it can ONLY be wired in here (it does not fit server.tool directly).
 * `schema.shape` must already carry fileTargetParamsSchema (Task 3).
 */
export const registerFileTool = <
  S extends ZodRawShape,
  P extends Record<string, unknown>,
  R,
>(
  server: McpServer,
  client: FigmaClient,
  name: string,
  schema: { shape: S },
  handler: (
    params: P,
    client: ScopedFigmaClient,
  ) => Promise<R>,
): void => {
  // withFile turns the scoped-client handler into a single-arg `(args)` callback;
  // server.tool passes the Zod-validated params as `args` and ignores the unused
  // `extra`. The cast bridges a generic-S ShapeOutput (which TS can't resolve
  // against the overload set) to ToolCallback<S>. Enforcement lives at this
  // function's `handler` parameter type — a ScopedFigmaClient handler only fits
  // here, never server.tool directly.
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
