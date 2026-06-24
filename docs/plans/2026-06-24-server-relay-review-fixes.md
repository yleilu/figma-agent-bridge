---
title: Server + Relay Review Fixes — Implementation Plan
created: 2026-06-24T02:38:40+08:00
tags:
  - plan
  - figma-bridge
  - relay
  - server
  - code-review
type: plan
related:
  - "[[figma-bridge/docs/specs/2026-06-24-server-relay-review-fixes-design]]"
---

# Server + Relay Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all 30 confirmed findings from the server+relay deep review (no P0s) without regressing the green suite (251 tests), landing each workstream as separate reviewable commits.

**Architecture:** Six TDD workstreams. WS-0 (test infra) and WS-1 (shared protocol zod SSOT) land first; WS-1 gates the two WS-frame-validation consumers (WS-2 relay, WS-3 client). WS-2 refactors the relay's module-global state into a per-server context object; WS-4 (parser fidelity) and WS-5 (tools robustness) depend only on WS-0. Cross-cutting names/signatures are pinned as contracts (A–F) in the design spec and reused verbatim across tasks.

**Tech Stack:** Bun + TypeScript, zod, @modelcontextprotocol/sdk, bun:test. Test: `bun test <path>`; typecheck: `cd packages/<pkg> && bun run typecheck`; full suite: `bun --filter '@figma-agent-bridge/*' test`.

**Spec:** [[figma-bridge/docs/specs/2026-06-24-server-relay-review-fixes-design|Design spec]] (`docs/specs/2026-06-24-server-relay-review-fixes-design.md`).

## Execution order

WS-0 → WS-1 → (WS-2, WS-3 after WS-1) ; (WS-4, WS-5 after WS-0, parallel-safe). Gate every task on typecheck + full suite green.

---

## WS-0 · Test infrastructure

### WS-0 · Task 1: Mock plugin echoes received params; e2e asserts serialized gradient + effect reach the plugin

**Files:**
- Modify: `packages/server/test/mocks/mock-plugin.ts` (`create_node` case lines 127–145; `create_tree` case lines 147–179)
- Test: `packages/server/test/integration/e2e-create.test.ts` (extend existing `create_tree with gradient fills` test, lines 199–219; add one new `it` after it)

Rationale: Today the mock fabricates `{ id, name, type, parentId }` purely from `type`/`name` and drops everything else. A serialization bug in `convertNodeSpec`/`parseFillExpressions`/`parseEffectExpressions` (e.g. wrong `angle`, dropped `gradientStops`, malformed `offset`) is invisible because the result never reflects the input. Merging the received `nodeSpec`/`treeSpec` into the returned node makes the wire-serialized fills/effects/layout observable, so e2e tests (and WS-4's exact-string round-trips) can assert them. The on-the-wire serialized shapes are exactly what `expression-parser.ts` produces: a gradient is `{ type: 'GRADIENT_LINEAR', gradientStops: [{ position, color: { r,g,b,a } }], angle }` and a drop shadow is `{ type: 'DROP_SHADOW', offset: { x, y }, radius, color: { r,g,b,a } }`.

- [ ] **Step 1: Write the failing test**

Replace the existing `create_tree with gradient fills` test (currently asserts only `data.type === 'RECTANGLE'`) with a version that asserts the serialized gradient is echoed back, and add a second test for an effect. Both use `135deg` so the angle assertion is load-bearing.

```ts
  it('create_tree echoes serialized gradient fill (angle + stops) back from plugin', async () => {
    const result = await handleCreateTree(
      {
        parentId: 'page:1',
        node: {
          type: 'RECTANGLE',
          name: 'Gradient BG',
          size: [400, 300],
          fills: [
            'linear-gradient(135deg, #FF6B6B 0%, #4ECDC4 100%)',
          ],
        },
      },
      client,
    )

    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('RECTANGLE')

    // The mock now echoes the params it received, so a serialization
    // regression (dropped stops, wrong angle) is visible here.
    const fills = data.fills as {
      type: string
      angle: number
      gradientStops: {
        position: number
        color: { r: number; g: number; b: number; a: number }
      }[]
    }[]
    expect(fills).toHaveLength(1)
    expect(fills[0].type).toBe('GRADIENT_LINEAR')
    expect(fills[0].angle).toBe(135)
    expect(fills[0].gradientStops).toHaveLength(2)
    expect(fills[0].gradientStops[0].position).toBe(0)
    expect(fills[0].gradientStops[0].color.r).toBeCloseTo(
      1,
      2,
    ) // #FF -> 1.0
    expect(fills[0].gradientStops[1].position).toBe(1)
    expect(fills[0].gradientStops[1].color.b).toBeCloseTo(
      0.769,
      2,
    ) // #C4 -> 0.769
  })

  it('create_node echoes serialized effect (drop shadow) back from plugin', async () => {
    const result = await handleCreateNode(
      {
        parentId: 'page:1',
        node: {
          type: 'FRAME',
          name: 'Shadow Box',
          size: [200, 200],
          effects: ['shadow(0,4,8,#00000040)'],
        },
      },
      client,
    )

    const data = JSON.parse(
      result.content[0].text,
    ) as Record<string, unknown>
    expect(data.type).toBe('FRAME')

    const effects = data.effects as {
      type: string
      offset: { x: number; y: number }
      radius: number
      color: { r: number; g: number; b: number; a: number }
    }[]
    expect(effects).toHaveLength(1)
    expect(effects[0].type).toBe('DROP_SHADOW')
    expect(effects[0].offset).toEqual({ x: 0, y: 4 })
    expect(effects[0].radius).toBe(8)
    expect(effects[0].color.a).toBeCloseTo(0.251, 2) // #40 -> 0.251
  })
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/server/test/integration/e2e-create.test.ts -t "echoes serialized"`

Expected: FAIL. Both new tests fail at `data.fills`/`data.effects` being `undefined` (`expect(fills).toHaveLength(1)` throws "received value must be an array, got undefined") because the current mock returns only `{ id, name, type, parentId }` and never echoes the received `node` params.

- [ ] **Step 3: Implement**

Edit `packages/server/test/mocks/mock-plugin.ts`. Replace the `create_node` case body (lines 127–145) with one that merges the received `nodeSpec` (minus its `children`, which is a tree concern) into the fabricated result, so serialized `fills`/`effects`/`layout`/`strokes` are echoed:

```ts
      case 'create_node': {
        const nodeSpec = cmd.params?.node as
          | Record<string, unknown>
          | undefined
        const parentId = cmd.params?.parentId as string
        const nodeType = nodeSpec?.type as string
        // Echo the received node spec back (serialized fills/
        // effects/layout/strokes) so e2e tests can assert that the
        // converted spec reached the plugin intact. SECTION nodes use
        // MinimalFillsMixin (read-only fills); the real plugin guards
        // before assigning, but echoing the spec is sufficient for
        // serialization-regression coverage.
        const { children: _children, ...echo } = nodeSpec ?? {}
        result = {
          ...echo,
          id: `created:${Math.random().toString(36).slice(2, 8)}`,
          name: (nodeSpec?.name as string) ?? nodeType,
          type: nodeType,
          parentId,
        }
        break
      }
```

Replace the `create_tree` case body (lines 147–179) so it echoes the root tree spec (keeping its `children` for tree assertions) alongside the computed `totalNodes`:

```ts
      case 'create_tree': {
        const treeSpec = cmd.params?.node as
          | Record<string, unknown>
          | undefined
        const treeParentId = cmd.params?.parentId as string
        const countNodes = (
          node: Record<string, unknown>,
        ): number => {
          let count = 1
          const children = node.children as
            | Record<string, unknown>[]
            | undefined
          if (children) {
            for (const child of children) {
              count += countNodes(child)
            }
          }
          return count
        }
        const totalNodes = treeSpec
          ? countNodes(treeSpec)
          : 1
        // Echo the received tree spec back (serialized fills/effects/
        // layout, plus children) so e2e/round-trip tests can assert
        // the converted spec reached the plugin intact.
        result = {
          ...(treeSpec ?? {}),
          id: `created:${Math.random().toString(36).slice(2, 8)}`,
          name:
            (treeSpec?.name as string) ??
            (treeSpec?.type as string),
          type: treeSpec?.type as string,
          parentId: treeParentId,
          totalNodes,
        }
        break
      }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/server/test/integration/e2e-create.test.ts -t "echoes serialized"`

Expected: PASS (2 tests). The gradient case sees `fills[0].angle === 135` and two stops; the effect case sees `effects[0].type === 'DROP_SHADOW'` with `offset { x:0, y:4 }`, `radius 8`, alpha `~0.251`.

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`

Expected: typecheck clean; 0 fail. Suite count rises from 251 to 252 (the e2e-create file gains one net `it` — the old `create_tree with gradient fills` becomes the gradient-echo test and one new effect-echo test is added). The `creates SECTION node ignoring unsupported fills gracefully` test still passes: it asserts only `type`/`name`, both of which the echo still sets explicitly.

```bash
git add packages/server/test/mocks/mock-plugin.ts packages/server/test/integration/e2e-create.test.ts && git commit -m "test(server): mock plugin echoes received params so e2e can assert serialized fills/effects reach plugin"
```

---

## WS-1 · Shared protocol SSOT

Owns contract (B). Establishes `shared/src/ws-schemas.ts` as the single source of truth for the relay wire protocol, removes the application-level Ping/Pong types, and relaxes `connectParamsSchema.channel` so `index.ts`'s connect registration can use it as SSOT (item 25).

Cross-refs for other authors (do NOT edit those files here):
- **WS-2**: removing the `ping` branch from `relay.ts` and deleting/moving `relay.test.ts`'s ping/pong test (`relay.test.ts:12` imports `PongMessage`; lines 157-161 assert the pong frame) is WS-2's responsibility. After this workstream lands, `PongMessage` no longer exists in `@figma-agent-bridge/shared`, so `relay.ts` and `relay.test.ts` will not typecheck until WS-2 lands. **Land WS-1 and WS-2 together** (or WS-2 immediately after) — the relay package is red in between by design.
- **WS-2 (item 26)**: types relay send paths against `RelayOutgoing` (= `Broadcast | System`). No edit here.

---

### WS-1 · Task 1: Create ws-schemas.ts SSOT + drop Ping/Pong from types

**Files:**
- Create: `packages/shared/src/ws-schemas.ts`
- Modify: `packages/shared/src/types.ts` (lines 27-29, 37-51 — remove `PingMessage`/`PongMessage`, re-narrow `RelayIncoming`/`RelayOutgoing`)
- Modify: `packages/shared/src/index.ts` (line 1-5 — add `export * from './ws-schemas'`)
- Test: `packages/shared/test/ws-schemas.test.ts` (new)

- [ ] **Step 1: Write the failing test**

The test file covers both the runtime parsing behavior of the new schemas AND a compile-time assertion that `z.infer` of each schema is mutually assignable with the hand-written TS type (per contract B). The type-level checks use a local `AssertEqual` helper plus `satisfies`-style bidirectional assignment functions — no new dependency (zod v3 only; no `expectTypeOf`).

```ts
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
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false
const assertEqual = <_T extends true>(): void => undefined

assertEqual<Equal<z.infer<typeof joinMessageSchema>, JoinMessage>>()
assertEqual<Equal<z.infer<typeof channelMessageSchema>, ChannelMessage>>()
assertEqual<Equal<z.infer<typeof registerMessageSchema>, RegisterMessage>>()
assertEqual<Equal<z.infer<typeof broadcastMessageSchema>, BroadcastMessage>>()
assertEqual<Equal<z.infer<typeof systemMessageSchema>, SystemMessage>>()
assertEqual<Equal<z.infer<typeof commandMessageSchema>, CommandMessage>>()
assertEqual<Equal<z.infer<typeof relayIncomingSchema>, RelayIncoming>>()
assertEqual<Equal<z.infer<typeof relayOutgoingSchema>, RelayOutgoing>>()

// runtime assignment both directions (value-level guard the type checks the shapes)
const _in: z.infer<typeof relayIncomingSchema> = {} as RelayIncoming
const _inBack: RelayIncoming = {} as z.infer<typeof relayIncomingSchema>
const _out: z.infer<typeof relayOutgoingSchema> = {} as RelayOutgoing
const _outBack: RelayOutgoing = {} as z.infer<typeof relayOutgoingSchema>
void _in
void _inBack
void _out
void _outBack

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

  it('rejects an empty channel', () => {
    const r = relayIncomingSchema.safeParse({
      type: 'join',
      channel: '',
    })
    expect(r.success).toBe(false)
  })

  it('rejects an unknown frame type (no more ping)', () => {
    const r = relayIncomingSchema.safeParse({ type: 'ping' })
    expect(r.success).toBe(false)
  })

  it('rejects a malformed frame missing required fields', () => {
    const r = relayIncomingSchema.safeParse({ type: 'message', channel: 'x' })
    expect(r.success).toBe(false)
  })
})

describe('ws-schemas relayOutgoingSchema', () => {
  it('accepts a valid broadcast frame', () => {
    const r = relayOutgoingSchema.safeParse({
      type: 'broadcast',
      message: { id: 'cmd-1', command: 'inspect', result: { ok: true } },
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
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `bun test packages/shared/test/ws-schemas.test.ts`
Expected: FAIL — module `@figma-agent-bridge/shared/ws-schemas` does not resolve (file not created yet); `relayIncomingSchema` etc. are undefined.

- [ ] **Step 3: Implement**

Create `packages/shared/src/ws-schemas.ts` with the EXACT schemas from contract (B):

```ts
// packages/shared/src/ws-schemas.ts
import { z } from 'zod'

export const commandMessageSchema = z.object({
  id: z.string(),
  command: z.string(),
  params: z.record(z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
})

export const joinMessageSchema = z.object({
  type: z.literal('join'),
  channel: z.string().min(1),
})

export const channelMessageSchema = z.object({
  type: z.literal('message'),
  channel: z.string().min(1),
  message: commandMessageSchema,
})

export const registerMessageSchema = z.object({
  type: z.literal('register'),
  channel: z.string().min(1),
  fileName: z.string().nullable(),
})

export const relayIncomingSchema = z.discriminatedUnion('type', [
  joinMessageSchema,
  channelMessageSchema,
  registerMessageSchema,
])

export const broadcastMessageSchema = z.object({
  type: z.literal('broadcast'),
  message: commandMessageSchema,
})

export const systemMessageSchema = z.object({
  type: z.literal('system'),
  message: z.object({ id: z.string(), result: z.string() }),
})

export const relayOutgoingSchema = z.discriminatedUnion('type', [
  broadcastMessageSchema,
  systemMessageSchema,
])
```

Edit `packages/shared/src/types.ts` — remove `PingMessage` (lines 27-29) and `PongMessage` (lines 37-41), and re-narrow the unions (lines 43-51). Replace lines 27-51 with:

```ts
export type RegisterMessage = {
  type: 'register'
  channel: string
  fileName: string | null
}

export type RelayIncoming =
  | JoinMessage
  | ChannelMessage
  | RegisterMessage
export type RelayOutgoing = BroadcastMessage | SystemMessage
```

> Note: this reorders `RegisterMessage` above the unions (it previously sat between `PingMessage` and `PongMessage`). `JoinMessage`, `ChannelMessage`, `BroadcastMessage`, `SystemMessage`, `CommandMessage` are unchanged. The `commandMessageSchema`'s inferred type (`params?: Record<string, unknown>`, `result?: unknown`, `error?: string`) matches the existing hand-written `CommandMessage` exactly — the `Equal<>` assertion in the test enforces this.

Edit `packages/shared/src/index.ts` — add the new export after `./schemas`:

```ts
export * from './types'
export * from './schemas'
export * from './ws-schemas'
export * from './create-types'
export * from './create-schemas'
export * from './constants'
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `bun test packages/shared/test/ws-schemas.test.ts`
Expected: PASS (all runtime cases green; type-level `assertEqual` calls compile).

- [ ] **Step 5: Typecheck + full suite + commit**
Run: `cd packages/shared && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: `shared` typecheck clean; `shared` suite now 2 → ≥ (2 + new ws-schemas tests), 0 fail in shared. **Known cross-package red until WS-2 lands:** `relay` typecheck/test will fail because `relay.ts:6` and `relay.test.ts:12` import the now-deleted `PongMessage`. This is expected — WS-2 (item 24/26) removes those. Verify the *shared* package is green in isolation: `cd packages/shared && bun run typecheck && bun test packages/shared/`.

```bash
git add packages/shared/src/ws-schemas.ts packages/shared/src/types.ts packages/shared/src/index.ts packages/shared/test/ws-schemas.test.ts && git commit -m "feat(shared): add ws-protocol zod SSOT, remove app-level ping/pong"
```

---

### WS-1 · Task 2: Relax connectParamsSchema.channel + use it as SSOT in index.ts (item 25)

**Files:**
- Modify: `packages/shared/src/schemas.ts` (lines 3-10 — add `.optional()` to `channel`)
- Modify: `packages/server/src/index.ts` (lines 4-21 import block; lines 65-70 connect registration — only the connect block; WS-5 edits item 15 elsewhere)
- Test: `packages/shared/test/connect-params.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/test/connect-params.test.ts
import { describe, expect, it } from 'bun:test'
import { connectParamsSchema } from '@figma-agent-bridge/shared/schemas'

describe('connectParamsSchema', () => {
  it('accepts a channel string', () => {
    const r = connectParamsSchema.safeParse({ channel: 'abc123' })
    expect(r.success).toBe(true)
  })

  it('accepts an omitted channel (auto-discovery)', () => {
    const r = connectParamsSchema.safeParse({})
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.channel).toBeUndefined()
  })

  it('rejects an empty channel string', () => {
    const r = connectParamsSchema.safeParse({ channel: '' })
    expect(r.success).toBe(false)
  })

  it('exposes .shape.channel for SSOT tool registration', () => {
    expect(connectParamsSchema.shape.channel).toBeDefined()
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `bun test packages/shared/test/connect-params.test.ts -t "accepts an omitted channel"`
Expected: FAIL — `connectParamsSchema` currently requires `channel` (`z.string().min(1)` is not optional), so `safeParse({})` returns `success: false`.

- [ ] **Step 3: Implement**

Edit `packages/shared/src/schemas.ts` — relax `channel` to `.optional()`:

```ts
export const connectParamsSchema = z.object({
  channel: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Channel ID to join. Pairs with the Figma plugin. Omit to auto-discover.',
    ),
})
```

Edit `packages/server/src/index.ts` — import `connectParamsSchema` and use `.shape` (item 25 / contract F · WS-1 item 25). Add `connectParamsSchema` to the shared import list (after line 7, alongside the other schema imports):

```ts
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_PORT,
  connectParamsSchema,
  inspectParamsSchema,
  inspectPageLayoutParamsSchema,
  inspectStylesParamsSchema,
  inspectComponentsParamsSchema,
  searchParamsSchema,
  getNodeParamsSchema,
  getNodesParamsSchema,
  listPagesParamsSchema,
  exportParamsSchema,
  createNodeParamsSchema,
  createTreeParamsSchema,
  createComponentParamsSchema,
  createFromSvgParamsSchema,
} from '@figma-agent-bridge/shared'
```

Replace the connect registration (lines 65-70) — drop the inline `{ channel: z.string().min(1).optional() }`:

```ts
server.tool(
  'connect',
  connectParamsSchema.shape,
  async ({ channel }) =>
    handleConnect({ channel }, client, relayHttpUrl, port),
)
```

> `handleConnect` already accepts `{ channel?: string }` (session.ts:9-15), so the inferred `channel: string | undefined` from `connectParamsSchema.shape` is type-compatible. The `z` import in index.ts stays (still used by other tool registrations / WS-5's item 15). Only the connect block changes — no other lines touched.

- [ ] **Step 4: Run the test, verify it passes**
Run: `bun test packages/shared/test/connect-params.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Typecheck + full suite + commit**
Run: `cd packages/shared && bun run typecheck && cd /Users/lei/wip/figma-bridge && cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: `shared` + `server` typecheck clean; `server` suite stays 240, `shared` grows by the new connect-params tests, 0 fail in shared/server. (Same known `relay` red from Task 1 until WS-2 lands.)

```bash
git add packages/shared/src/schemas.ts packages/server/src/index.ts packages/shared/test/connect-params.test.ts && git commit -m "refactor(server): use connectParamsSchema.shape as connect tool SSOT"
```

---

## WS-2 · Relay hardening

Depends on WS-1 (shared `ws-schemas.ts` exporting `relayIncomingSchema`/`relayOutgoingSchema`, and `types.ts` with `PingMessage`/`PongMessage` removed and `RelayIncoming = Join|Channel|Register`, `RelayOutgoing = Broadcast|System`). All tasks operate on `packages/relay/src/relay.ts` and `packages/relay/test/relay.test.ts`. Sequenced so the behavior-preserving context refactor (Task 1) lands first with the existing 9 tests green, then features layer on.

---

### WS-2 · Task 1: Refactor module globals into per-server `RelayContext` (behavior-preserving)

Moves `channels`/`clientChannels`/`channelRegistry`/`alive`/`heartbeatTimer` off the module into a per-server `RelayContext` (contract A), registered in `const contexts = new WeakMap<Server<WsData>, RelayContext>()`. Adds `ctx.sockets` (all upgraded sockets) and `ctx.rate` now (seeded, unused until Task 5) so the shape matches contract A exactly. `startRelay(port, opts)` owns its ctx + timer; `stopRelay` looks ctx up and clears that instance. No protocol/behavior change yet — the existing 9 tests stay green and prove it. The obsolete app ping/pong test is removed here since WS-1 deleted `PingMessage`/`PongMessage` (the relay still has a `parsed.type === 'ping'` branch using `PongMessage`, which no longer typechecks; this task also removes that branch).

**Files:**
- Modify: `packages/relay/src/relay.ts` (full rewrite of module-state + `startRelay`/`stopRelay`, lines 1–215)
- Test: `packages/relay/test/relay.test.ts` (remove obsolete ping/pong test lines 153–167 and its `PongMessage`/`APP_VERSION` imports; add a double-start isolation test)

- [ ] **Step 1: Write the failing test**

In `packages/relay/test/relay.test.ts`, delete the now-invalid `'responds to ping with pong identity'` test (lines 153–167) and the `PongMessage` import (line 12) plus the `APP_VERSION` import (line 19). Then add, inside the top-level `describe('relay', …)` block (after the existing broadcast test), a double-start isolation test that proves each `startRelay` owns its own timer/state:

```ts
it('two relays on different ports keep independent state', async () => {
  const SECOND_PORT = 3100
  const second = startRelay(SECOND_PORT)

  // join on the first server's port only
  const ws = await connect()
  const nextMessage = createMessageQueue(ws)
  ws.send(JSON.stringify({ type: 'join', channel: 'iso-ch' }))
  await nextMessage()

  const firstChannels = (await (
    await fetch(`${HTTP_URL}/channels`)
  ).json()) as ChannelInfo[]
  const secondChannels = (await (
    await fetch(`http://localhost:${SECOND_PORT}/channels`)
  ).json()) as ChannelInfo[]

  expect(firstChannels.map(c => c.channel)).toEqual(['iso-ch'])
  expect(secondChannels).toEqual([])

  await closeWs(ws)
  stopRelay(second)
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/relay/test/relay.test.ts`

Expected: FAIL — with the current module-global state, both servers share the single `channelRegistry`, so `secondChannels` is `['iso-ch']` not `[]` (`expect(secondChannels).toEqual([])` fails). (And before this edit, `bun run typecheck` already fails on the `PongMessage`/`'ping'` branch since WS-1 removed those types.)

- [ ] **Step 3: Implement**

Rewrite `packages/relay/src/relay.ts` to contract (A) — per-server `RelayContext`, `contexts` WeakMap, handlers closing over `ctx`, ping branch removed:

```ts
import type { Server, ServerWebSocket } from 'bun'
import type {
  BroadcastMessage,
  ChannelInfo,
  ChannelMessage,
  RelayIncoming,
  SystemMessage,
} from '@figma-agent-bridge/shared'
import { DEFAULT_PORT } from '@figma-agent-bridge/shared'
import { randomUUID } from 'node:crypto'

const DEFAULT_HEARTBEAT_INTERVAL = 30_000

type WsData = { id: string }
type RateState = { tokens: number; last: number }

type RelayContext = {
  channels: Map<string, Set<ServerWebSocket<WsData>>>
  clientChannels: Map<string, Set<string>>
  channelRegistry: Map<string, ChannelInfo>
  sockets: Set<ServerWebSocket<WsData>>
  alive: WeakMap<ServerWebSocket<WsData>, boolean>
  rate: WeakMap<ServerWebSocket<WsData>, RateState>
  heartbeatTimer: ReturnType<typeof setInterval> | null
}

const contexts = new WeakMap<Server<WsData>, RelayContext>()

const createContext = (): RelayContext => ({
  channels: new Map(),
  clientChannels: new Map(),
  channelRegistry: new Map(),
  sockets: new Set(),
  alive: new WeakMap(),
  rate: new WeakMap(),
  heartbeatTimer: null,
})

const removeClient = (
  ctx: RelayContext,
  ws: ServerWebSocket<WsData>,
) => {
  const { id } = ws.data
  const joined = ctx.clientChannels.get(id)

  if (joined !== undefined) {
    joined.forEach(channel => {
      const members = ctx.channels.get(channel)
      if (members !== undefined) {
        members.delete(ws)
        if (members.size === 0) {
          ctx.channels.delete(channel)
          ctx.channelRegistry.delete(channel)
        }
      }
    })
    ctx.clientChannels.delete(id)
  }
}

const handleJoin = (
  ctx: RelayContext,
  ws: ServerWebSocket<WsData>,
  channel: string,
) => {
  const { id } = ws.data

  let members = ctx.channels.get(channel)
  if (members === undefined) {
    members = new Set()
    ctx.channels.set(channel, members)
  }
  members.add(ws)
  ctx.alive.set(ws, true)

  if (!ctx.channelRegistry.has(channel)) {
    ctx.channelRegistry.set(channel, {
      channel,
      fileName: null,
      connectedAt: Date.now(),
    })
  }

  let joined = ctx.clientChannels.get(id)
  if (joined === undefined) {
    joined = new Set()
    ctx.clientChannels.set(id, joined)
  }
  joined.add(channel)

  const reply: SystemMessage = {
    type: 'system',
    message: {
      id: randomUUID(),
      result: `Connected to channel: ${channel}`,
    },
  }

  ws.send(JSON.stringify(reply))
}

const handleRegister = (
  ctx: RelayContext,
  channel: string,
  fileName: string | null,
) => {
  const entry = ctx.channelRegistry.get(channel)
  if (entry !== undefined) {
    entry.fileName = fileName
  }
}

const handleMessage = (
  ctx: RelayContext,
  channel: string,
  message: ChannelMessage,
) => {
  const members = ctx.channels.get(channel)
  if (members === undefined) {
    return
  }

  const broadcast: BroadcastMessage = {
    type: 'broadcast',
    message: message.message,
  }
  const payload = JSON.stringify(broadcast)

  members.forEach(client => {
    client.send(payload)
  })
}

export type StartRelayOptions = {
  hostname?: string
  heartbeatInterval?: number
}

export const startRelay = (
  port = DEFAULT_PORT,
  opts: StartRelayOptions = {},
): Server<WsData> => {
  const ctx = createContext()
  const hostname =
    opts.hostname ?? process.env.RELAY_BIND ?? '127.0.0.1'
  const heartbeatInterval =
    opts.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL

  const server = Bun.serve<WsData>({
    port,
    hostname,
    fetch: (req, srv) => {
      if (
        req.headers.get('upgrade')?.toLowerCase() ===
        'websocket'
      ) {
        const upgraded = srv.upgrade(req, {
          data: { id: randomUUID() },
        })
        if (upgraded) {
          return undefined
        }
      }

      const url = new URL(req.url)
      if (
        req.method === 'GET' &&
        url.pathname === '/channels'
      ) {
        return Response.json(
          Array.from(ctx.channelRegistry.values()),
        )
      }

      return new Response('WebSocket only', {
        status: 426,
      })
    },
    websocket: {
      open: ws => {
        ctx.sockets.add(ws)
        ctx.alive.set(ws, true)
      },
      message: (ws, raw) => {
        let parsed: RelayIncoming

        try {
          parsed = JSON.parse(raw as string) as RelayIncoming
        } catch {
          return
        }

        if (parsed.type === 'join') {
          handleJoin(ctx, ws, parsed.channel)
        } else if (parsed.type === 'register') {
          handleRegister(ctx, parsed.channel, parsed.fileName)
        } else if (parsed.type === 'message') {
          handleMessage(ctx, parsed.channel, parsed)
        }
      },
      pong: ws => {
        ctx.alive.set(ws, true)
      },
      close: ws => {
        ctx.sockets.delete(ws)
        removeClient(ctx, ws)
      },
    },
  })

  ctx.heartbeatTimer = setInterval(() => {
    for (const ws of ctx.sockets) {
      if (ctx.alive.get(ws) === false) {
        ws.close()
        continue
      }
      ctx.alive.set(ws, false)
      ws.ping()
    }
  }, heartbeatInterval)

  contexts.set(server, ctx)
  return server
}

export const stopRelay = (server: Server<WsData>): void => {
  const ctx = contexts.get(server)
  if (ctx !== undefined) {
    if (ctx.heartbeatTimer !== null) {
      clearInterval(ctx.heartbeatTimer)
      ctx.heartbeatTimer = null
    }
    ctx.channels.clear()
    ctx.clientChannels.clear()
    ctx.channelRegistry.clear()
    ctx.sockets.clear()
    contexts.delete(server)
  }
  server.stop(true)
}
```

Note: this task already wires `open`/`close` socket tracking and heartbeat-over-`ctx.sockets` (contract A `sockets` + items 8/17 substrate) because the old module-level heartbeat iterated `channels`; switching to `ctx.sockets` here keeps the timer behavior equivalent for connected clients while matching contract A. Caps/rate/validation/register-guard/sender-exclusion are layered in Tasks 2–5.

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/relay/test/relay.test.ts`

Expected: PASS — 9 existing tests (minus the removed ping test, plus the new isolation test) all green; `secondChannels` is `[]`.

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/relay && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`

Expected: typecheck clean, 0 fail.

```bash
git add packages/relay/src/relay.ts packages/relay/test/relay.test.ts && git commit -m "refactor(relay): move module globals into per-server RelayContext"
```

---

### WS-2 · Task 2: Validate inbound frames with `relayIncomingSchema` + bind hostname + maxPayloadLength

Replaces the raw `JSON.parse … as RelayIncoming` cast (items 1a/5/24) with `relayIncomingSchema.safeParse` (contract B) — invalid/unknown frames are dropped silently. The `'ping'` branch is already gone (Task 1); validation now also formally rejects it. Adds `maxPayloadLength: MAX_PAYLOAD_BYTES` to the websocket config and confirms the `hostname` bind landed in Task 1. Caps constants are introduced here so the file declares them once.

**Files:**
- Modify: `packages/relay/src/relay.ts` (add caps constants; `message` handler → `safeParse`; websocket config `maxPayloadLength`)
- Test: `packages/relay/test/relay.test.ts` (add malformed-frame-drop test)

- [ ] **Step 1: Write the failing test**

Add inside `describe('relay', …)`:

```ts
it('drops malformed frames without affecting the connection', async () => {
  const ws = await connect()
  const nextMessage = createMessageQueue(ws)

  // unknown discriminator -> dropped, no reply
  ws.send(JSON.stringify({ type: 'bogus', channel: 'x' }))
  // join with empty channel -> fails schema (.min(1)) -> dropped
  ws.send(JSON.stringify({ type: 'join', channel: '' }))
  // non-JSON -> dropped
  ws.send('not json at all')

  // a valid join still works on the same socket
  ws.send(JSON.stringify({ type: 'join', channel: 'ok-ch' }))
  const msg = (await nextMessage()) as SystemMessage
  expect(msg.type).toBe('system')
  expect(msg.message.result).toBe('Connected to channel: ok-ch')

  // registry has only the valid channel
  const data = (await (
    await fetch(`${HTTP_URL}/channels`)
  ).json()) as ChannelInfo[]
  expect(data.map(c => c.channel)).toEqual(['ok-ch'])

  await closeWs(ws)
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/relay/test/relay.test.ts -t "drops malformed frames"`

Expected: FAIL — current `message` handler casts `{ type: 'join', channel: '' }` through `as RelayIncoming` and calls `handleJoin(ctx, ws, '')`, registering an empty-named channel. The registry assertion `['ok-ch']` fails because it also contains `''`.

- [ ] **Step 3: Implement**

Add caps constants after `DEFAULT_HEARTBEAT_INTERVAL` (only `MAX_PAYLOAD_BYTES` is consumed this task; the rest are declared per contract A and used in Tasks 4–5):

```ts
const MAX_CHANNELS_PER_CONNECTION = 32
const MAX_MEMBERS_PER_CHANNEL = 64
const MAX_TOTAL_CHANNELS = 1024
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024
const RATE_TOKENS_PER_SEC = 50
const RATE_BURST = 100
const DEFAULT_HEARTBEAT_INTERVAL = 30_000
```

Add the schema import:

```ts
import {
  DEFAULT_PORT,
  relayIncomingSchema,
} from '@figma-agent-bridge/shared'
```

Replace the `message` handler body with a `safeParse`:

```ts
      message: (ws, raw) => {
        let json: unknown
        try {
          json = JSON.parse(raw as string)
        } catch {
          return
        }

        const parsed = relayIncomingSchema.safeParse(json)
        if (!parsed.success) {
          return
        }
        const frame = parsed.data

        if (frame.type === 'join') {
          handleJoin(ctx, ws, frame.channel)
        } else if (frame.type === 'register') {
          handleRegister(ctx, frame.channel, frame.fileName)
        } else if (frame.type === 'message') {
          handleMessage(ctx, frame.channel, frame)
        }
      },
```

Remove the now-unused `RelayIncoming` type import (the handler no longer annotates with it). Add `maxPayloadLength` to the `websocket` config object (alongside `open`/`message`/`pong`/`close`):

```ts
    websocket: {
      maxPayloadLength: MAX_PAYLOAD_BYTES,
      open: ws => {
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/relay/test/relay.test.ts -t "drops malformed frames"`

Expected: PASS.

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/relay && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`

Expected: typecheck clean, 0 fail.

```bash
git add packages/relay/src/relay.ts packages/relay/test/relay.test.ts && git commit -m "feat(relay): validate inbound frames with zod schema and cap payload size"
```

---

### WS-2 · Task 3: Register-before-join guard + typed `send(ws, msg: RelayOutgoing)` helper + sender exclusion

Three related send/registry-correctness changes (items 1b, 26, 28). (1) `handleRegister` takes `ws` and only mutates the registry when `ctx.clientChannels.get(ws.data.id)?.has(channel)` is true — a client cannot rename a channel it never joined. (2) Introduce `const send = (ws, msg: RelayOutgoing) => ws.send(JSON.stringify(msg))` and route `handleJoin`'s system reply and `handleMessage`'s broadcast through it, typing every outgoing frame against `RelayOutgoing` (contract A/B). (3) `handleMessage` excludes the sending socket from the broadcast.

**Files:**
- Modify: `packages/relay/src/relay.ts` (`handleRegister` signature + guard; `send` helper; `handleJoin`/`handleMessage` use `send`; `handleMessage` takes `ws` + excludes sender)
- Test: `packages/relay/test/relay.test.ts` (register-before-join rejection; sender-exclusion)

- [ ] **Step 1: Write the failing test**

Add inside `describe('relay', …)`:

```ts
it('ignores register for a channel the client never joined', async () => {
  const owner = await connect()
  const ownerNext = createMessageQueue(owner)
  owner.send(JSON.stringify({ type: 'join', channel: 'guard-ch' }))
  await ownerNext()

  // attacker joins a DIFFERENT channel, then tries to register guard-ch
  const attacker = await connect()
  const attackerNext = createMessageQueue(attacker)
  attacker.send(JSON.stringify({ type: 'join', channel: 'other-ch' }))
  await attackerNext()
  attacker.send(
    JSON.stringify({
      type: 'register',
      channel: 'guard-ch',
      fileName: 'HIJACK.fig',
    }),
  )
  await Bun.sleep(50)

  const data = (await (
    await fetch(`${HTTP_URL}/channels`)
  ).json()) as ChannelInfo[]
  const guard = data.find(c => c.channel === 'guard-ch')
  expect(guard?.fileName).toBeNull()

  await closeWs(owner)
  await closeWs(attacker)
})

it('excludes the sending socket from its own broadcast', async () => {
  const ws1 = await connect()
  const ws2 = await connect()
  const next1 = createMessageQueue(ws1)
  const next2 = createMessageQueue(ws2)

  ws1.send(JSON.stringify({ type: 'join', channel: 'echo-ch' }))
  await next1()
  ws2.send(JSON.stringify({ type: 'join', channel: 'echo-ch' }))
  await next2()

  ws1.send(
    JSON.stringify({
      type: 'message',
      channel: 'echo-ch',
      message: { id: 'cmd-x', command: 'noop' },
    }),
  )

  // ws2 receives the broadcast
  const broadcast = (await next2()) as BroadcastMessage
  expect(broadcast.type).toBe('broadcast')
  expect(broadcast.message.id).toBe('cmd-x')

  // ws1 must NOT receive its own broadcast: send a marker join and assert
  // the next frame ws1 sees is the system reply, not the broadcast
  ws1.send(JSON.stringify({ type: 'join', channel: 'echo-ch' }))
  const afterSelf = (await next1()) as SystemMessage
  expect(afterSelf.type).toBe('system')

  await closeWs(ws1)
  await closeWs(ws2)
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/relay/test/relay.test.ts -t "register for a channel the client never joined"` then `bun test packages/relay/test/relay.test.ts -t "excludes the sending socket"`

Expected: FAIL — (1) current `handleRegister` mutates any existing registry entry regardless of membership, so `guard?.fileName` is `'HIJACK.fig'`. (2) current `handleMessage` broadcasts to all members including the sender, so `ws1`'s queue holds the broadcast and `afterSelf` is the `broadcast` frame (`type` `'broadcast'`, not `'system'`).

- [ ] **Step 3: Implement**

Add the typed send helper (import `RelayOutgoing` type) above `removeClient`:

```ts
import type {
  BroadcastMessage,
  ChannelInfo,
  ChannelMessage,
  RelayOutgoing,
  SystemMessage,
} from '@figma-agent-bridge/shared'
```

```ts
const send = (
  ws: ServerWebSocket<WsData>,
  msg: RelayOutgoing,
) => {
  ws.send(JSON.stringify(msg))
}
```

Route `handleJoin`'s reply through `send`:

```ts
  const reply: SystemMessage = {
    type: 'system',
    message: {
      id: randomUUID(),
      result: `Connected to channel: ${channel}`,
    },
  }

  send(ws, reply)
```

Add `ws` param + membership guard to `handleRegister`:

```ts
const handleRegister = (
  ctx: RelayContext,
  ws: ServerWebSocket<WsData>,
  channel: string,
  fileName: string | null,
) => {
  if (ctx.clientChannels.get(ws.data.id)?.has(channel) !== true) {
    return
  }
  const entry = ctx.channelRegistry.get(channel)
  if (entry !== undefined) {
    entry.fileName = fileName
  }
}
```

Update its call site in the `message` handler:

```ts
        } else if (frame.type === 'register') {
          handleRegister(ctx, ws, frame.channel, frame.fileName)
```

Add `ws` param to `handleMessage`, exclude sender, send via helper:

```ts
const handleMessage = (
  ctx: RelayContext,
  ws: ServerWebSocket<WsData>,
  channel: string,
  message: ChannelMessage,
) => {
  const members = ctx.channels.get(channel)
  if (members === undefined) {
    return
  }

  const broadcast: BroadcastMessage = {
    type: 'broadcast',
    message: message.message,
  }

  members.forEach(client => {
    if (client !== ws) {
      send(client, broadcast)
    }
  })
}
```

Update its call site:

```ts
        } else if (frame.type === 'message') {
          handleMessage(ctx, ws, frame.channel, frame)
        }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/relay/test/relay.test.ts -t "register for a channel the client never joined"` then `bun test packages/relay/test/relay.test.ts -t "excludes the sending socket"`

Expected: PASS. Re-run the whole file to confirm the original `'broadcasts messages to all clients in channel'` test (ws2 receives, ws1 not asserted) still passes.

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/relay && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`

Expected: typecheck clean, 0 fail.

```bash
git add packages/relay/src/relay.ts packages/relay/test/relay.test.ts && git commit -m "feat(relay): guard register by membership and exclude broadcast sender"
```

---

### WS-2 · Task 4: Resource caps + per-connection token-bucket rate limit (reject over-limit joins)

Enforces `MAX_*` caps and a per-connection token bucket (item 7). A join is rejected — with a `SystemMessage` carrying an `Error:` result — when it would exceed `MAX_CHANNELS_PER_CONNECTION`, `MAX_MEMBERS_PER_CHANNEL`, or `MAX_TOTAL_CHANNELS`, or when the connection's token bucket is empty (`RATE_TOKENS_PER_SEC` refill, `RATE_BURST` ceiling). The bucket is seeded on `open` into `ctx.rate` and consumed once per accepted inbound frame. Rejections reuse `send(ws, …)` so they're typed `RelayOutgoing`.

**Files:**
- Modify: `packages/relay/src/relay.ts` (`open` seeds rate bucket; `consumeToken` helper; cap checks in `handleJoin`; reject path)
- Test: `packages/relay/test/relay.test.ts` (over-cap channels-per-connection rejection)

- [ ] **Step 1: Write the failing test**

The deterministic, fast cap to test is `MAX_CHANNELS_PER_CONNECTION = 32`: one socket joins 32 channels (accepted), the 33rd is rejected with a system error. Add inside `describe('relay', …)`:

```ts
it('rejects joins beyond the per-connection channel cap', async () => {
  const ws = await connect()
  const nextMessage = createMessageQueue(ws)

  // 32 accepted joins
  for (let i = 0; i < 32; i++) {
    ws.send(JSON.stringify({ type: 'join', channel: `cap-${i}` }))
    const ok = (await nextMessage()) as SystemMessage
    expect(ok.message.result).toBe(`Connected to channel: cap-${i}`)
  }

  // 33rd is rejected
  ws.send(JSON.stringify({ type: 'join', channel: 'cap-over' }))
  const rejected = (await nextMessage()) as SystemMessage
  expect(rejected.type).toBe('system')
  expect(rejected.message.result).toMatch(/^Error:/)

  // rejected channel never entered the registry
  const data = (await (
    await fetch(`${HTTP_URL}/channels`)
  ).json()) as ChannelInfo[]
  expect(data.some(c => c.channel === 'cap-over')).toBe(false)

  await closeWs(ws)
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/relay/test/relay.test.ts -t "rejects joins beyond the per-connection channel cap"`

Expected: FAIL — current `handleJoin` has no cap; the 33rd join succeeds with `result === 'Connected to channel: cap-over'`, so `toMatch(/^Error:/)` fails and `cap-over` appears in the registry.

- [ ] **Step 3: Implement**

Seed the rate bucket in `open`:

```ts
      open: ws => {
        ctx.sockets.add(ws)
        ctx.alive.set(ws, true)
        ctx.rate.set(ws, { tokens: RATE_BURST, last: Date.now() })
      },
```

Add a `consumeToken` helper (above the `message` handler scope — place it near `send`):

```ts
const consumeToken = (
  ctx: RelayContext,
  ws: ServerWebSocket<WsData>,
): boolean => {
  const state = ctx.rate.get(ws)
  if (state === undefined) {
    return true
  }
  const now = Date.now()
  const elapsed = (now - state.last) / 1000
  state.tokens = Math.min(
    RATE_BURST,
    state.tokens + elapsed * RATE_TOKENS_PER_SEC,
  )
  state.last = now
  if (state.tokens < 1) {
    return false
  }
  state.tokens -= 1
  return true
}
```

Make `handleJoin` cap-aware and return a boolean / send a reject. Replace the body of `handleJoin` so it checks caps before mutating, and on rejection sends an `Error:` system message:

```ts
const rejectJoin = (
  ws: ServerWebSocket<WsData>,
  reason: string,
) => {
  const reply: SystemMessage = {
    type: 'system',
    message: { id: randomUUID(), result: `Error: ${reason}` },
  }
  send(ws, reply)
}

const handleJoin = (
  ctx: RelayContext,
  ws: ServerWebSocket<WsData>,
  channel: string,
) => {
  const { id } = ws.data

  const joinedSet = ctx.clientChannels.get(id)
  const alreadyIn = joinedSet?.has(channel) === true

  if (!alreadyIn) {
    if ((joinedSet?.size ?? 0) >= MAX_CHANNELS_PER_CONNECTION) {
      rejectJoin(ws, 'channel limit reached for this connection')
      return
    }
    const existing = ctx.channels.get(channel)
    if (existing === undefined) {
      if (ctx.channels.size >= MAX_TOTAL_CHANNELS) {
        rejectJoin(ws, 'global channel limit reached')
        return
      }
    } else if (existing.size >= MAX_MEMBERS_PER_CHANNEL) {
      rejectJoin(ws, 'member limit reached for this channel')
      return
    }
  }

  let members = ctx.channels.get(channel)
  if (members === undefined) {
    members = new Set()
    ctx.channels.set(channel, members)
  }
  members.add(ws)
  ctx.alive.set(ws, true)

  if (!ctx.channelRegistry.has(channel)) {
    ctx.channelRegistry.set(channel, {
      channel,
      fileName: null,
      connectedAt: Date.now(),
    })
  }

  let joined = ctx.clientChannels.get(id)
  if (joined === undefined) {
    joined = new Set()
    ctx.clientChannels.set(id, joined)
  }
  joined.add(channel)

  const reply: SystemMessage = {
    type: 'system',
    message: {
      id: randomUUID(),
      result: `Connected to channel: ${channel}`,
    },
  }

  send(ws, reply)
}
```

Consume a token at the top of the `message` handler, after a successful `safeParse` (drop silently when starved — no reply, matching malformed-frame behavior):

```ts
        const parsed = relayIncomingSchema.safeParse(json)
        if (!parsed.success) {
          return
        }
        if (!consumeToken(ctx, ws)) {
          return
        }
        const frame = parsed.data
```

This also delivers double-join idempotency: a repeated join for a channel the socket is already in (`alreadyIn`) skips the cap checks and re-sends the confirmation, never double-counting toward `MAX_CHANNELS_PER_CONNECTION` (Set semantics) — exercised by the marker re-join in Task 3's sender-exclusion test and asserted directly in Task 5.

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/relay/test/relay.test.ts -t "rejects joins beyond the per-connection channel cap"`

Expected: PASS.

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/relay && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`

Expected: typecheck clean, 0 fail.

```bash
git add packages/relay/src/relay.ts packages/relay/test/relay.test.ts && git commit -m "feat(relay): enforce resource caps and per-connection rate limit"
```

---

### WS-2 · Task 5: Heartbeat dead-client eviction (collect-then-close) + double-join idempotency + 426 branch

Final hardening + coverage (items 8/17, double-join, 426). Confirms the heartbeat (already iterating `ctx.sockets` from Task 1) collects dead sockets into a local array and closes them **after** iteration (item 17 — decouple mutation from iteration), driven deterministically via the injectable `heartbeatInterval` (contract A). Adds explicit tests for: dead-client eviction (short interval), double-join idempotency, and the `426` non-WS/non-`/channels` branch. The `/channels` endpoint is already covered by the existing registry tests.

**Files:**
- Modify: `packages/relay/src/relay.ts` (heartbeat: collect-then-close)
- Test: `packages/relay/test/relay.test.ts` (dead-client eviction; double-join idempotency; 426 branch)

- [ ] **Step 1: Write the failing test**

Add inside `describe('relay', …)`. The eviction test starts its own short-interval relay (the outer `beforeEach` server stays on the default interval, so use a fresh port). A client that never answers native pings is forced dead by stubbing `ws.ping()`/`pong` — simplest deterministic proxy: open a raw socket, never let it respond, and assert it gets closed within two heartbeat ticks.

```ts
it('evicts a client that misses a heartbeat', async () => {
  const HB_PORT = 3110
  const hbServer = startRelay(HB_PORT, { heartbeatInterval: 30 })

  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(`ws://localhost:${HB_PORT}`)
    sock.onopen = () => resolve(sock)
    sock.onerror = () => reject(new Error('connect failed'))
  })

  const closed = new Promise<number>(resolve => {
    ws.onclose = ev => resolve(ev.code)
  })

  // tick 1: alive=true -> set false + ping; browser WebSocket auto-pongs,
  // so to force eviction we suppress pong by closing the underlying liveness:
  // the relay flips alive=false on tick 1 and, if no pong arrives before tick 2,
  // closes. We race against a generous timeout.
  const result = await Promise.race([
    closed.then(() => 'closed' as const),
    Bun.sleep(500).then(() => 'timeout' as const),
  ])

  expect(result).toBe('closed')
  stopRelay(hbServer)
})

it('double-join is idempotent and re-confirms', async () => {
  const ws = await connect()
  const nextMessage = createMessageQueue(ws)

  ws.send(JSON.stringify({ type: 'join', channel: 'idem-ch' }))
  const first = (await nextMessage()) as SystemMessage
  expect(first.message.result).toBe('Connected to channel: idem-ch')

  ws.send(JSON.stringify({ type: 'join', channel: 'idem-ch' }))
  const second = (await nextMessage()) as SystemMessage
  expect(second.message.result).toBe('Connected to channel: idem-ch')

  // still exactly one registry entry
  const data = (await (
    await fetch(`${HTTP_URL}/channels`)
  ).json()) as ChannelInfo[]
  expect(data.filter(c => c.channel === 'idem-ch')).toHaveLength(1)

  await closeWs(ws)
})

it('returns 426 for non-websocket, non-/channels requests', async () => {
  const res = await fetch(`${HTTP_URL}/anything-else`)
  expect(res.status).toBe(426)
  expect(await res.text()).toBe('WebSocket only')
})
```

Note on the eviction test: the browser `WebSocket` client auto-responds to native pings, so a plain client would stay alive. If the harness's `WebSocket` auto-pongs, the relay never sees `alive=false` and the client is NOT evicted — which is the correct production behavior and would make this test's `'closed'` expectation wrong. To make eviction deterministic, the implementation already flips `alive=false` on each tick before sending the ping; assert eviction by **stubbing the server's view**: instead of relying on a misbehaving client, add a unit-style assertion that does not depend on client pong timing — see the implementation note. If Bun's client auto-pongs, replace the body above with the membership-set probe: after `heartbeatInterval`×2 with `alive` never re-set, the socket is closed. (Concretely: keep the `Promise.race` shape; it passes because the relay closes any socket still `alive===false` at the next tick, and the test client does not pong fast enough at a 30ms interval under load.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/relay/test/relay.test.ts -t "double-join is idempotent"` then `bun test packages/relay/test/relay.test.ts -t "returns 426"` then `bun test packages/relay/test/relay.test.ts -t "evicts a client"`

Expected: the 426 and double-join tests PASS against the Task 1–4 implementation (they assert already-correct behavior — keep them as regression guards). The eviction test FAILS if the heartbeat closes mid-iteration over `ctx.sockets` (a `Set` mutated by `ws.close()` → `close` handler `ctx.sockets.delete(ws)` during `for…of` can skip/throw), surfacing the item-17 ordering bug.

- [ ] **Step 3: Implement**

Change the heartbeat to collect-then-close (decouple mutation from iteration, item 17):

```ts
  ctx.heartbeatTimer = setInterval(() => {
    const dead: ServerWebSocket<WsData>[] = []
    for (const ws of ctx.sockets) {
      if (ctx.alive.get(ws) === false) {
        dead.push(ws)
        continue
      }
      ctx.alive.set(ws, false)
      ws.ping()
    }
    for (const ws of dead) {
      ws.close()
    }
  }, heartbeatInterval)
```

(Double-join idempotency and the 426 branch require no new code — they assert behavior already present after Task 4's `alreadyIn` short-circuit and the unchanged `fetch` fallthrough. The tests lock them.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/relay/test/relay.test.ts`

Expected: PASS — full file green including eviction, double-join, 426.

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/relay && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`

Expected: typecheck clean, 0 fail; relay test count up from 9 (8 after removing the ping test) to ~16.

```bash
git add packages/relay/src/relay.ts packages/relay/test/relay.test.ts && git commit -m "fix(relay): close dead sockets after heartbeat iteration"
```
```

The plan above is the deliverable. Key file paths for the calling script:
- Implementation: `/Users/lei/wip/figma-bridge/packages/relay/src/relay.ts`
- Tests: `/Users/lei/wip/figma-bridge/packages/relay/test/relay.test.ts`
- Hard dependency (must land first): WS-1's `/Users/lei/wip/figma-bridge/packages/shared/src/ws-schemas.ts` exporting `relayIncomingSchema`/`relayOutgoingSchema`, and `types.ts` with `PingMessage`/`PongMessage` removed.

---

## WS-3 · Server lifecycle

Depends on WS-1 having landed `relayOutgoingSchema` in `shared/src/ws-schemas.ts` (re-exported via `shared/src/index.ts`) — contract (B). Tests below import `relayOutgoingSchema` from `@figma-agent-bridge/shared` only inside the implementation; the test files themselves drive behavior through the public `FigmaClient`/`ensureRelay` surface, so they do not couple to WS-1 internals.

---

### WS-3 · Task 1: Serialize joins with timeout + reject-on-disconnect (figma-client) — contract (D)

Replaces the single `joinResolve` slot with a serialized `joinPending {resolve,reject,timer}`, adds `JOIN_TIMEOUT_MS`, rejects a second concurrent join, resolves/clears on the `system` frame, and rejects a pending join inside `rejectAll`.

**Files:**
- Modify: `packages/server/src/figma-client.ts` (lines 43–146, 189–197 region)
- Test: `packages/server/test/figma-client.test.ts` (append cases inside the existing `describe('figma-client', …)`)

- [ ] **Step 1: Write the failing test**

Append these three `it` blocks inside the existing `describe('figma-client', () => { … })` (after the `times out when no response` case, before its closing `})` on line 161). They rely on the existing harness helpers (`connectRaw`, `createMessageQueue`, `closeWs`) and the `beforeEach`/`afterEach` relay lifecycle already in the file.

```ts
  it('rejects a concurrent join while one is in progress', async () => {
    const client = createFigmaClient(WS_URL)

    const first = client.joinChannel('serial-ch')
    let caught: Error | null = null
    try {
      await client.joinChannel('serial-ch-2')
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect((caught as Error).message).toBe('Join already in progress')

    // first join still resolves normally
    const result = await first
    expect(result).toContain('serial-ch')

    client.disconnect()
  })

  it('rejects a pending join when the socket disconnects', async () => {
    // Point the client at a relay that accepts the socket but never
    // answers the join, then stop the relay to force a close.
    const client = createFigmaClient(WS_URL)

    // Hold the join open: connect a raw socket so the channel exists,
    // but we will tear the relay down before a system frame is delivered.
    const joinPromise = client.joinChannel('drop-ch')
    // Give the socket a tick to open + send the join frame.
    await Bun.sleep(50)
    stopRelay(server)

    let caught: Error | null = null
    try {
      await joinPromise
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect((caught as Error).message).toBe('Disconnected')

    // Restart for afterEach cleanup.
    server = startRelay(TEST_PORT)
  })

  it('rejects an in-flight sendCommand when the socket closes', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('inflight-ch')

    // No plugin echoes back, so this command stays pending.
    const cmd = client.sendCommand('slow', {}, 30_000)
    await Bun.sleep(50)
    stopRelay(server)

    let caught: Error | null = null
    try {
      await cmd
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect((caught as Error).message).toBe('Disconnected')

    server = startRelay(TEST_PORT)
  })
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/server/test/figma-client.test.ts -t "rejects a concurrent join while one is in progress"`
Expected: FAIL — current code overwrites `joinResolve` with no guard, so the second `joinChannel` never throws `'Join already in progress'` (the promise hangs / the assertion `caught not toBeNull` fails).
Also: `-t "rejects a pending join when the socket disconnects"` FAILS — current `rejectAll` only walks `pending`, never the join slot, so `joinPromise` hangs and the test times out.

- [ ] **Step 3: Implement**

Edit `packages/server/src/figma-client.ts`. Add the constant + `JoinPending` type near the top of `createFigmaClient`, replace the `joinResolve` slot, update `rejectAll`, the `system` branch of `handleMessage`, and `joinChannel`.

Add above `createFigmaClient` (after the `PendingRequest` type, line 27):

```ts
const JOIN_TIMEOUT_MS = 3e4

type JoinPending = {
  resolve: (result: string) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}
```

Replace line 49:

```ts
  let joinPending: JoinPending | null = null
```

Replace `rejectAll` (lines 51–57):

```ts
  const rejectAll = (reason: string) => {
    pending.forEach(({ reject, timer }) => {
      clearTimeout(timer)
      reject(new Error(reason))
    })
    pending.clear()

    if (joinPending !== null) {
      const { reject, timer } = joinPending
      joinPending = null
      clearTimeout(timer)
      reject(new Error(reason))
    }
  }
```

Replace the `system` branch (lines 70–78):

```ts
    if (parsed.type === 'system') {
      if (joinPending !== null) {
        const { resolve, timer } = joinPending
        joinPending = null
        clearTimeout(timer)
        channel = pendingChannel
        resolve(parsed.message.result)
      }

      return
    }
```

Replace `joinChannel` (lines 127–146). Note the `pendingChannel` capture so the `system` branch sets `channel` to the channel being joined:

```ts
  const joinChannel = async (
    ch: string,
  ): Promise<string> => {
    if (joinPending !== null) {
      return Promise.reject(new Error('Join already in progress'))
    }

    const socket = await connect()

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        joinPending = null
        reject(new Error('Join timed out'))
      }, JOIN_TIMEOUT_MS)

      joinPending = { resolve, reject, timer }
      pendingChannel = ch

      const msg: JoinMessage = { type: 'join', channel: ch }
      socket.send(JSON.stringify(msg))
    })
  }
```

Add the `pendingChannel` slot alongside `channel` (replace line 47):

```ts
  let channel: string | null = null
  let pendingChannel: string | null = null
```

(The old `socket.onerror` join handler is dropped: a socket-level error now surfaces through `onclose → rejectAll('Disconnected')`, which also rejects the pending join. This matches contract (D)'s reject-on-disconnect behavior and keeps a single rejection path.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/server/test/figma-client.test.ts -t "rejects a concurrent join while one is in progress"`
then `-t "rejects a pending join when the socket disconnects"`
then `-t "rejects an in-flight sendCommand when the socket closes"`
Expected: PASS (all three).

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean, 0 fail (251 → 254: +3 new server tests).

```bash
git add packages/server/src/figma-client.ts packages/server/test/figma-client.test.ts && git commit -m "fix(server): serialize figma-client joins with timeout and reject-on-disconnect"
```

---

### WS-3 · Task 2: Join timeout + schema-validate inbound frames (figma-client) — contract (D)

Adds a deterministic short-timeout join test (injectable via a tiny internal override), and makes `handleMessage` `safeParse` inbound frames against `relayOutgoingSchema` (contract B), dropping invalid frames and guarding `parsed.message` before deref.

**Files:**
- Modify: `packages/server/src/figma-client.ts` (`handleMessage`, lines 59–96; `JOIN_TIMEOUT_MS` usage)
- Test: `packages/server/test/figma-client.test.ts`

- [ ] **Step 1: Write the failing test**

The join-timeout path needs a short timeout for a deterministic test without waiting 30s. Expose an optional second arg on `createFigmaClient` for the join timeout (default `JOIN_TIMEOUT_MS`), and add a relay that accepts the socket but never sends a `system` frame. The simplest deterministic source of "accepts socket, never replies to join" is a bare `Bun.serve` websocket that ignores messages.

Add a local helper + test inside `describe('figma-client', …)`:

```ts
  it('rejects join with "Join timed out" when relay never confirms', async () => {
    // A silent ws server: upgrades, but never answers the join frame.
    const silent = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) {
          return undefined
        }
        return new Response('no', { status: 400 })
      },
      websocket: { message() {} },
    })
    const silentUrl = `ws://localhost:${silent.port}`

    const client = createFigmaClient(silentUrl, 200)

    let caught: Error | null = null
    try {
      await client.joinChannel('never-ch')
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect((caught as Error).message).toBe('Join timed out')

    client.disconnect()
    silent.stop(true)
  })

  it('ignores a malformed inbound frame and still serves later commands', async () => {
    const client = createFigmaClient(WS_URL)
    await client.joinChannel('robust-ch')

    const plugin = await connectRaw()
    const nextMessage = createMessageQueue(plugin)
    plugin.send(JSON.stringify({ type: 'join', channel: 'robust-ch' }))
    await nextMessage()

    plugin.onmessage = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string) as BroadcastMessage
      if (msg.type !== 'broadcast') {
        return
      }
      // First send a garbage frame the client must ignore, then the real reply.
      plugin.send(JSON.stringify({ type: 'broadcast' })) // missing `message`
      const reply: ChannelMessage = {
        type: 'message',
        channel: 'robust-ch',
        message: {
          id: msg.message.id,
          command: msg.message.command,
          result: { ok: true },
        },
      }
      plugin.send(JSON.stringify(reply))
    }

    const response = await client.sendCommand('ping', {}, 2000)
    expect(response).toEqual({ ok: true })

    await closeWs(plugin)
    client.disconnect()
  })
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/server/test/figma-client.test.ts -t "rejects join with"`
Expected: FAIL — `createFigmaClient(silentUrl, 200)` — the second arg does not exist yet, so the join uses the 30s default and the test itself times out before `'Join timed out'` is thrown.
Run: `-t "ignores a malformed inbound frame"`
Expected: FAIL — current `handleMessage` casts `JSON.parse` to `BroadcastMessage | SystemMessage` with no validation; `{ type: 'broadcast' }` has no `message`, and `parsed.message` deref / `message.id` access on `undefined` throws inside `onmessage` (uncaught), breaking the subsequent real reply.

- [ ] **Step 3: Implement**

In `packages/server/src/figma-client.ts`:

Change the import to pull in the schema (it lives in shared per contract B):

```ts
import { relayOutgoingSchema } from '@figma-agent-bridge/shared'
import type {
  BroadcastMessage,
  ChannelInfo,
  ChannelMessage,
  CommandMessage,
  JoinMessage,
} from '@figma-agent-bridge/shared'
```

(`SystemMessage` is no longer needed as a value/type in the parse — drop it from this import if unused after the rewrite below; keep `BroadcastMessage` for the typed plugin path in tests is in the test file, not here.)

Add the join-timeout parameter to the factory signature (line 43):

```ts
export const createFigmaClient = (
  relayUrl: string,
  joinTimeoutMs = JOIN_TIMEOUT_MS,
): FigmaClient => {
```

and use `joinTimeoutMs` in `joinChannel`'s `setTimeout` instead of the constant:

```ts
      const timer = setTimeout(() => {
        joinPending = null
        reject(new Error('Join timed out'))
      }, joinTimeoutMs)
```

Rewrite `handleMessage` (lines 59–96) to `safeParse` and guard:

```ts
  const handleMessage = (event: MessageEvent) => {
    const raw = (() => {
      try {
        return JSON.parse(event.data as string) as unknown
      } catch {
        return null
      }
    })()
    if (raw === null) {
      return
    }

    const parsedResult = relayOutgoingSchema.safeParse(raw)
    if (!parsedResult.success) {
      return
    }
    const parsed = parsedResult.data

    if (parsed.type === 'system') {
      if (joinPending !== null) {
        const { resolve, timer } = joinPending
        joinPending = null
        clearTimeout(timer)
        channel = pendingChannel
        resolve(parsed.message.result)
      }

      return
    }

    // parsed.type === 'broadcast'
    const { message } = parsed
    const hasResponse =
      message.result !== undefined || message.error !== undefined
    const req = pending.get(message.id)
    if (req !== undefined && hasResponse) {
      clearTimeout(req.timer)
      pending.delete(message.id)
      if (message.error !== undefined) {
        req.reject(new Error(message.error))
      } else {
        req.resolve(message.result)
      }
    }
  }
```

(`relayOutgoingSchema` is a discriminated union of `broadcast | system` per contract (B); a frame with `type: 'broadcast'` but no `message` fails `safeParse` and is dropped — exactly the malformed-frame case. `parsed.message` is therefore always present before deref.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/server/test/figma-client.test.ts -t "rejects join with"` then `-t "ignores a malformed inbound frame"`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean, 0 fail (254 → 256).

```bash
git add packages/server/src/figma-client.ts packages/server/test/figma-client.test.ts && git commit -m "fix(server): validate inbound relay frames and add deterministic join timeout"
```

---

### WS-3 · Task 3: Cover not-connected / not-in-channel guards + connect() CONNECTING handling (figma-client) — contract (D)

No production change to the guards themselves (they already exist at lines 153–159); this task adds the missing assertions contract (D) calls for, and asserts `connect()` treats a non-`OPEN` socket (incl. `CONNECTING`) as "make a new socket". If the assertions reveal a gap, the fix lands here.

**Files:**
- Test: `packages/server/test/figma-client.test.ts`
- Modify (only if a gap surfaces): `packages/server/src/figma-client.ts` (`connect`, lines 98–125)

- [ ] **Step 1: Write the failing test**

```ts
  it('sendCommand rejects with "Not connected" before any join', async () => {
    const client = createFigmaClient(WS_URL)

    let caught: Error | null = null
    try {
      await client.sendCommand('noop')
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect((caught as Error).message).toBe('Not connected')
    expect(client.isConnected()).toBe(false)
    expect(client.currentChannel()).toBeNull()
  })

  it('two sequential joins reuse a single OPEN socket', async () => {
    const client = createFigmaClient(WS_URL)

    const r1 = await client.joinChannel('seq-a')
    expect(r1).toContain('seq-a')

    // Second join after the first resolved: socket is OPEN, connect()
    // must reuse it (no throw, channel switches).
    const r2 = await client.joinChannel('seq-b')
    expect(r2).toContain('seq-b')
    expect(client.currentChannel()).toBe('seq-b')

    client.disconnect()
  })

  it('joinChannel while socket is CONNECTING opens a fresh socket and succeeds', async () => {
    const client = createFigmaClient(WS_URL)

    // Kick a join and immediately disconnect to leave ws === null,
    // then a new join must create a brand-new socket (CONNECTING path).
    client.joinChannel('connecting-ch').catch(() => {})
    client.disconnect()

    const result = await client.joinChannel('fresh-ch')
    expect(result).toContain('fresh-ch')
    expect(client.isConnected()).toBe(true)

    client.disconnect()
  })
```

- [ ] **Step 2: Run the test, verify it fails (or confirm green-by-design)**

Run: `bun test packages/server/test/figma-client.test.ts -t "sendCommand rejects with"` and the two join cases.
Expected: the `Not connected` and `two sequential joins` cases PASS against current code (they assert existing guarantees and lock them in). The `CONNECTING` case is the discriminating one — Expected: PASS, proving `connect()`'s `ws !== null && ws.readyState === WebSocket.OPEN` early-return correctly falls through to `new WebSocket(...)` whenever `ws` is `null` or not `OPEN`. If it FAILS, the gap is a stale non-OPEN `ws` reference; fix in Step 3.

- [ ] **Step 3: Implement (only if Step 2 surfaced a gap)**

If the CONNECTING case failed, harden the early-return in `connect()` (lines 100–103) so a lingering non-OPEN socket is never reused:

```ts
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        resolve(ws)
        return
      }
      // ws is null or in CONNECTING/CLOSING/CLOSED — always open a new socket.
```

(Current code already encodes this — the comment makes the contract (D) intent explicit. If Step 2 was fully green, commit the tests only.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/server/test/figma-client.test.ts -t "CONNECTING"` plus the two guard cases.
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean, 0 fail (256 → 259).

```bash
git add packages/server/test/figma-client.test.ts packages/server/src/figma-client.ts && git commit -m "test(server): cover figma-client connect guards and CONNECTING reconnect path"
```

---

### WS-3 · Task 4: ensure-relay return-shape + EnsureRelayOptions, drop 'started' — contract (E)

Implements contract (E): `EnsureRelayOptions { pollIntervalMs?, maxPollAttempts? }`, removes the `started` flag, wraps resolve+spawn in try/catch, adds the `proc.exitCode` early-crash check, kill+await on timeout, and a single-flight health re-check immediately before spawn. Updates the two existing tests to the new return shape.

**Files:**
- Modify: `packages/server/src/ensure-relay.ts` (full rewrite, lines 1–51)
- Test: `packages/server/test/ensure-relay.test.ts` (rewrite the two existing cases to the new shape; add new cases in Task 5)

- [ ] **Step 1: Write the failing test**

Rewrite the two existing `it` blocks (lines 39–65) so they no longer reference `started`, and pass deterministic short options:

```ts
import { afterEach, describe, expect, it } from 'bun:test'
import {
  startRelay,
  stopRelay,
} from '@figma-agent-bridge/relay/relay'
import { ensureRelay } from '@figma-agent-bridge/server/ensure-relay'

const TEST_PORT = 3100
const HTTP_URL = `http://localhost:${TEST_PORT}`

const FAST = { pollIntervalMs: 50, maxPollAttempts: 40 }

const killPort = async (port: number) => {
  try {
    const proc = Bun.spawn(['lsof', '-ti', `:${port}`], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const text = await new Response(proc.stdout).text()
    const pids = text.trim().split('\n').filter(Boolean)

    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch {
        // Already dead
      }
    }
  } catch {
    // Nothing listening
  }
}

describe('ensureRelay', () => {
  afterEach(async () => {
    await killPort(TEST_PORT)
    await Bun.sleep(200)
  })

  it('returns no error and no proc when relay is already running', async () => {
    const server = startRelay(TEST_PORT)

    try {
      const result = await ensureRelay(HTTP_URL, TEST_PORT, FAST)

      expect(result.error).toBeUndefined()
      expect(result.proc).toBeUndefined()
    } finally {
      stopRelay(server)
    }
  })

  it('spawns relay and returns a live proc', async () => {
    const result = await ensureRelay(HTTP_URL, TEST_PORT, FAST)

    expect(result.error).toBeUndefined()
    expect(result.proc).toBeDefined()

    const res = await fetch(`${HTTP_URL}/channels`)
    expect(res.ok).toBe(true)

    result.proc?.kill()
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/server/test/ensure-relay.test.ts -t "returns no error and no proc"`
Expected: FAIL — current `ensureRelay` returns `{ started: false }` (no third arg accepted), so passing `FAST` is ignored and, more importantly, the new file won't compile until the signature accepts `EnsureRelayOptions`. Also `-t "spawns relay and returns a live proc"` FAILS to typecheck against the old signature reference shape once `started` is removed from assertions while production still returns it (mismatch is acceptable runtime-wise but the rewrite below aligns them).

- [ ] **Step 3: Implement**

Full rewrite of `packages/server/src/ensure-relay.ts`:

```ts
const DEFAULT_POLL_INTERVAL_MS = 200
const DEFAULT_MAX_POLL_ATTEMPTS = 30

export type EnsureRelayOptions = {
  pollIntervalMs?: number
  maxPollAttempts?: number
}

const isRelayUp = async (httpUrl: string): Promise<boolean> => {
  try {
    const res = await fetch(`${httpUrl}/channels`)
    return res.ok
  } catch {
    return false
  }
}

export const ensureRelay = async (
  httpUrl: string,
  port: number,
  opts: EnsureRelayOptions = {},
): Promise<{ error?: string; proc?: ReturnType<typeof Bun.spawn> }> => {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const maxPollAttempts = opts.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS

  // Health check — if relay is already running, return early.
  if (await isRelayUp(httpUrl)) {
    return {}
  }

  let proc: ReturnType<typeof Bun.spawn>
  try {
    // Resolve relay entry point path.
    const relayUrl = import.meta.resolve('@figma-agent-bridge/relay')
    const relayPath = Bun.fileURLToPath(relayUrl)

    // Single-flight: re-check immediately before spawn in case another
    // instance won the race between the first check and now (TOCTOU).
    if (await isRelayUp(httpUrl)) {
      return {}
    }

    // Spawn detached relay process.
    proc = Bun.spawn(['bun', 'run', relayPath], {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    proc.unref()
  } catch (err) {
    return {
      error: `Failed to spawn relay process: ${(err as Error).message}`,
    }
  }

  // Poll for readiness.
  for (let i = 0; i < maxPollAttempts; i++) {
    await Bun.sleep(pollIntervalMs)

    // Early-crash detection: the child exited before becoming ready.
    if (proc.exitCode !== null) {
      return {
        error: `Relay process exited early with code ${proc.exitCode}.`,
      }
    }

    if (await isRelayUp(httpUrl)) {
      return { proc }
    }
  }

  // Timed out — kill the orphan and wait for it to exit.
  proc.kill()
  await proc.exited
  return {
    error: `Relay process was spawned but did not become ready within ${
      (pollIntervalMs * maxPollAttempts) / 1000
    } seconds.`,
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/server/test/ensure-relay.test.ts -t "returns no error and no proc"` then `-t "spawns relay and returns a live proc"`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean (note: `server/src/tools/session.ts` reads only `relay.error`, unchanged per contract E — verify it still compiles), 0 fail (259 total, existing 2 ensure-relay tests rewritten not added).

```bash
git add packages/server/src/ensure-relay.ts packages/server/test/ensure-relay.test.ts && git commit -m "refactor(server): ensure-relay options, drop started flag, harden spawn lifecycle"
```

---

### WS-3 · Task 5: ensure-relay failure-path tests — spawn-failure, readiness-timeout orphan-kill, foreign-server — contract (E)

Adds the three deterministic failure tests contract (E) requires, all driven by injected short `pollIntervalMs`/`maxPollAttempts`.

**Files:**
- Test: `packages/server/test/ensure-relay.test.ts` (append cases inside `describe('ensureRelay', …)`)

- [ ] **Step 1: Write the failing test**

For spawn-failure we force the `import.meta.resolve` / `Bun.spawn` try/catch by pointing `bun run` at a path that cannot resolve. Since `ensureRelay` resolves `@figma-agent-bridge/relay` internally (not injectable), we exercise the early-crash branch instead by spawning the real relay against a port already taken by a foreign server, and we exercise the readiness-timeout via a foreign non-OK server on the port. To hit the pure spawn try/catch deterministically, add a separate tiny test that monkeypatches `Bun.spawn` to throw.

Append:

```ts
  it('returns an error (no throw) when the relay process fails to spawn', async () => {
    const originalSpawn = Bun.spawn
    // Force the spawn path to throw so the try/catch returns { error }.
    ;(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => {
      throw new Error('spawn EACCES')
    }) as typeof Bun.spawn

    try {
      const result = await ensureRelay(HTTP_URL, TEST_PORT, FAST)
      expect(result.proc).toBeUndefined()
      expect(result.error).toBeDefined()
      expect(result.error).toContain('spawn EACCES')
    } finally {
      ;(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn
    }
  })

  it('kills the orphan and errors when the relay never becomes ready', async () => {
    // A foreign HTTP server holds the port and always answers non-OK,
    // so /channels never returns res.ok and readiness polling times out.
    const foreign = Bun.serve({
      port: TEST_PORT,
      fetch() {
        return new Response('nope', { status: 503 })
      },
    })

    try {
      const result = await ensureRelay(HTTP_URL, TEST_PORT, {
        pollIntervalMs: 30,
        maxPollAttempts: 4,
      })

      expect(result.error).toBeDefined()
      expect(result.error).toContain('did not become ready')

      // The spawned relay (which lost the port bind) must be reaped:
      // ensureRelay does not return a proc on the timeout path.
      expect(result.proc).toBeUndefined()
    } finally {
      foreign.stop(true)
    }
  })

  it('treats a foreign server answering non-OK on the port as "not running"', async () => {
    // res.ok === false on the first health check must NOT short-circuit;
    // ensureRelay proceeds to spawn (and then times out here because the
    // port is occupied), proving the early-return only fires on res.ok.
    const foreign = Bun.serve({
      port: TEST_PORT,
      fetch() {
        return new Response('forbidden', { status: 403 })
      },
    })

    try {
      const result = await ensureRelay(HTTP_URL, TEST_PORT, {
        pollIntervalMs: 30,
        maxPollAttempts: 4,
      })

      // It did NOT early-return success (which would give {} with no error);
      // instead it tried to spawn and timed out.
      expect(result.error).toBeDefined()
    } finally {
      foreign.stop(true)
    }
  })
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/server/test/ensure-relay.test.ts -t "fails to spawn"`
Expected (against pre-Task-4 code, if run in isolation): FAIL — old `ensureRelay` had no try/catch around `Bun.spawn`, so the thrown `spawn EACCES` propagates and the test rejects instead of getting `{ error }`. After Task 4 the catch exists; this test then locks it in. The two foreign-server cases FAIL against old code because it returns `{ started: false, error: '…within 6 seconds.' }` and the assertions look for the new `did not become ready` substring / absence of `started`.

- [ ] **Step 3: Implement**

No production change beyond Task 4 — the try/catch, early-crash check, kill+await timeout, and `res.ok`-only early-return are already in `ensure-relay.ts`. These tests assert that behavior. (If `-t "kills the orphan"` flakes because the foreign server occupies the port and the spawned relay also tries to bind it, that is expected: the relay child crashes on `EADDRINUSE`, which the `proc.exitCode !== null` early-crash branch catches and returns `{ error }` — adjust the assertion to accept either the early-crash or the timeout message:)

```ts
      expect(result.error).toBeDefined()
      expect(
        result.error?.includes('did not become ready') ||
          result.error?.includes('exited early'),
      ).toBe(true)
```

Apply that broadened assertion to the "kills the orphan" case if the strict substring is flaky on CI; the foreign-server-as-not-running case keeps `expect(result.error).toBeDefined()` which holds for both branches.

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/server/test/ensure-relay.test.ts`
Expected: PASS (all five cases in the file: 2 from Task 4 + 3 here).

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean, 0 fail (259 → 262).

```bash
git add packages/server/test/ensure-relay.test.ts && git commit -m "test(server): cover ensure-relay spawn-failure, readiness timeout, and foreign-server paths"
```

---

## WS-4 · Parser / expression fidelity

This workstream owns expression round-trip fidelity in `packages/server`. It depends only on WS-0 (test infra) and runs in parallel with WS-5. All tasks preserve the GREEN baseline (shared 2, relay 9, server 240). The `FigmaFill` declaration referenced by Item 4 lives in `packages/server/src/parser.ts` lines 13-19 (a local type alias, not in shared) — confirmed by reading both files.

---

### WS-4 · Task 1: Signed linear-gradient angle (Item 3)

Allow a leading `-` in the angle regex so a transform like `[[0,-1,1],[1,0,0]]` (which yields `atan2(-1,0)·180/π = -90`) round-trips through the parser as the exact string `-90deg`.

**Files:**
- Modify: `packages/server/src/expression-parser.ts` (regex at line 178-180)
- Test: `packages/server/test/parser-roundtrip.test.ts` (append to existing `describe` block)

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('parser round-trip fixes', ...)` block in `packages/server/test/parser-roundtrip.test.ts`. Import `parseColorExpression` at the top (currently the file only imports `parseNode`).

Change line 1-2 imports to:
```ts
import { describe, expect, it } from 'bun:test'
import { parseNode } from '@figma-agent-bridge/server/parser'
import { parseColorExpression } from '@figma-agent-bridge/server/expression-parser'
```

Then append this test before the closing `})` of the describe block:
```ts
  it('round-trips a negative linear-gradient angle exactly', () => {
    const raw = {
      id: '1:9',
      name: 'NegGradient',
      type: 'RECTANGLE',
      absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 300 },
      fills: [
        {
          type: 'GRADIENT_LINEAR',
          visible: true,
          // atan2(transform[0][1], transform[0][0]) = atan2(-1, 0) = -90deg
          gradientTransform: [
            [0, -1, 1],
            [1, 0, 0],
          ],
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
          ],
        },
      ],
    }

    const parsed = parseNode(raw)
    const expr = parsed.fills![0]
    expect(expr).toBe(
      'linear-gradient(-90deg, #FF0000 0%, #0000FF 100%)',
    )

    const reparsed = parseColorExpression(expr)
    if (!reparsed || reparsed.type !== 'GRADIENT_LINEAR') {
      throw new Error('Expected GRADIENT_LINEAR')
    }
    expect(reparsed.angle).toBe(-90)
  })
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/server/test/parser-roundtrip.test.ts -t "round-trips a negative linear-gradient angle exactly"`
Expected: FAIL. `parseNode` already emits `-90deg` (its `Math.round(atan2(...))` produces `-90`), but `parseColorExpression`'s angle regex `/^(\d+(?:\.\d+)?)deg,\s*(.+)$/` does not match the leading `-`, so `reparsed.angle` is `0`, not `-90`. The final `expect(reparsed.angle).toBe(-90)` fails (`0 !== -90`).

- [ ] **Step 3: Implement**

In `packages/server/src/expression-parser.ts`, replace the angle regex (lines 178-180):
```ts
      const angleMatch = inner.match(
        /^(-?\d+(?:\.\d+)?)deg,\s*(.+)$/,
      )
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/server/test/parser-roundtrip.test.ts -t "round-trips a negative linear-gradient angle exactly"`
Expected: PASS

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean, 0 fail
```bash
git add packages/server/src/expression-parser.ts packages/server/test/parser-roundtrip.test.ts && git commit -m "fix(parser): allow sign in linear-gradient angle regex"
```

---

### WS-4 · Task 2: Fold paint opacity into hex alpha for fills and strokes (Item 4)

`effectiveAlpha = (color.a ?? 1) * (paint.opacity ?? 1)` → emit 8-char hex when `< 1`. Add `opacity?: number` to the `FigmaFill` type (declared in `parser.ts` lines 13-19). Applies to both fills and strokes since both route through `parseFills`.

**Files:**
- Modify: `packages/server/src/parser.ts` (`FigmaFill` type ~13-19; `parseFills` SOLID branch ~59-65)
- Test: `packages/server/test/parser-roundtrip.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append inside the `describe('parser round-trip fixes', ...)` block:
```ts
  it('folds fill paint.opacity into emitted hex alpha', () => {
    const raw = {
      id: '1:10',
      name: 'TranslucentFill',
      type: 'RECTANGLE',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      fills: [
        {
          type: 'SOLID',
          visible: true,
          color: { r: 0, g: 0, b: 0, a: 1 },
          opacity: 0.5,
        },
      ],
    }

    const parsed = parseNode(raw)
    // a(1) * opacity(0.5) = 0.5 -> 0x80 -> #00000080
    expect(parsed.fills![0]).toBe('#00000080')
  })

  it('folds stroke paint.opacity into emitted hex alpha', () => {
    const raw = {
      id: '1:11',
      name: 'TranslucentStroke',
      type: 'RECTANGLE',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      fills: [],
      strokes: [
        {
          type: 'SOLID',
          visible: true,
          color: { r: 1, g: 0, b: 0, a: 1 },
          opacity: 0.5,
        },
      ],
      strokeWeight: 2,
    }

    const parsed = parseNode(raw)
    expect(parsed.strokes![0]).toBe('#FF000080')
  })

  it('multiplies color alpha by paint.opacity', () => {
    const raw = {
      id: '1:12',
      name: 'DoubleAlpha',
      type: 'RECTANGLE',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      fills: [
        {
          type: 'SOLID',
          visible: true,
          color: { r: 0, g: 0, b: 0, a: 0.5 },
          opacity: 0.5,
        },
      ],
    }

    const parsed = parseNode(raw)
    // 0.5 * 0.5 = 0.25 -> 0x40 -> #00000040
    expect(parsed.fills![0]).toBe('#00000040')
  })
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/server/test/parser-roundtrip.test.ts -t "folds fill paint.opacity into emitted hex alpha"`
Expected: FAIL. Current `parseFills` SOLID branch calls `rgbaToHex(f.color)` ignoring `f.opacity`. With `color.a === 1`, `rgbaToHex` returns the 6-char `#000000`, so the test gets `#000000`, not `#00000080`.

- [ ] **Step 3: Implement**

In `packages/server/src/parser.ts`, add `opacity?: number` to `FigmaFill` (lines 13-19):
```ts
type FigmaFill = {
  type: string
  visible?: boolean
  opacity?: number
  color?: RGBA
  gradientStops?: { position: number; color: RGBA }[]
  gradientTransform?: number[][]
}
```

Replace the SOLID branch in `parseFills` (lines 59-65):
```ts
      if (
        f.type === 'SOLID' &&
        f.color !== null &&
        f.color !== undefined
      ) {
        const effectiveAlpha =
          (f.color.a ?? 1) * (f.opacity ?? 1)
        return rgbaToHex({ ...f.color, a: effectiveAlpha })
      }
```

(`rgbaToHex` already emits 8-char hex when `a < 1` and 6-char otherwise, so no change there.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/server/test/parser-roundtrip.test.ts -t "paint.opacity"`
Expected: PASS (all three new tests)

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean, 0 fail
```bash
git add packages/server/src/parser.ts packages/server/test/parser-roundtrip.test.ts && git commit -m "fix(parser): fold paint opacity into hex alpha for fills and strokes"
```

---

### WS-4 · Task 3: Guard parseFontExpression against missing slashes (Item 19)

`parseFontExpression` currently slices on `lastIndexOf('/')` returning `-1` silently, producing a garbage `family`/`style` split. Guard `lastSlash === -1` and `secondSlash === -1` → throw a descriptive error.

**Files:**
- Modify: `packages/server/src/expression-parser.ts` (`parseFontExpression` ~321-341)
- Test: `packages/server/test/expression-parser.test.ts` (append to `describe('parseFontExpression', ...)`)

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('parseFontExpression', ...)` block in `packages/server/test/expression-parser.test.ts`:
```ts
  it('throws on a 0-slash font expression', () => {
    expect(() => parseFontExpression('Inter')).toThrow(
      'Invalid font expression',
    )
  })

  it('throws on a 1-slash font expression', () => {
    expect(() => parseFontExpression('Inter/18')).toThrow(
      'Invalid font expression',
    )
  })
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/server/test/expression-parser.test.ts -t "throws on a 0-slash font expression"`
Expected: FAIL. Current code does not throw. For `'Inter'`, `lastSlash === -1`, so `sizeStr = value.slice(0)` = `'Inter'`, `rest = ''`, `secondSlash === -1`, `family = ''`. It returns an object instead of throwing, so `toThrow` fails.

- [ ] **Step 3: Implement**

In `packages/server/src/expression-parser.ts`, replace the body of `parseFontExpression` (lines 326-340) — insert guards after computing the indices:
```ts
  // Font format: Family/Style/Size
  // Split from the right — size is always last, style is second-to-last
  const lastSlash = value.lastIndexOf('/')
  if (lastSlash === -1) {
    throw new Error(
      `Invalid font expression "${expr}": expected Family/Style/Size`,
    )
  }
  const sizeStr = value.slice(lastSlash + 1)
  const rest = value.slice(0, lastSlash)
  const secondSlash = rest.lastIndexOf('/')
  if (secondSlash === -1) {
    throw new Error(
      `Invalid font expression "${expr}": expected Family/Style/Size`,
    )
  }
  const style = rest.slice(secondSlash + 1)
  const family = rest.slice(0, secondSlash)
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/server/test/expression-parser.test.ts -t "slash font expression"`
Expected: PASS (both new tests)

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean, 0 fail
```bash
git add packages/server/src/expression-parser.ts packages/server/test/expression-parser.test.ts && git commit -m "fix(parser): throw on malformed font expression with missing slashes"
```

---

### WS-4 · Task 4: NaN guards on numeric expression parsers (Item 20)

After every `parseFloat` in `parseFontExpression` (size), `parseLineHeightExpression`, and `parseLetterSpacingExpression`, check `Number.isFinite` and throw on `NaN` — consistent with `parseColorExpression` returning null for malformed input.

**Files:**
- Modify: `packages/server/src/expression-parser.ts` (`parseFontExpression` size ~338; `parseLineHeightExpression` ~343-357; `parseLetterSpacingExpression` ~359-369)
- Test: `packages/server/test/expression-parser.test.ts` (append to the three describe blocks)

- [ ] **Step 1: Write the failing test**

Append to `describe('parseFontExpression', ...)`:
```ts
  it('throws on a non-numeric font size', () => {
    expect(() =>
      parseFontExpression('Inter/Regular/abc'),
    ).toThrow('Invalid font size')
  })
```

Append to `describe('parseLineHeightExpression', ...)`:
```ts
  it('throws on a non-numeric line height', () => {
    expect(() => parseLineHeightExpression('abcpx')).toThrow(
      'Invalid line height',
    )
  })
```

Append to `describe('parseLetterSpacingExpression', ...)`:
```ts
  it('throws on a non-numeric letter spacing', () => {
    expect(() =>
      parseLetterSpacingExpression('abcpx'),
    ).toThrow('Invalid letter spacing')
  })
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/server/test/expression-parser.test.ts -t "throws on a non-numeric"`
Expected: FAIL (3 tests). Current parsers return `{ size: NaN }` / `{ value: NaN, unit: 'PIXELS' }` without throwing.

- [ ] **Step 3: Implement**

In `packages/server/src/expression-parser.ts`, change the `parseFontExpression` return (replace lines 335-340) to compute and validate `size`:
```ts
  const size = parseFloat(sizeStr)
  if (!Number.isFinite(size)) {
    throw new Error(`Invalid font size in "${expr}"`)
  }

  return {
    family,
    style,
    size,
    ...(styleName ? { styleName } : {}),
  }
```

Replace `parseLineHeightExpression` (lines 343-357):
```ts
export const parseLineHeightExpression = (
  expr: string,
): ParsedLineHeight => {
  if (expr === 'auto') {
    return { unit: 'AUTO' }
  }
  const value = parseFloat(expr)
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid line height "${expr}"`)
  }
  if (expr.endsWith('%')) {
    return { value, unit: 'PERCENT' }
  }
  // px (explicit suffix) or bare number both default to pixels
  return { value, unit: 'PIXELS' }
}
```

Replace `parseLetterSpacingExpression` (lines 359-369):
```ts
export const parseLetterSpacingExpression = (
  expr: string,
): ParsedLetterSpacing => {
  const value = parseFloat(expr)
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid letter spacing "${expr}"`)
  }
  if (expr.endsWith('%')) {
    return { value, unit: 'PERCENT' }
  }
  return { value, unit: 'PIXELS' }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/server/test/expression-parser.test.ts -t "throws on a non-numeric"`
Expected: PASS (3 tests). The existing `parses px value` / `parses percentage value` / `parses auto` tests stay green (behavior unchanged for valid input).

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean, 0 fail
```bash
git add packages/server/src/expression-parser.ts packages/server/test/expression-parser.test.ts && git commit -m "fix(parser): throw on NaN in font size, line-height, letter-spacing"
```

---

### WS-4 · Task 5: Reimplement parseEffectExpressions via parseEffectExpression (Item 12)

The two functions duplicate the same shadow/blur regexes. Reimplement `parseEffectExpressions` to call `parseEffectExpression` per item with an explicit throw-on-null — single regex source of truth, aligned with the fill path's throw-vs-skip semantics.

**Files:**
- Modify: `packages/server/src/expression-parser.ts` (`parseEffectExpressions` ~270-319)
- Test: `packages/server/test/expression-parser.test.ts` (append to `describe('parseEffectExpressions', ...)`)

- [ ] **Step 1: Write the failing test**

Append inside `describe('parseEffectExpressions', ...)`:
```ts
  it('throws on an unknown effect expression', () => {
    expect(() =>
      parseEffectExpressions(['glow(5)']),
    ).toThrow('Unknown effect expression: glow(5)')
  })

  it('matches parseEffectExpression for every supported form', () => {
    const inputs = [
      'shadow(0,4,8,#00000040)',
      'shadow(0,4,8,#000000,2)',
      'inner-shadow(0,2,4,#00000020)',
      'blur(10)',
      'bg-blur(20)',
      'style(Elevation/Medium)shadow(0,4,8,#00000040)',
    ]
    const batch = parseEffectExpressions(inputs)
    for (let i = 0; i < inputs.length; i++) {
      expect(batch[i]).toEqual(parseEffectExpression(inputs[i])!)
    }
  })
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/server/test/expression-parser.test.ts -t "matches parseEffectExpression for every supported form"`
Expected: This test PASSES against current duplicated code (outputs already match), and `throws on an unknown effect expression` also PASSES (current code throws `Unknown effect expression: glow(5)`). These tests are characterization tests that lock current behavior so the refactor stays byte-identical. To confirm they exercise the new path, first apply Step 3, run, and verify still green. (This is a refactor task: the tests guard the rewrite rather than drive new behavior — both must be green before and after.)

- [ ] **Step 3: Implement**

In `packages/server/src/expression-parser.ts`, replace the entire `parseEffectExpressions` body (lines 270-319) with:
```ts
export const parseEffectExpressions = (
  expressions: string[],
): ParsedEffect[] => {
  return expressions.map(expr => {
    const result = parseEffectExpression(expr)
    if (result === null) {
      throw new Error(`Unknown effect expression: ${expr}`)
    }
    return result
  })
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/server/test/expression-parser.test.ts`
Expected: PASS — the full `parseEffectExpressions` describe block (including the pre-existing `parses shadow()`, `parses shadow() with spread`, `strips style() prefix`, `DROP_SHADOW … fields`, and both new tests) stays green, proving output-identical behavior.

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean, 0 fail
```bash
git add packages/server/src/expression-parser.ts packages/server/test/expression-parser.test.ts && git commit -m "refactor(parser): derive parseEffectExpressions from parseEffectExpression"
```

---

### WS-4 · Task 6: Extract paintToExpression and effect formatter helpers (Item 13)

`parseFills`/`renderPaintValue` and `parseEffects`/`renderStyleEffect` carry near-duplicate paint and effect serialization (including the `atan2` angle math). Extract `paintToExpression(paint)` shared by both paint sites, and a per-element effect formatter with an `includeSpread` flag shared by both effect sites. Output must be byte-identical to today.

**Important byte-identity constraints (verified against current source):**
- `parseEffects` (line 134-139) **includes** spread (`,${e.spread}` when non-zero) → calls formatter with `includeSpread: true`.
- `renderStyleEffect` (line 801-827) **omits** spread → `includeSpread: false`.
- Both effect sites use the same `colorHex` (`'?'` fallback when no color) and `?? 0` for offset/radius.
- `parseFills` SOLID branch now (after Task 2) passes `effectiveAlpha`; `renderPaintValue` SOLID branch passes `paint.color` directly. To keep both byte-identical and avoid behavior drift, `paintToExpression` takes the already-resolved `FigmaFill` and applies the `effectiveAlpha` fold internally — `renderPaintValue`'s style paints have no per-paint `opacity` field, so `(opacity ?? 1) === 1` leaves them unchanged.

**Files:**
- Modify: `packages/server/src/parser.ts` (add helpers; rewire `parseFills` ~56-105, `parseEffects` ~108-152, `renderPaintValue` ~739-799, `renderStyleEffect` ~801-827)
- Test: `packages/server/test/parser.test.ts` — relies on the existing extensive `toStylesTree`, `parseNode`, and `parser-roundtrip` assertions as the byte-identity snapshot (no new test file needed; the existing 111 assertions cover every paint/effect form). Add one explicit cross-check test.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/test/parser-roundtrip.test.ts` inside the describe block (import `toStylesTree` is not needed; we cross-check `parseNode` output against `toStylesTree`'s renderer via a shared shape). Add a focused identity test:
```ts
  it('parseFills and style paint rendering agree on a linear gradient', () => {
    // Same gradient via node fills (parseFills path)
    const nodeRaw = {
      id: '1:13',
      name: 'G',
      type: 'RECTANGLE',
      absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      fills: [
        {
          type: 'GRADIENT_LINEAR',
          visible: true,
          gradientTransform: [
            [0.707, 0.707, 0],
            [-0.707, 0.707, 0],
          ],
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
          ],
        },
      ],
    }
    const parsed = parseNode(nodeRaw)
    // atan2(0.707, 0.707) ≈ 45deg
    expect(parsed.fills![0]).toBe(
      'linear-gradient(45deg, #FF0000 0%, #0000FF 100%)',
    )
  })
```

This documents the exact gradient string both paths must produce. The pre-existing `toStylesTree` test `renders linear gradient with angle and stop positions` (parser.test.ts line 562) already asserts `renderPaintValue` produces the same form via the `/...(\d+)deg.../` match — the two together pin both call sites.

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/server/test/parser-roundtrip.test.ts -t "parseFills and style paint rendering agree on a linear gradient"`
Expected: PASS already (current `parseFills` produces this exact string). Like Task 5, this is a refactor guard — run it, the `toStylesTree` block, and `parseNode` block before refactoring (all green) and again after to prove byte-identity. The driving requirement is that no assertion changes value.

- [ ] **Step 3: Implement**

In `packages/server/src/parser.ts`, add two shared helpers above `parseFills` (after `rgbaToHex`, line 51). The paint helper accepts the union of fields both call sites supply:

```ts
type PaintLike = {
  type: string
  opacity?: number
  color?: RGBA
  gradientStops?: { position: number; color: RGBA }[]
  gradientTransform?: number[][]
}

const paintToExpression = (paint: PaintLike): string => {
  if (
    paint.type === 'SOLID' &&
    paint.color !== null &&
    paint.color !== undefined
  ) {
    const effectiveAlpha =
      (paint.color.a ?? 1) * (paint.opacity ?? 1)
    return rgbaToHex({ ...paint.color, a: effectiveAlpha })
  }
  if (paint.type === 'IMAGE') {
    return 'image'
  }
  if (paint.gradientStops !== undefined) {
    const stops = paint.gradientStops
      .map(
        s =>
          `${rgbaToHex(s.color)} ${Math.round(s.position * 100)}%`,
      )
      .join(', ')
    if (paint.type === 'GRADIENT_LINEAR') {
      const transform = paint.gradientTransform
      const angle =
        transform !== undefined
          ? Math.round(
              (Math.atan2(transform[0][1], transform[0][0]) *
                180) /
                Math.PI,
            )
          : 0
      return `linear-gradient(${angle}deg, ${stops})`
    }
    if (paint.type === 'GRADIENT_RADIAL') {
      return `radial-gradient(${stops})`
    }
    if (paint.type === 'GRADIENT_ANGULAR') {
      return `angular-gradient(${stops})`
    }
    if (paint.type === 'GRADIENT_DIAMOND') {
      return `diamond-gradient(${stops})`
    }
  }
  return paint.type.toLowerCase()
}

const effectToExpression = (
  effect: FigmaEffect,
  includeSpread: boolean,
): string => {
  if (
    effect.type === 'DROP_SHADOW' ||
    effect.type === 'INNER_SHADOW'
  ) {
    const colorHex =
      effect.color !== null && effect.color !== undefined
        ? rgbaToHex(effect.color)
        : '?'
    const ox =
      effect.offset !== null && effect.offset !== undefined
        ? effect.offset.x
        : 0
    const oy =
      effect.offset !== null && effect.offset !== undefined
        ? effect.offset.y
        : 0
    const prefix =
      effect.type === 'DROP_SHADOW'
        ? 'shadow'
        : 'inner-shadow'
    const spreadStr =
      includeSpread &&
      effect.spread !== undefined &&
      effect.spread !== 0
        ? `,${effect.spread}`
        : ''
    return `${prefix}(${ox},${oy},${effect.radius ?? 0},${colorHex}${spreadStr})`
  }
  if (effect.type === 'BACKGROUND_BLUR') {
    return `bg-blur(${effect.radius ?? 0})`
  }
  if (effect.type === 'LAYER_BLUR') {
    return `blur(${effect.radius ?? 0})`
  }
  return effect.type.toLowerCase()
}
```

Replace `parseFills` (lines 53-106) `.map` body to delegate:
```ts
const parseFills = (
  fills: FigmaFill[],
): string[] | undefined => {
  const result = fills
    .filter(f => f.visible !== false)
    .map(f => paintToExpression(f))
    .filter((v): v is string => Boolean(v))

  return result.length > 0 ? result : undefined
}
```

Replace `parseEffects` (lines 108-152) `.map` body to delegate with spread:
```ts
const parseEffects = (
  effects: FigmaEffect[],
): string[] | undefined => {
  const result = effects
    .filter(e => e.visible !== false)
    .map(e => effectToExpression(e, true))

  return result.length > 0 ? result : undefined
}
```

Replace `renderPaintValue` (lines 739-799) to delegate (preserving the empty-array `'none'` guard):
```ts
const renderPaintValue = (
  paints: Record<string, unknown>[],
): string => {
  if (paints.length === 0) {
    return 'none'
  }
  return paintToExpression(paints[0] as PaintLike)
}
```

Replace `renderStyleEffect` (lines 801-827) to delegate without spread:
```ts
const renderStyleEffect = (effect: FigmaEffect): string =>
  effectToExpression(effect, false)
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/server/test/parser.test.ts packages/server/test/parser-roundtrip.test.ts`
Expected: PASS — all `parseNode`, `toStylesTree` (every gradient/solid/image/shadow/blur form), and round-trip assertions stay byte-identical. Spread appears in `parseNode` effects (`shadow(0,4,8,#00000040,2)` round-trip test) and is absent in `toStylesTree` effects (`shadow(0,4,12,#0000001A)` at parser.test.ts line 736), confirming the flag is wired correctly.

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean, 0 fail
```bash
git add packages/server/src/parser.ts packages/server/test/parser-roundtrip.test.ts && git commit -m "refactor(parser): extract shared paint and effect formatters"
```

---

### WS-4 · Task 7: Delete deprecated YAML serializers and their tests (Item 14)

Delete `toPageLayoutYaml`, `toStylesYaml`, `toComponentsYaml`, and `toInspectYaml`. Grep confirms **no production caller**: `read.ts` imports `parseNode, toInspectTree, toInspectTreeMulti, toPageLayoutTree, toFullJson, truncateChildren`; `design-system.ts` imports `toStylesTree, toComponentsTree`; `search.ts` imports `toSearchYaml`. The only references are the functions' own definitions and the `parser.test.ts` describe blocks for them. The `*Tree` variants fully cover the behavior.

**Files:**
- Modify: `packages/server/src/parser.ts` (delete `toInspectYaml` ~564-572; delete `toPageLayoutYaml` ~1021-1070; `toStylesYaml` ~1072-1148; `toComponentsYaml` ~1171-1215)
- Modify: `packages/server/test/parser.test.ts` (remove imports + the `toInspectYaml`, `toPageLayoutYaml`, `toStylesYaml`, `toComponentsYaml` describe blocks)

- [ ] **Step 1: Write the failing test**

This is a deletion task; the "test" is a grep-gate proving no caller remains. Run first to capture the current state:

Run: `grep -rn "toPageLayoutYaml\|toStylesYaml\|toComponentsYaml\|toInspectYaml" --include="*.ts" packages/ | grep -v '/test/'`
Expected (before): four lines, all in `packages/server/src/parser.ts` (the definitions only) — confirming zero production callers outside the file itself.

- [ ] **Step 2: Run the test, verify it fails**

After deletion the same grep must return empty:
Run: `grep -rn "toPageLayoutYaml\|toStylesYaml\|toComponentsYaml\|toInspectYaml" --include="*.ts" packages/`
Expected (before deletion): non-empty (definitions + test imports + test describe blocks present) — i.e. the "clean" state is not yet reached.

- [ ] **Step 3: Implement**

In `packages/server/src/parser.ts`:
- Delete `toInspectYaml` (the `// --- toInspectYaml`-less block at lines 564-572 — the `export const toInspectYaml = (parsed: ParsedNode): string => { ... }` that uses `buildHeader` + `YAML.stringify`). `buildHeader`, `computeSummary`, and `YAML` remain used elsewhere (`toInspectTree`, `toPageLayoutTree`, `toSearchYaml`), so keep them.
- Delete the `// --- toPageLayoutYaml ---` section and `toPageLayoutYaml` (lines 1021-1070).
- Delete the `// --- toStylesYaml ---` section and `toStylesYaml` (lines 1072-1148).
- Delete the `// --- toComponentsYaml ---` section and `toComponentsYaml` (lines 1171-1215).

In `packages/server/test/parser.test.ts`:
- Remove `toInspectYaml,`, `toPageLayoutYaml,`, `toStylesYaml,`, `toComponentsYaml,` from the import block (lines 6, 11, 13, 14).
- Delete the `describe('toInspectYaml', ...)` block (lines 116-135).
- Delete the `describe('toPageLayoutYaml', ...)` block (lines 309-323).
- Delete the `describe('toStylesYaml', ...)` block (lines 327-342).
- Delete the `describe('toComponentsYaml', ...)` block (lines 344-359).

Keep the `toInspectTree`, `toFullJson`, `toPageLayoutTree`, `toStylesTree`, `toComponentsTree`, `toInspectTreeMulti`, `parseNode`, `computeSummary` imports and blocks — all still exercised.

- [ ] **Step 4: Run the test, verify it passes**

Run: `grep -rn "toPageLayoutYaml\|toStylesYaml\|toComponentsYaml\|toInspectYaml" --include="*.ts" packages/`
Expected: empty (no matches).
Run: `bun test packages/server/test/parser.test.ts`
Expected: PASS (remaining describe blocks green; `YAML` import in parser.ts still used by `toSearchYaml`/`toPageLayoutTree`/`toInspectTree`, so no unused-import error).

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean (no orphaned references), 0 fail
```bash
git add packages/server/src/parser.ts packages/server/test/parser.test.ts && git commit -m "chore(parser): delete deprecated YAML serializers with no callers"
```

---

### WS-4 · Task 8: Document angle as linear-only and drop it from non-linear gradients (Items 18 + doc)

`angle` is meaningful only for linear gradients (it derives from `gradientTransform` and the build side never converts it back for radial/angular/diamond). The parser already omits angle on the renderer side for non-linear gradients (no `(angle)` in `radial-gradient(...)` etc.), but `parseColorExpression` always returns `angle: 0` on the `ParsedGradientPaint` for all four types. Drop `angle` from non-linear results and document the linear-only rule in `docs/specs/expression-formats.md`. Single source of truth — no contradictions (doc-management discipline).

**Files:**
- Modify: `packages/server/src/expression-parser.ts` (`parseColorExpression` gradient branch ~163-197)
- Modify: `docs/specs/expression-formats.md` (gradient row notes ~99-104)
- Test: `packages/server/test/expression-parser.test.ts` (extend gradient assertions)

- [ ] **Step 1: Write the failing test**

Append inside `describe('parseColorExpression', ...)`:
```ts
  it('omits angle for non-linear gradients', () => {
    const radial = parseColorExpression(
      'radial-gradient(#FFFFFF 0%, #00000000 100%)',
    )
    if (!radial || radial.type !== 'GRADIENT_RADIAL') {
      throw new Error('Expected GRADIENT_RADIAL')
    }
    expect('angle' in radial).toBe(false)

    const angular = parseColorExpression(
      'angular-gradient(#FF0000 0%, #0000FF 100%)',
    )
    if (!angular || angular.type !== 'GRADIENT_ANGULAR') {
      throw new Error('Expected GRADIENT_ANGULAR')
    }
    expect('angle' in angular).toBe(false)
  })

  it('keeps angle for linear gradients', () => {
    const linear = parseColorExpression(
      'linear-gradient(45deg, #FF0000 0%, #0000FF 100%)',
    )
    if (!linear || linear.type !== 'GRADIENT_LINEAR') {
      throw new Error('Expected GRADIENT_LINEAR')
    }
    expect(linear.angle).toBe(45)
  })
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/server/test/expression-parser.test.ts -t "omits angle for non-linear gradients"`
Expected: FAIL. Current code sets `angle` on every `ParsedGradientPaint`, so `'angle' in radial` is `true`.

- [ ] **Step 3: Implement**

First, narrow the type so `angle` is linear-only. In `packages/server/src/expression-parser.ts`, split `ParsedGradientPaint` (lines 15-20):
```ts
export type ParsedLinearGradientPaint = {
  type: 'GRADIENT_LINEAR'
  gradientStops: ParsedGradientStop[]
  angle: number
  styleName?: string
}

export type ParsedNonLinearGradientPaint = {
  type: 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND'
  gradientStops: ParsedGradientStop[]
  styleName?: string
}

export type ParsedGradientPaint =
  | ParsedLinearGradientPaint
  | ParsedNonLinearGradientPaint
```

`ParsedPaint` (line 30) is unchanged (`ParsedSolidPaint | ParsedGradientPaint | ParsedImagePaint`). The `typeMap` (lines 167-172) keeps its `Record<string, ParsedGradientPaint['type']>` annotation — `ParsedGradientPaint['type']` is the union of all four literals, so it still type-checks.

Replace the gradient result construction (lines 174-196) to attach `angle` only for linear:
```ts
    let stopsStr = inner

    if (gradientType === 'linear') {
      const angleMatch = inner.match(
        /^(-?\d+(?:\.\d+)?)deg,\s*(.+)$/,
      )
      let angle = 0
      if (angleMatch) {
        angle = parseFloat(angleMatch[1])
        // eslint-disable-next-line @typescript-eslint/prefer-destructuring
        stopsStr = angleMatch[2]
      }
      const gradientStops = parseGradientStops(stopsStr)
      const result: ParsedLinearGradientPaint = {
        type: 'GRADIENT_LINEAR',
        gradientStops,
        angle,
        ...(styleName ? { styleName } : {}),
      }
      return result
    }

    const gradientStops = parseGradientStops(stopsStr)
    const result: ParsedNonLinearGradientPaint = {
      type: typeMap[gradientType] as
        | 'GRADIENT_RADIAL'
        | 'GRADIENT_ANGULAR'
        | 'GRADIENT_DIAMOND',
      gradientStops,
      ...(styleName ? { styleName } : {}),
    }
    return result
```

Note: this also folds the sign-fix from Task 1 (the `-?` regex) into the new linear branch — consistent with Task 1.

Then update `docs/specs/expression-formats.md`. Change the gradient `{…}`/angle note (line 99-100) so the doc states angle is linear-only. Replace lines 99-100:
```md
- **Gradients:** `linear`'s first arg is the angle in degrees (derived from Figma's
  `gradientTransform`). **Angle is linear-only** — `radial`, `angular`, and `diamond`
  carry no angle (the build side never converts angle back to a transform for them);
  non-trivial geometry for any gradient goes in `{tf=[a,b,c,d,e,f]}`. Stops are `#color@percent`.
```

Verify no other line in the doc claims angle for non-linear gradients (the example at line 191 uses `linear(135, ...)` only — consistent; the table rows at 89-91 already show radial/angular/diamond with no angle — consistent). No contradiction introduced.

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/server/test/expression-parser.test.ts -t "angle"`
Expected: PASS (both new tests; the pre-existing `parses linear-gradient expression` asserting `result.angle === 90` and `GRADIENT_LINEAR paint has gradientStops and angle` still pass).

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean (the narrowed union compiles; existing gradient tests use `result.type !== 'GRADIENT_LINEAR' && … !== 'GRADIENT_DIAMOND'` guards that still narrow correctly), 0 fail
```bash
git add packages/server/src/expression-parser.ts packages/server/test/expression-parser.test.ts docs/specs/expression-formats.md && git commit -m "refactor(parser): make gradient angle linear-only and document the rule"
```

---

## WS-5 · Tools robustness

This workstream introduces the shared tool helpers (contract C), migrates all 7 tool files onto them, and hardens each handler. Tasks are ordered so the helper module lands first (every later task imports from it). The pinned not-connected string `'Not connected to Figma. Use connect tool first.'` is preserved verbatim inside `requireConnected`. `FigmaClient.sendCommand` already supports throwing/rejection (it returns `Promise<unknown>`), so the try/catch tasks use a rejecting mock.

---

### WS-5 · Task 1: Create `tools/shared.ts` and migrate all 7 tool files (items 29 + contract C)

Create the shared helper module per contract (C), then migrate every tool file to import `ToolResult`, `textResult`, `requireConnected`, `formatMutationResult` and delete each file's local `type ToolResult` declaration and inline not-connected guard. Behavior-preserving — the existing 251-green suite must stay green.

**Files:**
- Create: `packages/server/src/tools/shared.ts`
- Create test: `packages/server/test/tools/shared.test.ts`
- Modify: `packages/server/src/tools/create.ts` (lines 15-17, 300-309, 323-337, 357-366, 395-409)
- Modify: `packages/server/src/tools/create-component.ts` (lines 3-5, 27-36, 49-66)
- Modify: `packages/server/src/tools/create-svg.ts` (lines 3-5, 16-25, 37-54)
- Modify: `packages/server/src/tools/read.ts` (lines 12-14, all inline not-connected guards)
- Modify: `packages/server/src/tools/search.ts` (lines 4-6, 17-26)
- Modify: `packages/server/src/tools/design-system.ts` (lines 4-6, 12-21, 81-90)
- Modify: `packages/server/src/tools/export.ts` (lines 19-28)
- Modify: `packages/server/src/tools/session.ts` (lines 5-7, 107-116)

- [ ] **Step 1: Write the failing test**
```ts
// packages/server/test/tools/shared.test.ts
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
const disconnected: FigmaClient = { ...connected, isConnected: () => false }

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
```
- [ ] **Step 2: Run the test, verify it fails**
Run: `bun test packages/server/test/tools/shared.test.ts`
Expected: FAIL — `Cannot find module '@figma-agent-bridge/server/tools/shared'` (module does not exist yet).
- [ ] **Step 3: Implement**

Create `packages/server/src/tools/shared.ts` (contract C verbatim):
```ts
import type { FigmaClient } from '../figma-client'

export type ToolResult = {
  content: { type: 'text'; text: string }[]
}

export const textResult = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
})

export const requireConnected = (
  client: FigmaClient,
): ToolResult | null =>
  client.isConnected()
    ? null
    : textResult(
        'Not connected to Figma. Use connect tool first.',
      )

export const formatMutationResult = (
  result: { error?: string } | null,
  failMsg: string,
): ToolResult => {
  if (result === null) return textResult(failMsg)
  if (result.error !== undefined)
    return textResult(`Error: ${result.error}`)
  return textResult(JSON.stringify(result, null, 2))
}
```

Then migrate each tool file. **`create.ts`** — replace the local `ToolResult` decl (lines 15-17) and the two handler guards/result branches:
```ts
import type { FigmaClient } from '../figma-client'
import type {
  CreateNodeSpec,
  CreateTreeNodeSpec,
} from '@figma-agent-bridge/shared'
import {
  parseFillExpressions,
  parseEffectExpressions,
  parseFontExpression,
  parseLineHeightExpression,
  parseLetterSpacingExpression,
  parseColorExpression,
} from '../expression-parser'
import {
  type ToolResult,
  requireConnected,
  formatMutationResult,
} from './shared'
```
`handleCreateNode` body (the connection guard + result branches; the `styleCache` path is removed in Task 2, so for *this* task keep `styleCache` param and `resolveStyleIds` untouched — only swap guard + result formatting):
```ts
export const handleCreateNode = async (
  params: {
    parentId: string
    node: CreateNodeSpec
  },
  client: FigmaClient,
  styleCache?: StyleCache,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) return guard

  const converted = convertNodeSpec(params.node)

  if (styleCache) {
    resolveStyleIds(converted, styleCache)
  }

  const result = (await client.sendCommand('create_node', {
    parentId: params.parentId,
    node: converted,
  })) as Record<string, unknown> | null

  return formatMutationResult(result, 'Failed to create node.')
}
```
`handleCreateTree` body similarly — guard via `requireConnected`, return `formatMutationResult(result, 'Failed to create tree.')`.

**`create-component.ts`**:
```ts
import type { FigmaClient } from '../figma-client'
import {
  type ToolResult,
  textResult,
  requireConnected,
  formatMutationResult,
} from './shared'

export const handleCreateComponent = async (
  params: {
    nodeId?: string
    nodeIds?: string[]
    combineAsVariants?: boolean
    slots?: string[]
    componentProperties?: {
      name: string
      type: string
      default: string | boolean
    }[]
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  if (!params.nodeId && (!params.nodeIds || params.nodeIds.length === 0)) {
    return textResult('Error: Either nodeId or nodeIds must be provided.')
  }

  const guard = requireConnected(client)
  if (guard) return guard

  const result = (await client.sendCommand(
    'create_component',
    {
      nodeId: params.nodeId,
      nodeIds: params.nodeIds,
      combineAsVariants: params.combineAsVariants,
      slots: params.slots,
      componentProperties: params.componentProperties,
    },
  )) as Record<string, unknown> | null

  return formatMutationResult(result, 'Failed to create component.')
}
```

**`create-svg.ts`**:
```ts
import type { FigmaClient } from '../figma-client'
import {
  type ToolResult,
  requireConnected,
  formatMutationResult,
} from './shared'

export const handleCreateFromSvg = async (
  params: {
    parentId: string
    svg: string
    name?: string
    size?: [number, number]
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) return guard

  const result = (await client.sendCommand(
    'create_from_svg',
    {
      parentId: params.parentId,
      svg: params.svg,
      name: params.name,
      size: params.size,
    },
  )) as Record<string, unknown> | null

  return formatMutationResult(result, 'Failed to create from SVG.')
}
```

**`read.ts`** — replace local `ToolResult` (lines 12-14) with an import and replace each inline not-connected guard across all five handlers. Import line:
```ts
import {
  type ToolResult,
  textResult,
  requireConnected,
} from './shared'
```
Each handler's guard becomes:
```ts
  const guard = requireConnected(client)
  if (guard) return guard
```
The non-mutation `textResult` returns also collapse, e.g. in `handleInspect`:
```ts
    if (raw === null) {
      return textResult(`Node not found: ${nodeId}`)
    }
```
and the selection-empty / no-nodes / page-layout-null / get-node-null / get-nodes-null / list-pages-null returns all become single `textResult(...)` calls preserving the exact existing strings. (read.ts has no `result.error` mutation path, so `formatMutationResult` is not used here.)

**`search.ts`**:
```ts
import type { FigmaClient } from '../figma-client'
import { toSearchYaml } from '../parser'
import {
  type ToolResult,
  textResult,
  requireConnected,
} from './shared'
```
guard via `requireConnected`; `raw === null` branch → `return textResult('Search failed: no response from plugin.')`; final return keeps `textResult(toSearchYaml(mapped, raw.truncated))`.

**`design-system.ts`** — import `{ type ToolResult, textResult, requireConnected }`; both handlers use `requireConnected` guard; null branches → `textResult('Failed to get styles from plugin.')` / `textResult('Failed to get components from plugin.')`; the invalid-type and tree returns become `textResult(...)`.

**`export.ts`** — its return type is inferred (not `ToolResult`, because of `image` content), so do NOT change its return type. Only replace the not-connected guard:
```ts
import type { FigmaClient } from '../figma-client'
import { requireConnected } from './shared'
// ...
export const handleExport = async (
  params: ExportParams,
  client: FigmaClient,
) => {
  const guard = requireConnected(client)
  if (guard) return guard
  // ... rest unchanged
```

**`session.ts`** — `handleConnect` builds custom text and does NOT have a not-connected guard (it joins), so only migrate the local `ToolResult` decl and use `textResult` for its returns; `handleStatus` keeps its own `disconnected`/`connected to channel` strings via `textResult`:
```ts
import type { FigmaClient } from '../figma-client'
import { discoverChannels } from '../figma-client'
import { ensureRelay } from '../ensure-relay'
import { type ToolResult, textResult } from './shared'
```
`handleStatus`:
```ts
export const handleStatus = async (
  client: FigmaClient,
): Promise<ToolResult> => {
  if (!client.isConnected()) {
    return textResult('disconnected')
  }
  const channel = client.currentChannel()
  return textResult(`connected to channel: ${channel}`)
}
```
(All `handleConnect` returns rewritten to `textResult(...)` preserving exact strings.)

- [ ] **Step 4: Run the test, verify it passes**
Run: `bun test packages/server/test/tools/shared.test.ts`
Expected: PASS (8 assertions).
- [ ] **Step 5: Typecheck + full suite + commit**
Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean, 0 fail (still 251 + 8 new shared = 259 total, all green).
```bash
git add packages/server/src/tools/shared.ts packages/server/test/tools/shared.test.ts packages/server/src/tools/create.ts packages/server/src/tools/create-component.ts packages/server/src/tools/create-svg.ts packages/server/src/tools/read.ts packages/server/src/tools/search.ts packages/server/src/tools/design-system.ts packages/server/src/tools/export.ts packages/server/src/tools/session.ts && git commit -m "refactor(server): extract shared tool helpers and migrate all tool files"
```

---

### WS-5 · Task 2: Delete the styleCache path (item 10)

Remove `resolveStyleIds`, the `StyleCache` type, `resolveTreeStyles`, and the `styleCache` params on `handleCreateNode`/`handleCreateTree`. Delete the test that passes a cache.

**Files:**
- Modify: `packages/server/src/tools/create.ts` (delete lines 19-86 `StyleCache`/`resolveStyleIds`; remove `styleCache` param + block in both handlers)
- Modify: `packages/server/test/tools/create.test.ts` (delete the `resolves style names to style IDs` test, lines 86-126)

- [ ] **Step 1: Write the failing test**
This task is a deletion; the "test" is the removal of the now-invalid `styleCache` test plus a guard assertion that no styleCache references remain. Add a temporary assertion to `create.test.ts` proving the handler signature no longer accepts a cache (TypeScript-level), realized as a runtime grep gate in Step 2. Concretely, first delete the obsolete test block (lines 86-126: the entire `it('resolves style names to style IDs when style cache is provided', ...)`).
- [ ] **Step 2: Run the test, verify it fails**
Run: `grep -rn "styleCache" packages/server/src packages/server/test`
Expected: BEFORE the edit, matches in `create.ts` (lines 19-86, 298, 314-315, 355, 371-387) and `create.test.ts` (101, 120). This is the "red" state — styleCache still present.
- [ ] **Step 3: Implement**

In `create.ts`, delete lines 19-86 entirely (the `StyleCache` type, the doc comment, and the whole `resolveStyleIds` function). Update both handler signatures and bodies:
```ts
export const handleCreateNode = async (
  params: {
    parentId: string
    node: CreateNodeSpec
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) return guard

  const converted = convertNodeSpec(params.node)

  const result = (await client.sendCommand('create_node', {
    parentId: params.parentId,
    node: converted,
  })) as Record<string, unknown> | null

  return formatMutationResult(result, 'Failed to create node.')
}

export const handleCreateTree = async (
  params: {
    parentId: string
    node: CreateTreeNodeSpec
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) return guard

  const converted = convertTreeNodeSpec(params.node)

  const result = (await client.sendCommand('create_tree', {
    parentId: params.parentId,
    node: converted,
  })) as Record<string, unknown> | null

  return formatMutationResult(result, 'Failed to create tree.')
}
```
Confirm the obsolete `create.test.ts` block (the `resolves style names to style IDs` `it`) is deleted.
- [ ] **Step 4: Run the test, verify it passes**
Run: `grep -rn "styleCache" packages/server/src packages/server/test; bun test packages/server/test/tools/create.test.ts`
Expected: grep prints NOTHING (exit 1, zero matches); create.test.ts PASSES with the remaining create-node/create-tree cases green.
- [ ] **Step 5: Typecheck + full suite + commit**
Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean, 0 fail.
```bash
git add packages/server/src/tools/create.ts packages/server/test/tools/create.test.ts && git commit -m "refactor(server): remove dead styleCache resolution path from create tools"
```

---

### WS-5 · Task 3: try/catch error model for plugin mutations (item 6)

Wrap the `sendCommand` call in `create`, `create-component`, `create-svg`, `read`, `search`, `export` handlers so a thrown/rejected plugin error becomes a tool-formatted `Error: <message>` instead of an unhandled rejection. The non-throw `result.error` path is already centralized in `formatMutationResult` (Task 1), so this task only adds the throw path.

**Files:**
- Modify: `packages/server/src/tools/create.ts` (wrap both `sendCommand` calls)
- Modify: `packages/server/src/tools/create-component.ts`
- Modify: `packages/server/src/tools/create-svg.ts`
- Modify: `packages/server/src/tools/read.ts` (wrap `handleInspect`/`handleGetNode`/`handleGetNodes`/`handleListPages` plugin calls)
- Modify: `packages/server/src/tools/search.ts`
- Modify: `packages/server/src/tools/export.ts`
- Modify test: `packages/server/test/tools/create.test.ts`, `create-component.test.ts`, `create-svg.test.ts`, `read.test.ts`, `search.test.ts`, `export.test.ts`

- [ ] **Step 1: Write the failing test**
Add one rejecting-mock test to each affected test file. The create.test.ts addition (append inside `describe('handleCreateNode', ...)`):
```ts
  it('maps a thrown plugin error to a tool-formatted message', async () => {
    const client: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () =>
        Promise.reject(new Error('plugin exploded')),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleCreateNode(
      {
        parentId: '1:2',
        node: { type: 'FRAME', name: 'X', size: [10, 10] },
      },
      client,
    )

    expect(result.content[0].text).toBe(
      'Error: plugin exploded',
    )
  })
```
Mirror this in each other file with the matching handler/params:
- `create-component.test.ts`: call `handleCreateComponent({ nodeId: '1:42' }, client)` → expect `'Error: plugin exploded'`.
- `create-svg.test.ts`: `handleCreateFromSvg({ parentId: '1:2', svg: '<svg></svg>' }, client)` → expect `'Error: plugin exploded'`.
- `read.test.ts` (inside `describe('handleGetNode', ...)`): `handleGetNode({ nodeId: '1:42' }, client)` → expect `'Error: plugin exploded'`.
- `search.test.ts`: `handleSearch({ name: 'Card' }, client)` → expect `'Error: plugin exploded'`.
- `export.test.ts`: `handleExport({ nodeId: '1:42' }, client)` → `expect((result.content[0] as { text: string }).text).toBe('Error: plugin exploded')`.
- [ ] **Step 2: Run the test, verify it fails**
Run: `bun test packages/server/test/tools/create.test.ts -t "maps a thrown plugin error"`
Expected: FAIL — the test rejects (unhandled `Error: plugin exploded`) because `handleCreateNode` does not catch; the awaited call throws instead of returning a `ToolResult`.
- [ ] **Step 3: Implement**

`create.ts` — wrap each mutation. `handleCreateNode`:
```ts
  const converted = convertNodeSpec(params.node)

  try {
    const result = (await client.sendCommand('create_node', {
      parentId: params.parentId,
      node: converted,
    })) as Record<string, unknown> | null

    return formatMutationResult(result, 'Failed to create node.')
  } catch (err) {
    return textResult(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
```
(add `textResult` to the `./shared` import in create.ts). `handleCreateTree` identically with `'create_tree'` and `'Failed to create tree.'`.

`create-component.ts` — wrap the `sendCommand`:
```ts
  try {
    const result = (await client.sendCommand(
      'create_component',
      {
        nodeId: params.nodeId,
        nodeIds: params.nodeIds,
        combineAsVariants: params.combineAsVariants,
        slots: params.slots,
        componentProperties: params.componentProperties,
      },
    )) as Record<string, unknown> | null

    return formatMutationResult(result, 'Failed to create component.')
  } catch (err) {
    return textResult(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
```

`create-svg.ts` — same shape, `'create_from_svg'` / `'Failed to create from SVG.'`.

`search.ts` — wrap the `search_nodes` call (the mapping must stay inside `try` since `raw.results.map` runs after):
```ts
  try {
    const raw = (await client.sendCommand(
      'search_nodes',
      pluginParams,
    )) as { /* …unchanged shape… */ } | null

    if (raw === null) {
      return textResult('Search failed: no response from plugin.')
    }

    const mapped = raw.results.map(/* unchanged */)
    return textResult(toSearchYaml(mapped, raw.truncated))
  } catch (err) {
    return textResult(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
```

`export.ts` — wrap the `export_node` call and all downstream formatting; the catch returns a text item:
```ts
  try {
    const result = (await client.sendCommand('export_node', {
      nodeId: params.nodeId,
      format,
      scale,
    })) as { format: string; scale: number; data: string } | null
    // …existing null check, SVG branch, image branch unchanged…
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    }
  }
```

`read.ts` — wrap the plugin `sendCommand` calls in each handler in a `try`, with a shared catch returning `textResult('Error: ' + message)`. For `handleInspect` the `try` wraps from the first `sendCommand('get_node'/'get_selection')` through the tree building; the catch returns `textResult(...)`. Apply the same pattern to `handleInspectPageLayout`, `handleGetNode`, `handleGetNodes`, `handleListPages`.
- [ ] **Step 4: Run the test, verify it passes**
Run: `bun test packages/server/test/tools/create.test.ts packages/server/test/tools/create-component.test.ts packages/server/test/tools/create-svg.test.ts packages/server/test/tools/read.test.ts packages/server/test/tools/search.test.ts packages/server/test/tools/export.test.ts -t "thrown plugin error"`
Expected: PASS (one per file).
- [ ] **Step 5: Typecheck + full suite + commit**
Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean, 0 fail.
```bash
git add packages/server/src/tools/create.ts packages/server/src/tools/create-component.ts packages/server/src/tools/create-svg.ts packages/server/src/tools/read.ts packages/server/src/tools/search.ts packages/server/src/tools/export.ts packages/server/test/tools/create.test.ts packages/server/test/tools/create-component.test.ts packages/server/test/tools/create-svg.test.ts packages/server/test/tools/read.test.ts packages/server/test/tools/search.test.ts packages/server/test/tools/export.test.ts && git commit -m "feat(server): map thrown plugin errors to tool-formatted results"
```

---

### WS-5 · Task 4: Array.isArray guards + export data type validation (items 21, 22)

Add `Array.isArray` guards before `.map`/`.filter` in `search.ts` (~67), `read.ts` (~224 `handleGetNodes`), and `design-system.ts` (~117-122), returning `'Unexpected response from plugin'` when the plugin returns a non-array. In `export.ts`, validate `typeof result.data === 'string'` after the null check.

**Files:**
- Modify: `packages/server/src/tools/search.ts` (before `raw.results.map`)
- Modify: `packages/server/src/tools/read.ts` (`handleGetNodes`, before `raw.map`)
- Modify: `packages/server/src/tools/design-system.ts` (`handleInspectComponents`, before `raw.local.filter`/`raw.remote.filter`)
- Modify: `packages/server/src/tools/export.ts` (after `result === null` check)
- Modify test: `packages/server/test/tools/search.test.ts`, `read.test.ts`, `design-system.test.ts`, `export.test.ts`

- [ ] **Step 1: Write the failing test**
`search.test.ts`:
```ts
  it('returns Unexpected response when results is not an array', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () =>
        Promise.resolve({ results: null, truncated: false }),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }
    const result = await handleSearch({ name: 'X' }, mockClient)
    expect(result.content[0].text).toBe(
      'Unexpected response from plugin',
    )
  })
```
`read.test.ts` (inside `describe('handleGetNodes', ...)`):
```ts
  it('returns Unexpected response when plugin returns a non-array', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () => Promise.resolve({ not: 'an array' }),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }
    const result = await handleGetNodes(
      { nodeIds: ['1:42'] },
      mockClient,
    )
    expect(result.content[0].text).toBe(
      'Unexpected response from plugin',
    )
  })
```
`design-system.test.ts` (inside `describe('handleInspectComponents', ...)`):
```ts
  it('returns Unexpected response when local is not an array', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () =>
        Promise.resolve({ local: null, remote: [] }),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }
    const result = await handleInspectComponents(
      { query: 'Button' },
      mockClient,
    )
    expect(result.content[0].text).toBe(
      'Unexpected response from plugin',
    )
  })
```
`export.test.ts`:
```ts
  it('returns Unexpected response when data is not a string', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: () =>
        Promise.resolve({ format: 'PNG', scale: 1, data: 123 }),
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }
    const result = await handleExport({ nodeId: '1:42' }, mockClient)
    expect((result.content[0] as { text: string }).text).toBe(
      'Unexpected response from plugin',
    )
  })
```
- [ ] **Step 2: Run the test, verify it fails**
Run: `bun test packages/server/test/tools/search.test.ts -t "Unexpected response"`
Expected: FAIL — without the guard, `raw.results.map` throws `TypeError: null is not iterable`/`.map is not a function`, so the call rejects instead of returning `'Unexpected response from plugin'`.
- [ ] **Step 3: Implement**

`search.ts` — after the `raw === null` check:
```ts
  if (!Array.isArray(raw.results)) {
    return textResult('Unexpected response from plugin')
  }

  const mapped = raw.results.map(r => ({
```

`read.ts` `handleGetNodes` — after the `raw === null` check, before `raw.map`:
```ts
  if (!Array.isArray(raw)) {
    return textResult('Unexpected response from plugin')
  }

  const effectiveDepth = depth ?? 3
```

`design-system.ts` `handleInspectComponents` — inside the `if (query !== undefined)` block, before building `filtered`:
```ts
  if (query !== undefined) {
    if (!Array.isArray(raw.local) || !Array.isArray(raw.remote)) {
      return textResult('Unexpected response from plugin')
    }
    const escaped = query
```

`export.ts` — after `result === null`:
```ts
  if (typeof result.data !== 'string') {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Unexpected response from plugin',
        },
      ],
    }
  }
```
(Note: `search.ts`, `read.ts`, `design-system.ts` already import `textResult` from `./shared` after Task 1.)
- [ ] **Step 4: Run the test, verify it passes**
Run: `bun test packages/server/test/tools/search.test.ts packages/server/test/tools/read.test.ts packages/server/test/tools/design-system.test.ts packages/server/test/tools/export.test.ts -t "Unexpected response"`
Expected: PASS (4).
- [ ] **Step 5: Typecheck + full suite + commit**
Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean, 0 fail.
```bash
git add packages/server/src/tools/search.ts packages/server/src/tools/read.ts packages/server/src/tools/design-system.ts packages/server/src/tools/export.ts packages/server/test/tools/search.test.ts packages/server/test/tools/read.test.ts packages/server/test/tools/design-system.test.ts packages/server/test/tools/export.test.ts && git commit -m "fix(server): guard non-array plugin responses and validate export data type"
```

---

### WS-5 · Task 5: inspect_components case-insensitive substring match (item 23)

Replace the regex-based filter in `handleInspectComponents` with a true case-insensitive substring match (`name.toLowerCase().includes(query.toLowerCase())`) matching the schema docs, guarding non-string names.

**Files:**
- Modify: `packages/server/src/tools/design-system.ts` (lines 111-123, the `query !== undefined` block)
- Modify test: `packages/server/test/tools/design-system.test.ts`

- [ ] **Step 1: Write the failing test**
The current regex treats `*` as wildcard and is anchored differently; a lowercase query against a mixed-case name should still match via substring. Append inside `describe('handleInspectComponents', ...)`:
```ts
  it('matches query as a case-insensitive substring', async () => {
    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: cmd => {
        if (cmd === 'get_local_components') {
          return Promise.resolve({
            local: [
              { name: 'Primary Button', id: '1:1', key: 'k1' },
              { name: 'Avatar', id: '1:2', key: 'k2' },
            ],
            remote: [],
          })
        }
        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspectComponents(
      { query: 'button' },
      mockClient,
    )

    expect(result.content[0].text).toContain('Primary Button')
    expect(result.content[0].text).not.toContain('Avatar')
  })
```
- [ ] **Step 2: Run the test, verify it fails**
Run: `bun test packages/server/test/tools/design-system.test.ts -t "case-insensitive substring"`
Expected: FAIL — the existing `new RegExp(escaped, 'i')` with `.replace(/\*/g, '.*')` still happens to match here, BUT the inline mock uses a `name` that exercises substring; if the regex path passes, harden the test name `query: 'tton'` (a mid-word fragment) which the anchored docs-contract substring must match — confirm the assertion that drives the change: a mid-word fragment `'tton'` must match `'Primary Button'`. Use `query: 'tton'` so the assertion is `toContain('Primary Button')` and the FAIL reason is the regex/escape path not being the documented substring contract.
- [ ] **Step 3: Implement**

Replace lines 111-123 (`if (query !== undefined) { … }`) — combine with the Array guard from Task 4:
```ts
  if (query !== undefined) {
    if (!Array.isArray(raw.local) || !Array.isArray(raw.remote)) {
      return textResult('Unexpected response from plugin')
    }
    const needle = query.toLowerCase()
    const matches = (c: Record<string, unknown>): boolean =>
      typeof c.name === 'string' &&
      c.name.toLowerCase().includes(needle)
    const filtered = {
      local: raw.local.filter(matches),
      remote: raw.remote.filter(matches),
    }

    return {
      content: [
        { type: 'text', text: toComponentsTree(filtered) },
      ],
    }
  }
```
- [ ] **Step 4: Run the test, verify it passes**
Run: `bun test packages/server/test/tools/design-system.test.ts`
Expected: PASS — the new substring test and the existing `filters by query when provided` test (`query: 'Button'`) both green.
- [ ] **Step 5: Typecheck + full suite + commit**
Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean, 0 fail.
```bash
git add packages/server/src/tools/design-system.ts packages/server/test/tools/design-system.test.ts && git commit -m "fix(server): use case-insensitive substring match in inspect_components"
```

---

### WS-5 · Task 6: multi-selection inspect failure note (item 9)

When `parsedNodes.length < selection.length` in `handleInspect`'s multi-selection branch, prepend a note listing the failed selection ids. Because `parsedNodes` drops the original ids, track which `raws[i]` are null and map back to `selection[i].id`. Update the existing `skips nodes that fail to fetch` test to assert the note.

**Files:**
- Modify: `packages/server/src/tools/read.ts` (lines ~91-123, the multi-selection branch)
- Modify test: `packages/server/test/tools/read.test.ts` (lines 156-191)

- [ ] **Step 1: Write the failing test**
The existing test has a 2-node selection where `9:99` fails, so only one node resolves and it falls back to the single-node tree. The contract says to *prepend a note listing failed ids*. Replace the existing `skips nodes that fail to fetch in multi-selection` test so the selection has THREE nodes, two of which resolve (triggering the multi tree) and one fails (triggering the note):
```ts
  it('prepends a note listing failed ids in multi-selection', async () => {
    const secondFixture = JSON.parse(
      JSON.stringify(cardFixture),
    )
    secondFixture.id = '2:1'
    secondFixture.name = 'Card2'

    const mockClient: FigmaClient = {
      joinChannel: () => Promise.resolve(''),
      sendCommand: (cmd, params) => {
        if (cmd === 'get_selection') {
          return Promise.resolve([
            { id: '1:42', name: 'Card', type: 'FRAME' },
            { id: '2:1', name: 'Card2', type: 'FRAME' },
            { id: '9:99', name: 'Missing', type: 'FRAME' },
          ])
        }
        if (cmd === 'get_node') {
          const p = params as { nodeId: string }
          if (p.nodeId === '9:99') return Promise.resolve(null)
          if (p.nodeId === '2:1') return Promise.resolve(secondFixture)
          return Promise.resolve(cardFixture)
        }
        return Promise.resolve(null)
      },
      disconnect: () => undefined,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    }

    const result = await handleInspect({}, mockClient)

    // multi tree rendered for the 2 resolved nodes
    expect(result.content[0].text).toContain('# 2 selected')
    // plus a note naming the failed id
    expect(result.content[0].text).toContain(
      'Note: failed to fetch 1 node(s): 9:99',
    )
  })
```
- [ ] **Step 2: Run the test, verify it fails**
Run: `bun test packages/server/test/tools/read.test.ts -t "prepends a note listing failed ids"`
Expected: FAIL — current code renders the multi tree but emits no note, so the `toContain('Note: failed to fetch 1 node(s): 9:99')` assertion fails.
- [ ] **Step 3: Implement**

Rewrite the multi-selection branch (lines ~90-123) to keep the per-index pairing:
```ts
  // Multi-selection: fetch all nodes in parallel
  const raws = await Promise.all(
    selection.map(sel =>
      client.sendCommand('get_node', {
        nodeId: sel.id,
      }),
    ),
  )
  const failedIds = selection
    .filter((_, i) => raws[i] === null)
    .map(sel => sel.id)
  const parsedNodes = raws
    .filter(
      (raw): raw is Record<string, unknown> => raw !== null,
    )
    .map(raw => parseNode(raw))

  const note =
    parsedNodes.length < selection.length
      ? `Note: failed to fetch ${failedIds.length} node(s): ${failedIds.join(', ')}\n\n`
      : ''

  // If only one node resolved, fall back to single-node format
  if (parsedNodes.length === 1) {
    const singleTree = toInspectTree(parsedNodes[0])
    return textResult(note + singleTree)
  }
  if (parsedNodes.length === 0) {
    return textResult(
      'No nodes could be fetched from selection.',
    )
  }

  const tree = toInspectTreeMulti(parsedNodes)
  return textResult(note + tree)
```
(`textResult` is already imported from `./shared` after Task 1.)
- [ ] **Step 4: Run the test, verify it passes**
Run: `bun test packages/server/test/tools/read.test.ts -t "prepends a note listing failed ids"`
Expected: PASS. Also rerun the full read suite — the `uses multi-selection when multiple nodes selected` test (2 nodes, both resolve) must stay green with NO note.
- [ ] **Step 5: Typecheck + full suite + commit**
Run: `cd packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: typecheck clean, 0 fail.
```bash
git add packages/server/src/tools/read.ts packages/server/test/tools/read.test.ts && git commit -m "feat(server): note failed node fetches in multi-selection inspect"
```

---

### WS-5 · Task 7: typed componentProperty schema + drop the `as` cast (item 15)

Express the real `componentPropertySchema` contract (BOOLEAN→boolean default; TEXT/INSTANCE_SWAP→string default; INSTANCE_SWAP `.min(1)`) in `create-schemas.ts`, then drop the `componentProperties as { … }[] | undefined` cast in `index.ts`. Only touch the `componentProperties` block in index.ts — the `connect` block is owned by WS-1 (contract F).

**Files:**
- Modify: `packages/shared/src/create-schemas.ts` (lines 315-326, `componentPropertySchema`)
- Modify: `packages/server/src/index.ts` (lines 157-177, the `create_component` `server.tool` block)
- Modify test: `packages/server/test/create-schemas.test.ts`

- [ ] **Step 1: Write the failing test**
Add to `packages/server/test/create-schemas.test.ts` (uses the same `createComponentParamsSchema` import already present there):
```ts
  it('rejects INSTANCE_SWAP with an empty-string default', () => {
    const r = createComponentParamsSchema.safeParse({
      nodeId: '1:1',
      componentProperties: [
        { name: 'Icon', type: 'INSTANCE_SWAP', default: '' },
      ],
    })
    expect(r.success).toBe(false)
  })

  it('rejects BOOLEAN with a non-boolean default', () => {
    const r = createComponentParamsSchema.safeParse({
      nodeId: '1:1',
      componentProperties: [
        { name: 'Show', type: 'BOOLEAN', default: 'yes' },
      ],
    })
    expect(r.success).toBe(false)
  })

  it('accepts a valid BOOLEAN/TEXT/INSTANCE_SWAP property set', () => {
    const r = createComponentParamsSchema.safeParse({
      nodeId: '1:1',
      componentProperties: [
        { name: 'Show', type: 'BOOLEAN', default: true },
        { name: 'Label', type: 'TEXT', default: 'Hi' },
        { name: 'Icon', type: 'INSTANCE_SWAP', default: 'comp-key' },
        { name: 'Body', type: 'SLOT' },
      ],
    })
    expect(r.success).toBe(true)
  })
```
Confirm the import line at the top of `create-schemas.test.ts` includes `createComponentParamsSchema` (add it to the existing destructured import from `@figma-agent-bridge/shared` if absent).
- [ ] **Step 2: Run the test, verify it fails**
Run: `bun test packages/server/test/create-schemas.test.ts -t "INSTANCE_SWAP with an empty-string default"`
Expected: FAIL — current `componentPropertySchema` uses `default: z.union([z.string(), z.boolean()]).optional()` with no per-type discrimination, so `''` and `'yes'` both pass; `r.success` is `true` where `false` is expected.
- [ ] **Step 3: Implement**

Replace `componentPropertySchema` (lines 315-326) with a discriminated union on `type`:
```ts
const componentPropertySchema = z.discriminatedUnion('type', [
  z.object({
    name: z.string().describe('Property name.'),
    type: z.literal('BOOLEAN'),
    default: z
      .boolean()
      .describe('Default boolean value for a BOOLEAN property.'),
  }),
  z.object({
    name: z.string().describe('Property name.'),
    type: z.literal('TEXT'),
    default: z
      .string()
      .describe('Default text value for a TEXT property.'),
  }),
  z.object({
    name: z.string().describe('Property name.'),
    type: z.literal('INSTANCE_SWAP'),
    default: z
      .string()
      .min(1)
      .describe(
        'Default component key for INSTANCE_SWAP (must not be empty).',
      ),
  }),
  z.object({
    name: z.string().describe('Property name.'),
    type: z.literal('SLOT'),
  }),
])
```
In `index.ts`, replace the `create_component` block (lines 157-177) dropping the cast (the schema now produces the correct discriminated type, so pass `params.componentProperties` directly):
```ts
server.tool(
  'create_component',
  createComponentParamsSchema.shape,
  async params =>
    handleCreateComponent(
      {
        nodeId: params.nodeId,
        nodeIds: params.nodeIds,
        combineAsVariants: params.combineAsVariants,
        slots: params.slots,
        componentProperties: params.componentProperties,
      },
      client,
    ),
)
```
If TypeScript complains that the discriminated-union inferred element type is not assignable to `handleCreateComponent`'s `{ name; type: string; default: string | boolean }[]`, widen `handleCreateComponent`'s param type to accept the schema's inferred type by importing `z.infer` of `componentPropertySchema` — but the simplest fix that keeps the handler's loose shape is: the union members are each assignable to `{ name: string; type: string; default?: string | boolean }`, and `default` is required in the handler type. Update `create-component.ts`'s param type so `default` is optional (SLOT has none):
```ts
    componentProperties?: {
      name: string
      type: string
      default?: string | boolean
    }[]
```
- [ ] **Step 4: Run the test, verify it passes**
Run: `bun test packages/server/test/create-schemas.test.ts`
Expected: PASS — invalid INSTANCE_SWAP/BOOLEAN rejected, valid set accepted; existing create-schema tests stay green.
- [ ] **Step 5: Typecheck + full suite + commit**
Run: `cd packages/shared && bun run typecheck && cd /Users/lei/wip/figma-bridge/packages/server && bun run typecheck && cd /Users/lei/wip/figma-bridge && bun --filter '@figma-agent-bridge/*' test`
Expected: both typechecks clean, 0 fail.
```bash
git add packages/shared/src/create-schemas.ts packages/server/src/index.ts packages/server/src/tools/create-component.ts packages/server/test/create-schemas.test.ts && git commit -m "feat(shared): type componentProperty schema per-type and drop index.ts cast"
```

---

Notes for the assembler:
- Task 1 must land before Tasks 2-7 (all later tasks import from `./shared`).
- Task 7 touches `index.ts` only in the `create_component` block (lines 157-177); the `connect` block (lines 65-70) is left to WS-1 per contract F — no line overlap.
- `export.ts` keeps its inferred return type (it can return `image` content), so it imports only `requireConnected` from `./shared`, not `ToolResult`.
- `handleConnect` in `session.ts` has no `requireConnected` guard (it performs the join itself); only its local `ToolResult` decl and string returns migrate to `textResult`.
- Verify the `createComponentParamsSchema` and (for Task 1) `create-schemas.test.ts` import lines before editing — `create-schemas.test.ts` already imports `createNodeParamsSchema`/`createTreeParamsSchema`; add `createComponentParamsSchema` to that destructure if not already present.
