import type { ChannelInfo } from '@figma-agent-bridge/shared'
import {
  APP_VERSION,
  majorMinor,
} from '@figma-agent-bridge/shared'
import type { FigmaClient } from '../figma-client'
import type { CursorError } from '../read/paginate'

export type ToolResult = {
  content: { type: 'text'; text: string }[]
}

export const textResult = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
})

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

// The one "cursor rejected" surface for every bounded list read (T10). A
// STALE/MALFORMED opaque cursor is reported, never silently resumed (T7); every
// list-read handler renders the SAME message so the agent's recovery action
// (re-run the read for a fresh cursor) reads identically everywhere. Returns the
// bare string — callers wrap it with textResult.
export const cursorRejected = (err: CursorError): string =>
  `Cursor rejected (${err.reason}) — re-run the read to get a fresh cursor.`

export const formatMutationResult = (
  result: { error?: string } | null,
  failMsg: string,
): ToolResult => {
  if (result === null) {
    return textResult(failMsg)
  }
  if (result.error !== undefined) {
    return textResult(`Error: ${result.error}`)
  }
  return textResult(JSON.stringify(result, null, 2))
}

// The typed error codes the tool contract owns (overview.md → Error envelope).
export type ErrorCode =
  | 'NODE_NOT_FOUND'
  | 'INVALID_PARAM'
  | 'FONT_LOAD_FAILED'
  | 'DISCONNECTED'
  | 'TIMEOUT'
  | 'UNSUPPORTED_NODE_TYPE'
  | 'API_UNAVAILABLE'
  | 'WRONG_EDITOR'
  | 'LIBRARY_UNPUBLISHED'
  | 'WRONG_FILE'
  // B2 skew (extends the overview list; reconciled into the spec in Task 11).
  | 'INCOMPATIBLE'

/** The server-owned typed error envelope, emitted as one JSON text block. */
export const errorEnvelope = (
  code: ErrorCode,
  error: string,
): ToolResult => textResult(JSON.stringify({ error, code }))

/**
 * The addressable identity of a connected file. A saved file uses its stable
 * figma.fileKey; a never-saved file (fileKey === null) is addressed by its
 * session channel, surfaced as a SYNTHETIC fileKey so the required-fileKey
 * contract holds uniformly (Task 6). The plugin's identity guard is a no-op
 * when its own figma.fileKey is null, so stamping the synthetic key is safe.
 */
export const synthKey = (info: ChannelInfo): string =>
  info.fileKey ?? info.channel

/** Human-readable listing of every available file for an ASK error (B3). */
export const listAvailable = (
  available: ChannelInfo[],
): string =>
  available
    .map(c => {
      const label = c.fileName ?? '(unsaved file)'
      return `- ${label} [fileKey: ${synthKey(c)}]`
    })
    .join('\n')

export type FileGate =
  | { ok: true; fileKey: string }
  | { ok: false; result: ToolResult }

/**
 * B2 skew check: returns an actionable INCOMPATIBLE message when a plugin's
 * reported `version` differs from the server on major.minor, else null. A plugin
 * that reports NO version is treated as incompatible (it predates the handshake).
 * `undefined` info-version → incompatible; matching major.minor → null.
 */
export const protocolMismatch = (
  version: string | undefined,
): string | null => {
  if (
    version !== undefined &&
    majorMinor(version) === majorMinor(APP_VERSION)
  ) {
    return null
  }
  const got = version ?? '(none)'
  return (
    `Figma plugin version '${got}' is incompatible with server version ` +
    `'${APP_VERSION}' (major.minor mismatch) — reinstall/update the Figma plugin ` +
    `(or update the MCP server if it is the older side).`
  )
}

/**
 * The one file-addressing gate (B3), run by the withFile wrapper before every
 * file-addressed tool. Resolve `fileKey` → a driveable channel: already joined
 * → ok; available in the registry → AUTO-JOIN; empty registry → DISCONNECTED;
 * present-but-unmatched → WRONG_FILE with the list, asking the agent to choose.
 */
export const requireFile = async (
  client: FigmaClient,
  fileKey: string,
): Promise<FileGate> => {
  if (client.channelFor(fileKey) !== null) {
    return { ok: true, fileKey }
  }
  const available = await client.discover()
  if (available.length === 0) {
    return {
      ok: false,
      result: errorEnvelope(
        'DISCONNECTED',
        'No Figma plugin is connected. Open the file in Figma with the Agent Bridge plugin running, then retry.',
      ),
    }
  }
  const match = available.find(c => synthKey(c) === fileKey)
  if (match === undefined) {
    return {
      ok: false,
      result: errorEnvelope(
        'WRONG_FILE',
        `No available Figma file matches fileKey '${fileKey}'. ` +
          `Choose one of the connected files by its fileKey (never guessing):\n` +
          listAvailable(available),
      ),
    }
  }
  // Watchdog declared this instance dead — fast-fail until it reconnects (fresh
  // connectedAt) or the heartbeat reaps it. connection-liveness.md.
  if (client.isInstanceDead(fileKey, match.connectedAt)) {
    return {
      ok: false,
      result: errorEnvelope(
        'DISCONNECTED',
        `${fileKey} is not responding`,
      ),
    }
  }
  // B2 version gate — MUST live here, not only in connect. Every file tool flows
  // through requireFile; a plugin↔server major.minor skew produces a SILENT 30s
  // timeout (the old plugin never echoes meta.requestId), so refuse LOUDLY before
  // joining/dispatching. Checked against the registry `version` at (auto-)join
  // time; an already-joined file was checked when it joined.
  const skew = protocolMismatch(match.version)
  if (skew !== null) {
    return {
      ok: false,
      result: errorEnvelope('INCOMPATIBLE', skew),
    }
  }
  try {
    await client.joinChannel(match.channel, fileKey)
    return { ok: true, fileKey }
  } catch (err) {
    return {
      ok: false,
      result: errorEnvelope(
        'DISCONNECTED',
        errorMessage(err),
      ),
    }
  }
}
