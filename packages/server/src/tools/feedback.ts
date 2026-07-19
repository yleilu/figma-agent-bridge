import { APP_VERSION } from '@figma-agent-bridge/shared'
import {
  recordFeedback,
  type RecordFeedbackInput,
} from '../feedback-store'
import {
  type ToolResult,
  textResult,
  errorMessage,
} from './shared'

export const handleRecordFeedback = async (
  params: RecordFeedbackInput,
  version: string = APP_VERSION,
): Promise<ToolResult> => {
  try {
    const item = await recordFeedback(params, version)
    return textResult(
      `Recorded feedback (${item.category}): ${item.title}`,
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
