import { describe, expect, it } from 'bun:test'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import {
  textResult,
  requireConnected,
  formatMutationResult,
} from '@figma-agent-bridge/server/tools/shared'

const connected: FigmaClient = {
  joinChannel: () => Promise.resolve(''),
  sendCommand: () => Promise.resolve(null),
  disconnect: () => undefined,
  isConnected: () => true,
  currentChannel: () => 'test-ch',
}
const disconnected: FigmaClient = {
  ...connected,
  isConnected: () => false,
}

describe('textResult', () => {
  it('wraps a string in the ToolResult shape', () => {
    expect(textResult('hi')).toEqual({
      content: [{ type: 'text', text: 'hi' }],
    })
  })
})

describe('requireConnected', () => {
  it('returns null when connected', () => {
    expect(requireConnected(connected)).toBeNull()
  })

  it('returns the verbatim not-connected message when disconnected', () => {
    const r = requireConnected(disconnected)
    expect(r).not.toBeNull()
    expect(r?.content[0].text).toBe(
      'Not connected to Figma. Use connect tool first.',
    )
  })
})

describe('formatMutationResult', () => {
  it('returns the fail message when result is null', () => {
    expect(
      formatMutationResult(null, 'Failed to create node.')
        .content[0].text,
    ).toBe('Failed to create node.')
  })

  it('prefixes Error: when result.error is set', () => {
    expect(
      formatMutationResult({ error: 'boom' }, 'fail')
        .content[0].text,
    ).toBe('Error: boom')
  })

  it('pretty-prints JSON otherwise', () => {
    const r = formatMutationResult(
      { id: '1:2' } as { error?: string },
      'fail',
    )
    expect(r.content[0].text).toBe(
      JSON.stringify({ id: '1:2' }, null, 2),
    )
  })
})
