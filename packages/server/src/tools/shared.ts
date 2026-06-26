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

export const requireConnected = (
  client: FigmaClient,
): ToolResult | null =>
  client.isConnected()
    ? null
    : textResult(
        'Not connected to Figma. Use connect tool first.',
      )

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
