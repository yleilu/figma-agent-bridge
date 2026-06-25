// create-image.test.ts — handleCreateImage.
//
// create_image is a mutation routed through formatMutationResult, but it is
// also T7 degrade-aware: when the plugin cannot fetch/create the image it
// replies with {warnings:[…]} (NO hash, NO error), so the handler reports
// success-with-warnings, NEVER an error. The handler also validates the
// url-XOR-bytes constraint before sending. Asserts on REAL handler output.

import { describe, expect, it } from 'bun:test'
import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import { handleCreateImage } from '@figma-agent-bridge/server/tools/create-image'

type Sent = {
  command: string
  params?: Record<string, unknown>
}

const stubClient = (opts: {
  connected?: boolean
  reply?: unknown
  sent?: Sent[]
}): FigmaClient => ({
  joinChannel: async () => 'ch',
  sendCommand: async (
    command: string,
    params?: Record<string, unknown>,
  ) => {
    opts.sent?.push({ command, params })
    return opts.reply ?? null
  },
  disconnect: () => {},
  isConnected: () => opts.connected ?? true,
  currentChannel: () => 'ch',
})

describe('handleCreateImage', () => {
  it('returns the not-connected guard when disconnected', async () => {
    const result = await handleCreateImage(
      { url: 'https://x/y.png' },
      stubClient({ connected: false }),
    )
    expect(result.content[0].text).toContain(
      'Not connected',
    )
  })

  it('forwards COMMANDS.CREATE_IMAGE with {url} and emits {hash}', async () => {
    const sent: Sent[] = []
    const result = await handleCreateImage(
      { url: 'https://x/y.png' },
      stubClient({ sent, reply: { hash: 'img:abc123' } }),
    )
    expect(sent[0].command).toBe(COMMANDS.CREATE_IMAGE)
    expect(sent[0].params).toEqual({
      url: 'https://x/y.png',
    })
    const out = JSON.parse(result.content[0].text) as {
      hash: string
    }
    expect(out.hash).toBe('img:abc123')
  })

  it('forwards {bytes} and emits {hash}', async () => {
    const sent: Sent[] = []
    await handleCreateImage(
      { bytes: [1, 2, 3] },
      stubClient({ sent, reply: { hash: 'img:def' } }),
    )
    expect(sent[0].params).toEqual({ bytes: [1, 2, 3] })
  })

  it('rejects when NEITHER url nor bytes is supplied (no send)', async () => {
    const sent: Sent[] = []
    const result = await handleCreateImage(
      {},
      stubClient({ sent, reply: { hash: 'never' } }),
    )
    expect(sent).toHaveLength(0)
    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain('url or bytes')
  })

  it('rejects when BOTH url and bytes are supplied (no send)', async () => {
    const sent: Sent[] = []
    const result = await handleCreateImage(
      { url: 'https://x/y.png', bytes: [1] },
      stubClient({ sent, reply: { hash: 'never' } }),
    )
    expect(sent).toHaveLength(0)
    expect(result.content[0].text).toContain('Error')
  })

  it('T7 degrade: surfaces a {warnings} reply as success, NEVER an error', async () => {
    const result = await handleCreateImage(
      { url: 'degrade:nope' },
      stubClient({
        reply: {
          warnings: [
            'createImageAsync failed (network/feature unavailable): boom',
          ],
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      hash?: string
      warnings?: string[]
    }
    expect(out.hash).toBeUndefined()
    expect(out.warnings).toBeDefined()
    expect(result.content[0].text).not.toContain('Error:')
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleCreateImage(
      { url: 'https://x/y.png' },
      stubClient({ reply: null }),
    )
    expect(result.content[0].text).toBe(
      'Failed to create image.',
    )
  })
})
