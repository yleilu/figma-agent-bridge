// report-status.ts — the report_status tool (status-monitor.md).
//
// Fire-and-forget, file-scoped status push: it never calls sendCommand, so it
// never reaches code.ts/figma.* (report_status is NOT in COMMANDS). It just
// asks the scoped client to notify the plugin's channel with a busy record
// carrying the caller-supplied narrative text.

import type { StatusRecord } from '@figma-agent-bridge/shared'
import type { ScopedFigmaClient } from '../figma-client'
import { textResult, type ToolResult } from './shared'

type ReportStatusHandlerParams = {
  text: string
  level?: 'normal' | 'error'
  label?: string
}

/**
 * Build and push a busy StatusRecord for the caller's identity (surfaced on
 * `scoped.identity` by `forFile`). `key` prefers agentId, then sessionId, then
 * the caller-supplied label, then the literal 'agent' — mirroring the relay's
 * merge-by-key contract (status-monitor.md).
 */
export const handleReportStatus = async (
  params: ReportStatusHandlerParams,
  scoped: ScopedFigmaClient,
): Promise<ToolResult> => {
  const id = scoped.identity
  const key =
    id?.agentId ?? id?.sessionId ?? params.label ?? 'agent'
  const record: StatusRecord = {
    key,
    sessionId: id?.sessionId,
    agentId: id?.agentId,
    agentType: id?.agentType,
    label: params.label,
    level: params.level ?? 'normal',
    text: params.text,
    activity: 'busy',
    updatedAt: Date.now(),
  }
  scoped.notifyStatus(record)
  return textResult('ok')
}
