// packages/shared/test/ws-schemas.test.ts
import { describe, expect, it } from 'bun:test'
import type { z } from 'zod'
import {
  joinMessageSchema,
  channelMessageSchema,
  registerMessageSchema,
  relayIncomingSchema,
  broadcastMessageSchema,
  systemMessageSchema,
  relayOutgoingSchema,
  commandMessageSchema,
} from '@figma-agent-bridge/shared/ws-schemas'
import { majorMinor, APP_VERSION } from '@figma-agent-bridge/shared/constants'
import type {
  JoinMessage,
  ChannelMessage,
  RegisterMessage,
  BroadcastMessage,
  SystemMessage,
  CommandMessage,
  RelayIncoming,
  RelayOutgoing,
} from '@figma-agent-bridge/shared/types'

// --- compile-time bidirectional assignability ---
// If either direction breaks, `bun run typecheck` fails (the suite is the gate).
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <
    T,
  >() => T extends B ? 1 : 2
    ? true
    : false
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time type assertion: Constraint is only used at call-site
const assertEqual = <Constraint extends true>(): void =>
  undefined

assertEqual<
  Equal<z.infer<typeof joinMessageSchema>, JoinMessage>
>()
assertEqual<
  Equal<
    z.infer<typeof channelMessageSchema>,
    ChannelMessage
  >
>()
assertEqual<
  Equal<
    z.infer<typeof registerMessageSchema>,
    RegisterMessage
  >
>()
assertEqual<
  Equal<
    z.infer<typeof broadcastMessageSchema>,
    BroadcastMessage
  >
>()
assertEqual<
  Equal<z.infer<typeof systemMessageSchema>, SystemMessage>
>()
assertEqual<
  Equal<
    z.infer<typeof commandMessageSchema>,
    CommandMessage
  >
>()
assertEqual<
  Equal<z.infer<typeof relayIncomingSchema>, RelayIncoming>
>()
assertEqual<
  Equal<z.infer<typeof relayOutgoingSchema>, RelayOutgoing>
>()

// runtime assignment both directions (value-level guard the type checks the shapes)
const assignIn: z.infer<typeof relayIncomingSchema> =
  {} as RelayIncoming
const assignInBack: RelayIncoming = {} as z.infer<
  typeof relayIncomingSchema
>
const assignOut: z.infer<typeof relayOutgoingSchema> =
  {} as RelayOutgoing
const assignOutBack: RelayOutgoing = {} as z.infer<
  typeof relayOutgoingSchema
>
void assignIn
void assignInBack
void assignOut
void assignOutBack

describe('ws-schemas relayIncomingSchema', () => {
  it('accepts a valid join frame', () => {
    const r = relayIncomingSchema.safeParse({
      type: 'join',
      channel: 'abc123',
    })
    expect(r.success).toBe(true)
  })

  it('accepts a valid register frame with null fileName', () => {
    const r = relayIncomingSchema.safeParse({
      type: 'register',
      channel: 'abc123',
      fileName: null,
    })
    expect(r.success).toBe(true)
  })

  it('accepts a valid channel message frame', () => {
    const r = relayIncomingSchema.safeParse({
      type: 'message',
      channel: 'abc123',
      message: { id: 'cmd-1', command: 'inspect' },
    })
    expect(r.success).toBe(true)
  })

  it('accepts a plugin RESPONSE channel frame without command', () => {
    // The real Figma plugin replies with { id, result } and NO command
    // (correlation is by id). The relay must forward it, not drop it.
    const r = relayIncomingSchema.safeParse({
      type: 'message',
      channel: 'abc123',
      message: { id: 'cmd-1', result: { pages: [] } },
    })
    expect(r.success).toBe(true)
  })

  it('rejects an empty channel', () => {
    const r = relayIncomingSchema.safeParse({
      type: 'join',
      channel: '',
    })
    expect(r.success).toBe(false)
  })

  it('rejects an unknown frame type (no more ping)', () => {
    const r = relayIncomingSchema.safeParse({
      type: 'ping',
    })
    expect(r.success).toBe(false)
  })

  it('rejects a malformed frame missing required fields', () => {
    const r = relayIncomingSchema.safeParse({
      type: 'message',
      channel: 'x',
    })
    expect(r.success).toBe(false)
  })
})

describe('ws-schemas relayOutgoingSchema', () => {
  it('accepts a valid broadcast frame', () => {
    const r = relayOutgoingSchema.safeParse({
      type: 'broadcast',
      message: {
        id: 'cmd-1',
        command: 'inspect',
        result: { ok: true },
      },
    })
    expect(r.success).toBe(true)
  })

  it('accepts a broadcast of a plugin response without command', () => {
    // The forwarded plugin response { id, result } reaches the server as a
    // broadcast; figma-client must accept it (it correlates by id).
    const r = relayOutgoingSchema.safeParse({
      type: 'broadcast',
      message: { id: 'cmd-1', result: { ok: true } },
    })
    expect(r.success).toBe(true)
  })

  it('accepts a valid system frame', () => {
    const r = relayOutgoingSchema.safeParse({
      type: 'system',
      message: { id: 'cmd-1', result: 'joined' },
    })
    expect(r.success).toBe(true)
  })

  it('rejects a pong frame (Ping/Pong removed)', () => {
    const r = relayOutgoingSchema.safeParse({
      type: 'pong',
      name: 'x',
      version: '1',
    })
    expect(r.success).toBe(false)
  })
})

describe('majorMinor', () => {
  it('extracts major.minor from a semver string', () => {
    expect(majorMinor('0.0.1')).toBe('0.0')
    expect(majorMinor('1.2.3')).toBe('1.2')
    expect(majorMinor('0.1.0')).toBe('0.1')
  })
  it('APP_VERSION is a semver string', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('registerMessageSchema version', () => {
  it('parses a register message that carries a version', () => {
    const parsed = registerMessageSchema.parse({
      type: 'register',
      channel: 'abc',
      fileName: null,
      version: APP_VERSION,
    })
    expect(parsed.version).toBe(APP_VERSION)
  })

  it('parses a register message WITHOUT a version (optional, old plugins)', () => {
    const parsed = registerMessageSchema.parse({
      type: 'register',
      channel: 'abc',
      fileName: null,
    })
    expect(parsed.version).toBeUndefined()
  })
})
