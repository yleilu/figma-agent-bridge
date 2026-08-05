// transform-group.test.ts — handleTransformGroup headless-mock tests.
//
// Tests the handler mechanics and schema routing for the transform_group tool.
// Covers:
//   • T6 — create_tree STILL rejects TRANSFORM_GROUP type (no-redundancy lock).
//   • Schema validation — nodeIds min(1), modifiers min(1), REPEAT/repeatType union.
//   • Handler forwards COMMANDS.TRANSFORM_GROUP with {nodeIds,parentId,modifiers}.
//   • Mock returns a TRANSFORM_GROUP node.
//
// IMPORTANT: The mock does NOT model figma.transformGroup runtime availability.
// The feature-detect (T7) lives only in the real plugin (code.ts). These tests
// prove server-side mechanics only. The controller must live-verify:
//   (1) Does figma.transformGroup EXIST in the runtime? (likely absent — niche
//       1.130.0 API on a 1.123.0 pin.)
//   (2) If present, does a LinearRepeatModifier actually create a repeat pattern?
//
// Ship-gated: if figma.transformGroup is absent → revert the tool row, count
// back to 50, document in deferred-capabilities.md.
//
// CONFIRMED LIVE shape (LINEAR modifier that worked against real Figma):
//   { type: 'REPEAT', repeatType: 'LINEAR', count: 3, unitType: 'PIXELS', offset: 100, axis: 'HORIZONTAL' }

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import type { Server } from 'bun'
import { COMMANDS } from '@figma-agent-bridge/shared'
import {
  transformGroupParamsSchema,
  transformModifierSchema,
} from '@figma-agent-bridge/shared/tool-params'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import {
  createFigmaClient,
  type FigmaClient,
  type ScopedFigmaClient,
} from '@figma-agent-bridge/server/figma-client'
import { handleTransformGroup } from '@figma-agent-bridge/server/tools/structure'
import { createMockPlugin } from '../mocks/mock-plugin'

// ---------------------------------------------------------------------------
// Test helper: lightweight stub scoped client
// ---------------------------------------------------------------------------

type Sent = {
  command: string
  params?: Record<string, unknown>
}

const stubScoped = (opts: {
  reply?: unknown
  sent?: Sent[]
}): ScopedFigmaClient => ({
  fileKey: 'fk-test',
  sendCommand: async (
    command: string,
    params?: Record<string, unknown>,
  ) => {
    opts.sent?.push({ command, params })
    return opts.reply ?? null
  },
})

// ---------------------------------------------------------------------------
// T6: create_tree must NOT accept TRANSFORM_GROUP type
// (locking the no-redundancy decision — composite-via-children was removed)
// The schema accepts any string type (validation is runtime in the handler),
// but the CREATABLE_TYPES list in create-node.ts excludes TRANSFORM_GROUP.
// This is fully asserted in create-tree.test.ts ("throws a clear error for
// a TRANSFORM_GROUP node"). The test here is a cross-reference assertion
// from the transform_group tool's perspective.
// ---------------------------------------------------------------------------

describe('T6: create_tree rejects TRANSFORM_GROUP type', () => {
  it('TRANSFORM_GROUP is not in CREATABLE_TYPES (delegated to create-node)', async () => {
    // The CREATABLE_TYPES list is the runtime gate; TRANSFORM_GROUP is absent from it.
    // This import verifies the list is accessible and does not include TRANSFORM_GROUP.
    const { CREATABLE_TYPES } =
      await import('@figma-agent-bridge/server/tools/create-node')
    expect(CREATABLE_TYPES).not.toContain('TRANSFORM_GROUP')
    expect(CREATABLE_TYPES).not.toContain('GROUP')
    expect(CREATABLE_TYPES).not.toContain(
      'BOOLEAN_OPERATION',
    )
  })
})

// ---------------------------------------------------------------------------
// Schema validation — REAL modifier shape confirmed live against Figma
// ---------------------------------------------------------------------------

// The confirmed LINEAR shape that worked against real Figma:
const VALID_LINEAR_MODIFIER = {
  type: 'REPEAT',
  repeatType: 'LINEAR',
  count: 3,
  unitType: 'PIXELS',
  offset: 100,
  axis: 'HORIZONTAL',
} as const

// The old (guessed, wrong) LINEAR shape — must be REJECTED by the schema.
const OLD_LINEAR_MODIFIER = {
  type: 'LINEAR',
  count: 4,
  spacing: 20,
}

describe('transformGroupParamsSchema', () => {
  it('accepts the confirmed live LINEAR modifier shape (REPEAT/repeatType)', () => {
    const result = transformGroupParamsSchema.safeParse({
      fileKey: 'fk-test',
      nodeIds: ['1:1', '1:2'],
      modifiers: [VALID_LINEAR_MODIFIER],
    })
    expect(result.success).toBe(true)
  })

  it('rejects the old guessed shape (type:LINEAR) — wrong type literal', () => {
    const result = transformGroupParamsSchema.safeParse({
      fileKey: 'fk-test',
      nodeIds: ['1:1', '1:2'],
      modifiers: [OLD_LINEAR_MODIFIER],
    })
    expect(result.success).toBe(false)
  })

  it('accepts a RADIAL modifier (type:REPEAT, repeatType:RADIAL)', () => {
    const result = transformGroupParamsSchema.safeParse({
      fileKey: 'fk-test',
      nodeIds: ['1:1'],
      modifiers: [
        { type: 'REPEAT', repeatType: 'RADIAL', count: 6 },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('accepts LINEAR modifier with VERTICAL axis', () => {
    const result = transformGroupParamsSchema.safeParse({
      fileKey: 'fk-test',
      nodeIds: ['1:1'],
      modifiers: [
        {
          type: 'REPEAT',
          repeatType: 'LINEAR',
          count: 3,
          unitType: 'PIXELS',
          offset: 50,
          axis: 'VERTICAL',
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects LINEAR modifier with an invalid axis value', () => {
    const result = transformGroupParamsSchema.safeParse({
      fileKey: 'fk-test',
      nodeIds: ['1:1'],
      modifiers: [
        {
          type: 'REPEAT',
          repeatType: 'LINEAR',
          count: 3,
          unitType: 'PIXELS',
          offset: 50,
          axis: 'DIAGONAL',
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('rejects unknown repeatType', () => {
    const result = transformGroupParamsSchema.safeParse({
      fileKey: 'fk-test',
      nodeIds: ['1:1'],
      modifiers: [
        { type: 'REPEAT', repeatType: 'SPIRAL', count: 3 },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty nodeIds (min 1)', () => {
    const result = transformGroupParamsSchema.safeParse({
      fileKey: 'fk-test',
      nodeIds: [],
      modifiers: [VALID_LINEAR_MODIFIER],
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty modifiers (min 1)', () => {
    const result = transformGroupParamsSchema.safeParse({
      fileKey: 'fk-test',
      nodeIds: ['1:1'],
      modifiers: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects LINEAR modifier with count < 1', () => {
    const result = transformGroupParamsSchema.safeParse({
      fileKey: 'fk-test',
      nodeIds: ['1:1'],
      modifiers: [
        {
          type: 'REPEAT',
          repeatType: 'LINEAR',
          count: 0,
          unitType: 'PIXELS',
          offset: 50,
          axis: 'HORIZONTAL',
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('rejects RADIAL modifier with non-integer count', () => {
    const result = transformGroupParamsSchema.safeParse({
      fileKey: 'fk-test',
      nodeIds: ['1:1'],
      modifiers: [
        {
          type: 'REPEAT',
          repeatType: 'RADIAL',
          count: 3.5,
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('accepts an optional parentId', () => {
    const result = transformGroupParamsSchema.safeParse({
      fileKey: 'fk-test',
      nodeIds: ['1:1'],
      parentId: '2:5',
      modifiers: [VALID_LINEAR_MODIFIER],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.parentId).toBe('2:5')
    }
  })

  it('passes through extra fields on LINEAR modifier (passthrough)', () => {
    // .passthrough() means unknown fields are preserved, not stripped.
    const result = transformGroupParamsSchema.safeParse({
      fileKey: 'fk-test',
      nodeIds: ['1:1'],
      modifiers: [
        {
          ...VALID_LINEAR_MODIFIER,
          someUnknownFigmaField: 'future-value',
        },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(
        (
          result.data.modifiers[0] as Record<
            string,
            unknown
          >
        ).someUnknownFigmaField,
      ).toBe('future-value')
    }
  })

  it('passes through extra fields on RADIAL modifier (passthrough)', () => {
    const result = transformGroupParamsSchema.safeParse({
      fileKey: 'fk-test',
      nodeIds: ['1:1'],
      modifiers: [
        {
          type: 'REPEAT',
          repeatType: 'RADIAL',
          count: 6,
          angle: 360,
          someRadialExtra: true,
        },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(
        (
          result.data.modifiers[0] as Record<
            string,
            unknown
          >
        ).someRadialExtra,
      ).toBe(true)
    }
  })

  it('accepts mixed LINEAR and RADIAL modifiers in the array', () => {
    const result = transformGroupParamsSchema.safeParse({
      fileKey: 'fk-test',
      nodeIds: ['1:1'],
      modifiers: [
        VALID_LINEAR_MODIFIER,
        { type: 'REPEAT', repeatType: 'RADIAL', count: 6 },
      ],
    })
    expect(result.success).toBe(true)
  })
})

describe('transformModifierSchema standalone', () => {
  it('LINEAR discriminant parses correctly on repeatType', () => {
    const m = transformModifierSchema.parse(
      VALID_LINEAR_MODIFIER,
    )
    expect(m.repeatType).toBe('LINEAR')
    expect(m.count).toBe(3)
  })

  it('RADIAL discriminant parses correctly on repeatType', () => {
    const m = transformModifierSchema.parse({
      type: 'REPEAT',
      repeatType: 'RADIAL',
      count: 8,
    })
    expect(m.repeatType).toBe('RADIAL')
    expect(m.count).toBe(8)
  })

  it('rejects the old type:LINEAR shape', () => {
    const result = transformModifierSchema.safeParse(
      OLD_LINEAR_MODIFIER,
    )
    expect(result.success).toBe(false)
  })

  it('rejects a modifier with neither LINEAR nor RADIAL repeatType', () => {
    const result = transformModifierSchema.safeParse({
      type: 'REPEAT',
      repeatType: 'GRID',
      count: 4,
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Handler unit tests (stub scoped client)
// ---------------------------------------------------------------------------

describe('handleTransformGroup', () => {
  it('forwards COMMANDS.TRANSFORM_GROUP with {nodeIds, modifiers}', async () => {
    const sent: Sent[] = []
    await handleTransformGroup(
      {
        nodeIds: ['1:1', '1:2'],
        modifiers: [VALID_LINEAR_MODIFIER],
      },
      stubScoped({
        sent,
        reply: {
          id: 'tg:abc123',
          name: 'Transform Group',
          type: 'TRANSFORM_GROUP',
        },
      }),
    )
    expect(sent[0].command).toBe(COMMANDS.TRANSFORM_GROUP)
    expect(sent[0].params).toEqual({
      nodeIds: ['1:1', '1:2'],
      parentId: undefined,
      modifiers: [VALID_LINEAR_MODIFIER],
    })
  })

  it('forwards parentId when provided', async () => {
    const sent: Sent[] = []
    await handleTransformGroup(
      {
        nodeIds: ['1:1'],
        parentId: '2:5',
        modifiers: [
          {
            type: 'REPEAT',
            repeatType: 'RADIAL',
            count: 6,
          },
        ],
      },
      stubScoped({
        sent,
        reply: {
          id: 'tg:xyz',
          name: 'TG',
          type: 'TRANSFORM_GROUP',
        },
      }),
    )
    expect(sent[0].params?.parentId).toBe('2:5')
  })

  it('emits the {id,name,type} from the mock', async () => {
    const result = await handleTransformGroup(
      {
        nodeIds: ['1:1'],
        modifiers: [VALID_LINEAR_MODIFIER],
      },
      stubScoped({
        reply: {
          id: 'tg:abc123',
          name: 'Transform Group',
          type: 'TRANSFORM_GROUP',
        },
      }),
    )
    const out = JSON.parse(result.content[0].text) as {
      id: string
      name: string
      type: string
    }
    expect(out.id).toBe('tg:abc123')
    expect(out.name).toBe('Transform Group')
    expect(out.type).toBe('TRANSFORM_GROUP')
  })

  it('surfaces a plugin-side {error} as an error', async () => {
    const result = await handleTransformGroup(
      {
        nodeIds: ['nope'],
        modifiers: [VALID_LINEAR_MODIFIER],
      },
      stubScoped({
        reply: {
          error:
            'transform_group: figma.transformGroup is unavailable in this Figma runtime.',
        },
      }),
    )
    const data = JSON.parse(result.content[0].text) as {
      error: string
      code: string
    }
    expect(data.error).toContain(
      'transformGroup is unavailable',
    )
    expect(data.code).toBe('API_UNAVAILABLE')
  })

  it('returns failure text on a null reply', async () => {
    const result = await handleTransformGroup(
      {
        nodeIds: ['1:1'],
        modifiers: [VALID_LINEAR_MODIFIER],
      },
      stubScoped({ reply: null }),
    )
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'Failed to transform group nodes.',
      code: 'PLUGIN_ERROR',
    })
  })
})

// ---------------------------------------------------------------------------
// End-to-end routing through mock plugin
// ---------------------------------------------------------------------------

describe('transform_group routing through mock plugin', () => {
  const TEST_PORT = 3178
  const RELAY_URL = `ws://localhost:${TEST_PORT}`
  const TEST_CHANNEL = 'transform-group-routing'
  const FK = 'fk-transform-group'
  let server: Server<{ id: string }>
  let client: FigmaClient
  let plugin: ReturnType<typeof createMockPlugin> | null =
    null

  beforeEach(async () => {
    server = startRelay(TEST_PORT)
    client = createFigmaClient(RELAY_URL)
    plugin = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: TEST_CHANNEL,
      fileKey: FK,
    })
    await plugin.start()
    await client.joinChannel(TEST_CHANNEL, FK)
  })

  afterEach(() => {
    if (plugin !== null) {
      plugin.stop()
      plugin = null
    }
    client.disconnect()
    stopRelay(server)
  })

  it('routes transform_group to the mock and returns a TRANSFORM_GROUP node', async () => {
    const scoped = client.forFile(FK)
    const res = await handleTransformGroup(
      {
        nodeIds: ['1:1', '1:2'],
        modifiers: [VALID_LINEAR_MODIFIER],
      },
      scoped,
    )
    const out = JSON.parse(res.content[0].text) as {
      id: string
      name: string
      type: string
    }
    expect(out.type).toBe('TRANSFORM_GROUP')
    expect(out.id).toMatch(/^tg:/)
  })

  it('mock returns an error when nodeIds is empty (simulated via params override)', async () => {
    // The schema rejects empty nodeIds before reaching the handler, but
    // verify the mock also handles it defensively. The figma-client wraps
    // plugin {error} replies as a thrown Error — so we catch it.
    const scoped = client.forFile(FK)
    let caughtMessage: string | null = null
    try {
      await scoped.sendCommand(COMMANDS.TRANSFORM_GROUP, {
        nodeIds: [],
        modifiers: [VALID_LINEAR_MODIFIER],
      })
    } catch (err) {
      caughtMessage =
        err instanceof Error ? err.message : String(err)
    }
    expect(caughtMessage).not.toBeNull()
    expect(caughtMessage).toContain(
      'transform_group requires at least 1 resolvable node',
    )
  })
})
