import type { FigmaClient } from '../figma-client'

export type ToolResult = {
  content: { type: 'text'; text: string }[]
}

export const textResult = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
})

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
