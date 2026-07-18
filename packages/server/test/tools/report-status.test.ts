// report-status.test.ts — the report_status tool (status-monitor.md).
//
// Handler-level unit tests: assert the pushed StatusRecord shape and the
// key-fallback order (agentId > sessionId > label > 'agent').

import { describe, expect, it } from 'bun:test'
import type { StatusRecord } from '@figma-agent-bridge/shared'
import type { ScopedFigmaClient } from '@figma-agent-bridge/server/figma-client'
import { handleReportStatus } from '@figma-agent-bridge/server/tools/report-status'

const stubScoped = (
  identity?: ScopedFigmaClient['identity'],
): {
  scoped: ScopedFigmaClient
  pushed: StatusRecord[]
} => {
  const pushed: StatusRecord[] = []
  return {
    scoped: {
      fileKey: 'fk',
      identity,
      notifyStatus: record => {
        pushed.push(record)
      },
      sendCommand: async () => undefined,
    },
    pushed,
  }
}

describe('handleReportStatus', () => {
  it('emits a busy record keyed by agentId, with text', async () => {
    const { scoped, pushed } = stubScoped({
      sessionId: 's1',
      agentId: 'a1',
      agentType: 'Explore',
    })
    await handleReportStatus(
      { text: 'Building nav', level: 'error' },
      scoped,
    )
    expect(pushed[0]).toMatchObject({
      key: 'a1',
      sessionId: 's1',
      agentType: 'Explore',
      level: 'error',
      text: 'Building nav',
      activity: 'busy',
    })
  })

  it('falls back to label then "agent" for the key when no identity', async () => {
    const { scoped, pushed } = stubScoped(undefined)
    await handleReportStatus(
      { text: 'x', label: 'nav-builder' },
      scoped,
    )
    expect(pushed[0].key).toBe('nav-builder')
  })

  it('falls back to the literal "agent" with no identity and no label', async () => {
    const { scoped, pushed } = stubScoped(undefined)
    await handleReportStatus({ text: 'x' }, scoped)
    expect(pushed[0]).toMatchObject({
      key: 'agent',
      level: 'normal',
      text: 'x',
      activity: 'busy',
    })
  })
})
