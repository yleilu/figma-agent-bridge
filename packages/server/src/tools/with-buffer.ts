// tools/with-buffer.ts — the THIRD registration path (tool-surface.md), a
// sibling of registerFileTool and registerSessionTool. `pull_changes` needs the
// same identity handling (fileKey + the reserved headers) behind a DIFFERENT
// gate: it dispatches nothing to Figma — it drains the server's own memory — so
// it must never return DISCONNECTED / INCOMPATIBLE / TIMEOUT and must never
// auto-join. Its codes are INVALID_PARAM (its own) and WRONG_FILE.

import type {
  McpServer,
  ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
  ZodRawShape,
  ZodTypeAny,
  objectOutputType,
} from 'zod'
import { DRAIN_LIMIT } from '@figma-agent-bridge/shared/change-feed'
import type { FigmaClient } from '../figma-client'
import type { ChangeFeed } from '../change-feed/feed'
import { sessionIdentity } from '../change-feed/session-identity'
import {
  errorEnvelope,
  listAvailable,
  synthKey,
  textResult,
  type ToolResult,
} from './shared'

export type BufferContext = {
  fileKey: string
  feed: ChangeFeed
}

/**
 * The params a BUFFER-ADDRESSED handler actually receives: the schema's
 * inferred output MINUS the identity fields the wrapper strips, exactly as
 * FileHandlerParams does for the file path.
 */
export type BufferHandlerParams<S extends ZodRawShape> =
  Omit<
    objectOutputType<S, ZodTypeAny>,
    'fileKey' | 'sessionId' | 'agentId' | 'agentType'
  >

export const withBuffer =
  <P extends Record<string, unknown>, R>(
    client: FigmaClient,
    feed: ChangeFeed,
    handler: (params: P, ctx: BufferContext) => Promise<R>,
  ) =>
  async (
    args: P & {
      fileKey: string
      sessionId?: string
      agentId?: string
      agentType?: string
    },
  ): Promise<R | ToolResult> => {
    const { fileKey, sessionId, ...rest } = args
    sessionIdentity.remember(sessionId)
    // Belt to zod's `.min(1)` braces — the only path if the schema ever loosens.
    if (
      typeof fileKey !== 'string' ||
      fileKey.length === 0
    ) {
      return errorEnvelope(
        'INVALID_PARAM',
        'fileKey is required (B3) — the server never guesses which file.',
      )
    }
    if (!feed.has(fileKey)) {
      // The B3 obligation this tool DOES carry: never guess which file the
      // agent meant. Discharged by WRONG_FILE, not by the command gate.
      const available = await client.discover()
      if (!available.some(c => synthKey(c) === fileKey)) {
        // Never DISCONNECTED (this tool dispatches nothing) — but an empty
        // registry still cannot be answered with "choose one of:" and a blank
        // list. B3's ask must be answerable to be an ask at all.
        return errorEnvelope(
          'WRONG_FILE',
          available.length === 0
            ? `No Figma file is connected, and no change buffer exists for fileKey '${fileKey}' — ` +
                `there is nothing to drain. Open the file in Figma with the Agent Bridge plugin ` +
                `running; a baseline opens on the first file-addressed call.`
            : `No available Figma file matches fileKey '${fileKey}'. ` +
                `Choose one of the connected files by its fileKey (never guessing):\n` +
                listAvailable(available),
        )
      }
    }
    const stripped = { ...rest } as Record<string, unknown>
    delete stripped.agentId
    delete stripped.agentType
    return handler(stripped as unknown as P, {
      fileKey,
      feed,
    })
  }

/**
 * The one way to register a BUFFER-ADDRESSED tool. Like registerFileTool it
 * derives the handler's param type from the schema shape, so a mismatched
 * schema↔handler pairing is a compile error rather than a runtime surprise.
 */
export const registerBufferTool = <
  S extends ZodRawShape,
  R,
>(
  server: McpServer,
  client: FigmaClient,
  feed: ChangeFeed,
  name: string,
  schema: { shape: S },
  handler: (
    params: BufferHandlerParams<S>,
    ctx: BufferContext,
  ) => Promise<R>,
): void => {
  server.tool(
    name,
    schema.shape,
    withBuffer(
      client,
      feed,
      handler,
    ) as unknown as ToolCallback<S>,
  )
}

/**
 * The drain. `{changes, truncated, state}` — the third output shape under D1:
 * bounded by `limit` + `truncated`, and NO cursor, because a destructive drain
 * has no position to resume from (the buffer's remainder IS the continuation).
 */
export const handlePullChanges = async (
  params: { limit?: number },
  ctx: BufferContext,
): Promise<ToolResult> => {
  const drained = ctx.feed.drain(
    ctx.fileKey,
    params.limit ?? DRAIN_LIMIT,
  )
  // A read must not have a JOIN as a side effect, so an available-but-unwatched
  // file gets this answer, repeated, until a real join opens a baseline.
  const out = drained ?? {
    changes: [],
    truncated: false,
    state: 'no_baseline' as const,
  }
  return textResult(JSON.stringify(out, null, 2))
}
