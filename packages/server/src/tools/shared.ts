import type { ChannelInfo } from '@figma-agent-bridge/shared'
import {
  APP_VERSION,
  majorMinor,
} from '@figma-agent-bridge/shared'
import type { FigmaClient } from '../figma-client'
import type { CursorError } from '../read/paginate'
import {
  ToolError,
  classify,
  classifyMessage,
  errorMessage,
  type ErrorCode,
} from '../errors'

// Re-exported so the existing importers of `./shared` keep working untouched —
// the classifier itself lives in ../errors (Task 1).
export { errorMessage, ToolError, type ErrorCode }

export type ToolResult = {
  content: { type: 'text'; text: string }[]
}

export const textResult = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
})

// The one "cursor rejected" surface for every bounded list read (T10). A
// STALE/MALFORMED opaque cursor is reported, never silently resumed (T7); every
// list-read handler renders the SAME message so the agent's recovery action
// (re-run the read for a fresh cursor) reads identically everywhere. Returns the
// bare string — callers wrap it with textResult.
export const cursorRejected = (err: CursorError): string =>
  `Cursor rejected (${err.reason}) — re-run the read to get a fresh cursor.`

/** The server-owned typed error envelope, emitted as one JSON text block. */
export const errorEnvelope = (
  code: ErrorCode,
  error: string,
): ToolResult => textResult(JSON.stringify({ error, code }))

/** Classify a caught throwable and render the typed envelope. */
export const toolError = (err: unknown): ToolResult =>
  errorEnvelope(classify(err), errorMessage(err))

/** Classify a plugin `{error}` string and render the typed envelope. */
export const pluginError = (message: string): ToolResult =>
  errorEnvelope(classifyMessage(message), message)

export const formatMutationResult = (
  result: { error?: string } | null,
  failMsg: string,
): ToolResult => {
  if (result === null) {
    return errorEnvelope('PLUGIN_ERROR', failMsg)
  }
  if (result.error !== undefined) {
    return pluginError(result.error)
  }
  return textResult(JSON.stringify(result, null, 2))
}

/**
 * True only for the error envelope — EXACTLY {error, code}. A success payload
 * that happens to carry an `error` key (e.g. a partial-success `errors[]`
 * entry surfaced elsewhere) is not one, which is why this checks the key set
 * rather than sniffing text for a leading "Error".
 */
export const isErrorResult = (r: ToolResult): boolean => {
  const text = r.content[0]?.text ?? ''
  if (!text.startsWith('{')) {
    return false
  }
  try {
    const parsed = JSON.parse(text) as Record<
      string,
      unknown
    >
    const keys = Object.keys(parsed)
    return (
      keys.length === 2 &&
      typeof parsed.error === 'string' &&
      typeof parsed.code === 'string'
    )
  } catch {
    return false
  }
}

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
 *
 * `onJoined` is the change feed's baseline hook, fired ONLY on a successful
 * (auto-)join — the moment the server becomes a recipient of that file's
 * broadcasts. Taking it as a parameter keeps the dependency one-way: this
 * module never imports the feed.
 */
export const requireFile = async (
  client: FigmaClient,
  fileKey: string,
  onJoined?: (
    fileKey: string,
    epoch: string | null,
  ) => void,
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
    client.notifyMismatch(
      match.channel,
      match.version ?? '(none)',
      APP_VERSION,
    )
    return {
      ok: false,
      result: errorEnvelope('INCOMPATIBLE', skew),
    }
  }
  try {
    await client.joinChannel(match.channel, fileKey)
    // change-feed.md — a baseline opens when the server successfully JOINS
    // that file's channel; the epoch is seeded from the registry entry the
    // gate has already resolved, so the buffer's history belongs to a KNOWN
    // connection from its first moment.
    onJoined?.(fileKey, match.epoch ?? null)
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
