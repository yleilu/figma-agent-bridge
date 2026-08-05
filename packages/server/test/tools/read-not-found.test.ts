import { describe, expect, it } from 'bun:test'
import {
  handleGetNode,
  handleInspect,
} from '@figma-agent-bridge/server/tools/read'
import type { ScopedFigmaClient } from '@figma-agent-bridge/server/figma-client'

// The plugin returns this for a missing node (code.ts:1744).
const notFound = (): ScopedFigmaClient => ({
  fileKey: 'fk-test',
  sendCommand: async () => ({
    error: 'Node not found: 99999:99999',
  }),
  notifyStatus: () => {},
})

const parse = (r: {
  content: { text?: string }[]
}): { error: string; code: string } =>
  JSON.parse(r.content[0].text ?? '')

describe('a missing node is an error, not a hollow success', () => {
  it('get_node envelopes NODE_NOT_FOUND', async () => {
    const r = await handleGetNode(
      { nodeId: '99999:99999' },
      notFound(),
    )
    expect(parse(r)).toEqual({
      error: 'Node not found: 99999:99999',
      code: 'NODE_NOT_FOUND',
    })
  })

  it('inspect envelopes NODE_NOT_FOUND', async () => {
    const r = await handleInspect(
      { nodeId: '99999:99999' },
      notFound(),
    )
    expect(parse(r).code).toBe('NODE_NOT_FOUND')
  })
})
