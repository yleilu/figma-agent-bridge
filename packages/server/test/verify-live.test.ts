// verify-live.test.ts — the self-test for the live-verification harness.
//
// The LIVE harness (src/verify-live.ts) drives the REAL Figma plugin. This test
// proves the harness MECHANICS: it spins up the same relay + the faithful mock
// plugin, joins a client, and runs the EXACT exported CHECK_LIST against it.
//
// What we assert (and deliberately do NOT):
//   • the harness executes every check end-to-end (no throws, no hangs);
//   • every check passes at the CONTRACT level the faithful mock can model
//     (PASS or honest SKIP — never FAIL);
//   • checks collect the node ids they create, and the cleanup path (the same
//     handleDeleteNode loop the CLI runs) deletes them.
// We do NOT assert real-API-only specifics (true variable round-trip values,
// real PNG pixels, real paint binding) — those are what the LIVE run proves
// against the real plugin using this same array.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'bun:test'
import type { Server } from 'bun'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { createFigmaClient } from '@figma-agent-bridge/server/figma-client'
import type { FigmaClient } from '@figma-agent-bridge/server/figma-client'
import { handleConnect } from '@figma-agent-bridge/server/tools/session'
import { handleDeleteNode } from '@figma-agent-bridge/server/tools/structure'
import {
  CHECK_LIST,
  ALL_TOOLS,
  touchedTools,
} from '@figma-agent-bridge/server/verify-checks'
import { createMockPlugin } from './mocks/mock-plugin'

const TEST_PORT = 3211
const RELAY_URL = `ws://localhost:${TEST_PORT}`
const TEST_CHANNEL = 'verify-live-self-test'

describe('verify-live harness against the mock plugin', () => {
  let server: Server<{ id: string }>
  let client: FigmaClient
  let plugin: ReturnType<typeof createMockPlugin> | null =
    null

  beforeAll(async () => {
    // Lift the token-bucket rate limit for the self-test: this harness replays
    // the ENTIRE CHECK_LIST + the cleanup delete loop back-to-back with zero
    // client pacing, which blows past the production-sized burst (RATE_BURST)
    // and would otherwise see a frame silently dropped mid-run (a 30s command
    // timeout). A real agent never fires this fast. Production defaults are
    // unchanged; only this in-process test opts into a large burst.
    server = startRelay(TEST_PORT, {
      rateBurst: 1_000_000,
      rateTokensPerSec: 1_000_000,
    })
    client = createFigmaClient(RELAY_URL)
    plugin = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: TEST_CHANNEL,
      documentName: 'Verify Self-Test Doc',
      pageName: 'Main',
    })
    await plugin.start()
    await handleConnect({ channel: TEST_CHANNEL }, client)
  })

  afterAll(() => {
    if (plugin !== null) {
      plugin.stop()
      plugin = null
    }
    client.disconnect()
    stopRelay(server)
  })

  it('connects the client to the mock plugin', () => {
    expect(client.isConnected()).toBe(true)
  })

  it('runs every check in CHECK_LIST without a FAIL', async () => {
    const createdNodes = new Set<string>()
    const failures: string[] = []
    // Checks drive file tools through a scoped client (the single joined file's
    // fileKey); status still gets the unscoped client as the second arg.
    const fileKey = client.joinedFiles()[0]
    const scoped = client.forFile(fileKey)

    for (const check of CHECK_LIST) {
      const outcome = await check.run(scoped, client)
      for (const id of outcome.nodeIds ?? []) {
        createdNodes.add(id)
      }
      // The faithful mock satisfies every contract-level check: each must end
      // PASS (ok && !skipped) or honest SKIP (ok && skipped) — never a FAIL.
      if (!outcome.ok) {
        failures.push(`${check.id}: ${outcome.detail}`)
      }
    }

    expect(failures).toEqual([])
    // Sanity: the checks actually exercised creates, so cleanup has work to do.
    expect(createdNodes.size).toBeGreaterThan(0)

    // Cleanup path — the same handleDeleteNode loop the CLI runs at the end.
    let deleted = 0
    for (const id of createdNodes) {
      const r = await handleDeleteNode(
        { nodeId: id },
        scoped,
      )
      if (!r.content[0]?.text.startsWith('Error:')) {
        deleted++
      }
    }
    // The mock echoes the deleted id for every delete_node, so all succeed.
    expect(deleted).toBe(createdNodes.size)
  })

  it('every check declares only real registry tools', () => {
    const registry = new Set(ALL_TOOLS)
    for (const check of CHECK_LIST) {
      for (const tool of check.tools) {
        expect(registry.has(tool)).toBe(true)
      }
    }
  })

  it('the check list touches a broad slice of the 47-tool surface', () => {
    const touched = touchedTools()
    // Every touched tool is a real registry tool.
    for (const tool of touched) {
      expect(ALL_TOOLS).toContain(tool)
    }
    // The harness is meant to touch (nearly) the whole surface. Allow a small
    // documented gap (swap_component remote needs a library; it is SKIP-only
    // and may not register as touched if its check SKIPs before the call).
    expect(touched.size).toBeGreaterThanOrEqual(
      ALL_TOOLS.length - 1,
    )
  })

  it('the registry denominator stays at 49', () => {
    expect(ALL_TOOLS.length).toBe(49)
  })
})
