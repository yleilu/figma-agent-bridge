import { describe, it, expect } from 'bun:test'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
  FigmaClient,
  ScopedFigmaClient,
} from '@figma-agent-bridge/server/figma-client'
import { PluginDisconnectedError } from '@figma-agent-bridge/server/figma-client'
import type { ChannelInfo } from '@figma-agent-bridge/shared'
import { searchParamsSchema } from '@figma-agent-bridge/shared/tool-params'
import { textResult } from '@figma-agent-bridge/server/tools/shared'
import {
  registerFileTool,
  withFile,
} from '@figma-agent-bridge/server/tools/with-file'
import { sessionIdentity } from '@figma-agent-bridge/server/change-feed/session-identity'

const base = (over: Partial<FigmaClient>): FigmaClient => ({
  joinChannel: () => Promise.resolve(''),
  sendCommand: () => Promise.resolve(null),
  forFile: (fileKey: string) => ({
    fileKey,
    sendCommand: () => Promise.resolve(null),
  }),
  notify: () => undefined,
  onRequest: () => undefined,
  disconnect: () => undefined,
  isConnected: () => true,
  joinedFiles: () => [],
  channelFor: () => null,
  discover: () => Promise.resolve([] as ChannelInfo[]),
  isInstanceDead: () => false,
  onSocketClose: () => undefined,
  onFileDead: () => undefined,
  ...over,
})

describe('withFile', () => {
  it('gates via requireFile, scopes the client, and strips fileKey/sessionId from params', async () => {
    let seenParams: Record<string, unknown> | null = null
    let seenScope: ScopedFigmaClient | null = null
    const client = base({ channelFor: () => 'ch-a' }) // already joined → requireFile ok

    const wrapped = withFile(
      client,
      async (params, scoped) => {
        seenParams = params
        seenScope = scoped
        return textResult('ran')
      },
    )

    const res = await wrapped({
      fileKey: 'fk-a',
      sessionId: 's-1',
      nodeId: '1:2',
    })
    expect(res.content[0].text).toBe('ran')
    expect(seenParams).toEqual({ nodeId: '1:2' }) // identity fields moved out
    expect(seenScope?.fileKey).toBe('fk-a')
  })

  it('returns the WRONG_FILE gate error and never calls the handler on an unavailable file', async () => {
    let called = false
    const client = base({
      channelFor: () => null,
      discover: () =>
        Promise.resolve([
          {
            channel: 'ch-b',
            fileKey: 'fk-b',
            fileName: 'B',
            connectedAt: 0,
          },
        ]),
    })
    const wrapped = withFile(client, async () => {
      called = true
      return textResult('should not run')
    })
    const res = await wrapped({
      fileKey: 'fk-a',
      nodeId: '1:2',
    })
    expect(JSON.parse(res.content[0].text).code).toBe(
      'WRONG_FILE',
    )
    expect(called).toBe(false)
  })

  it('lifts sessionId into meta via forFile (forward-compat)', async () => {
    let scopedSessionSeen: string | undefined
    const client = base({
      channelFor: () => 'ch-a',
      forFile: (fileKey, opts) => {
        scopedSessionSeen = opts?.sessionId
        return {
          fileKey,
          sendCommand: () => Promise.resolve(null),
        }
      },
    })
    const wrapped = withFile(client, async () =>
      textResult('ok'),
    )
    await wrapped({
      fileKey: 'fk-a',
      sessionId: 's-9',
      nodeId: '1:2',
    })
    expect(scopedSessionSeen).toBe('s-9')
  })

  it('returns errorEnvelope(DISCONNECTED) when the handler throws PluginDisconnectedError', async () => {
    const client = base({ channelFor: () => 'ch-a' }) // already joined → gate ok
    const wrapped = withFile(client, async () => {
      throw new PluginDisconnectedError('fk-a')
    })
    const res = await wrapped({
      fileKey: 'fk-a',
      nodeId: '1:2',
    })
    const env = JSON.parse(res.content[0].text)
    expect(env.code).toBe('DISCONNECTED')
    expect(env.error).toContain('fk-a')
  })

  it('LATCHES the injected sessionId even when the gate refuses the call', async () => {
    // The count mirror is written on the PUSH path, which carries no
    // sessionId: if this wrapper stops remembering the id, every count file
    // stays on the `_unattributed` sentinel forever and adoption never runs.
    // The gate-refusing shape is the one that pins the ordering — remember
    // must precede requireFile.
    const client = base({
      channelFor: () => null,
      discover: () => Promise.resolve([] as ChannelInfo[]),
    })
    const wrapped = withFile(client, async () =>
      textResult('should not run'),
    )
    await wrapped({
      fileKey: 'fk-none',
      sessionId: 's-latched',
      nodeId: '1:2',
    })
    const latched = sessionIdentity.current()
    expect(latched).toBeDefined()
    // First-wins: a later call cannot steal the identity.
    await wrapped({
      fileKey: 'fk-none',
      sessionId: 's-other',
      nodeId: '1:2',
    })
    expect(sessionIdentity.current()).toBe(
      latched as string,
    )
  })

  it('rethrows non-PluginDisconnectedError errors from the handler', async () => {
    const client = base({ channelFor: () => 'ch-a' })
    const wrapped = withFile(client, async () => {
      throw new Error('boom')
    })
    let caught: Error | null = null
    try {
      await wrapped({ fileKey: 'fk-a', nodeId: '1:2' })
    } catch (err) {
      caught = err as Error
    }
    expect(caught?.message).toBe('boom')
  })
})

// ---------------------------------------------------------------------------
// registerFileTool — the SCHEMA is registered, not its shape (B52)
// ---------------------------------------------------------------------------
//
// `server.tool(name, shape, cb)` re-wraps the shape in a plain `z.object`,
// which drops every modifier the tool-params schema carries. On `search` the
// dropped modifier was `.strict()`, and the strip INVERTED the reply: a
// mis-nested filter key vanished and the call became a match-all.
describe('registerFileTool', () => {
  type Registered = {
    name: string
    config: { inputSchema?: unknown }
  }

  const captureServer = (sink: Registered[]): McpServer =>
    ({
      registerTool: (
        name: string,
        config: { inputSchema?: unknown },
      ) => {
        sink.push({ name, config })
      },
    }) as unknown as McpServer

  const registerSearch = (sink: Registered[]): void => {
    registerFileTool(
      captureServer(sink),
      base({ channelFor: () => 'ch-a' }),
      'search',
      searchParamsSchema,
      async () => textResult('ran'),
    )
  }

  it('hands the MCP server the schema object itself', () => {
    const sink: Registered[] = []
    registerSearch(sink)
    expect(sink[0].name).toBe('search')
    expect(sink[0].config.inputSchema).toBe(
      searchParamsSchema,
    )
  })

  it('so a strict schema still rejects an unknown key at the MCP boundary', () => {
    const sink: Registered[] = []
    registerSearch(sink)
    const registered = sink[0].config
      .inputSchema as typeof searchParamsSchema
    const misNested = {
      fileKey: 'fk',
      scope: 'node' as const,
      nodeId: '298:7508',
      name: 'Label',
    }
    expect(registered.safeParse(misNested).success).toBe(
      false,
    )
    // …and the shape the old registration passed would have stripped it,
    // handing the handler a match-all it never asked for.
    const stripped = z
      .object(searchParamsSchema.shape)
      .safeParse(misNested)
    expect(stripped.success).toBe(true)
    expect(
      (stripped.data as Record<string, unknown> | undefined)
        ?.name,
    ).toBeUndefined()
  })
})
