import { APP_VERSION } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '../figma-client'
import { recordFeedback, type RecordFeedbackInput } from '../feedback-store'
import { type ToolResult, textResult, errorMessage } from './shared'

export const handleRecordFeedback = async (
  params: RecordFeedbackInput,
  client: FigmaClient,
  version: string = APP_VERSION,
): Promise<ToolResult> => {
  try {
    const item = await recordFeedback(params, version)
    client.notify('feedback-added', { item })
    return textResult(`Recorded feedback (${item.category}): ${item.title}`)
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
