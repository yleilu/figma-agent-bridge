import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import type { Server } from 'bun'
import YAML from 'yaml'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { createFigmaClient } from '@figma-agent-bridge/server/figma-client'
import type {
  FigmaClient,
  ScopedFigmaClient,
} from '@figma-agent-bridge/server/figma-client'
import {
  handleGetNode,
  handleInspect,
} from '@figma-agent-bridge/server/tools/read'
import { handleUpdateNode } from '@figma-agent-bridge/server/tools/update'
import { handleSetPluginData } from '@figma-agent-bridge/server/tools/metadata'
import { createMockPlugin } from '../mocks/mock-plugin'

const TEST_PORT = 3131
const RELAY_URL = `ws://localhost:${TEST_PORT}`
const TEST_CHANNEL = 'e2e-context-channel'
const FK = 'fk-context'

describe('context round-trip e2e (mock plugin over real relay)', () => {
  let server: Server<{ id: string }>
  let client: FigmaClient
  let scoped: ScopedFigmaClient
  let plugin: ReturnType<typeof createMockPlugin> | null =
    null

  beforeEach(async () => {
    server = startRelay(TEST_PORT)
    client = createFigmaClient(RELAY_URL)
    plugin = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: TEST_CHANNEL,
      documentName: 'Slice Doc',
      pageName: 'Main',
      fileKey: FK,
    })
    await plugin.start()
    await client.joinChannel(TEST_CHANNEL, FK)
    scoped = client.forFile(FK)
  })

  afterEach(() => {
    if (plugin !== null) {
      plugin.stop()
      plugin = null
    }
    client.disconnect()
    stopRelay(server)
  })

  it('round-trips context via update_node → get_node; inspect returns summary only', async () => {
    const value =
      '---\npurpose: CTA\n---\n## Notes\nlong body here'
    await handleUpdateNode(
      { nodeId: '1:42', patch: { context: value } },
      scoped,
    )
    const gn = YAML.parse(
      (await handleGetNode({ nodeId: '1:42' }, scoped))
        .content[0].text,
    ) as { context?: string }
    expect(gn.context).toBe(value)
    const ins = YAML.parse(
      (await handleInspect({ nodeId: '1:42' }, scoped))
        .content[0].text,
    ) as {
      view: { context?: string; contextSummary?: string }
    }
    expect(ins.view.contextSummary).toBe('purpose: CTA')
    expect(ins.view.context).toBeUndefined()
  })

  it('over-cap via the set_plugin_data escape hatch is read-only', async () => {
    const big = '🙂'.repeat(600) // 2400 bytes
    await handleSetPluginData(
      {
        nodeId: '1:42',
        namespace: 'figmabridge',
        key: 'context',
        value: big,
      },
      scoped,
    )
    expect(
      YAML.parse(
        (await handleGetNode({ nodeId: '1:42' }, scoped))
          .content[0].text,
      ).context,
    ).toBe(big)
    const res = await handleUpdateNode(
      { nodeId: '1:42', patch: { context: big } },
      scoped,
    )
    expect(res.content[0].text).toMatch(/limit is 2048/)
  })
})
