---
title: Version / Protocol Handshake — Design Spec
created: 2026-07-07T22:00:00+08:00
tags:
  - figma-bridge
  - spec
  - protocol
  - handshake
  - connection
type: spec
related:
  - "[[figma-bridge/docs/principles]]"
  - "[[figma-bridge/docs/specs/overview]]"
  - "[[figma-bridge/docs/specs/claude-plugin]]"
---

# Version / Protocol Handshake

> **Status:** design spec. A **standalone, buildable** feature that lands **before** the Claude
> Code plugin milestone ([[figma-bridge/docs/specs/claude-plugin|claude-plugin.md]]) — that
> milestone assumes this is in place and only *specializes* the mismatch UX. This reinstates a
> **real** version check: a prior server+relay review removed the app-level Ping/Pong that carried
> `name`+`version` (it was never wired to a handshake); this wires one.

## Purpose

Detect a **plugin ↔ server version/protocol mismatch at connect time** and **fail fast** with an
actionable message naming which side to update — instead of letting drift fail silently.

**Why (real incidents).** On 2026-06-25 two silent failures cost a live session: (1) the MCP
server was running stale pre-merge code with **no signal** it was stale, and (2) a protocol-shape
mismatch — the plugin replies `{ id, result }` with no `command`, while a refactored server schema
required `command` — **silently dropped every command round-trip** (30s timeouts, zero
diagnostic). A handshake flags both immediately.

## Design

- **Shared `PROTOCOL_VERSION`** — a constant in `packages/shared`, bumped **only on breaking
  transport/protocol changes** (not every release). Both server and plugin reference it.
- **Plugin reports it on register** — add `version: string` to `registerMessageSchema`
  (`packages/shared/src/ws-schemas.ts`, today `{ type, channel, fileName }`). The plugin sends its
  `PROTOCOL_VERSION` on join/register.
- **Server compares on connect** — the `connect` handler reads the reported version and compares
  to its own `PROTOCOL_VERSION`; the outcome is also surfaced in `status`.
- **Mismatch → typed, actionable error** — return the standard envelope (`{ error, code }`) naming
  the stale side: *"Agent Bridge plugin vX is incompatible with server vY — update the {plugin |
  server}."* Subsequent tool calls short-circuit with the same message until resolved.
- **Model:** **exact match** of `PROTOCOL_VERSION`. Because it's bumped only on breaking changes, a
  patch/minor release does **not** trip it — only genuine incompatibility does.

## Wire contract & layer alignment (B1)

- `registerMessageSchema` gains `version: string`. The **relay stays semantics-free** — it only
  routes the envelope and gains **no** version logic (B1). The **server owns** the comparison.
- The comparison is **one-way** (the server is the reference), surfaced on `connect` + `status`.
- Tool names/commands are unaffected; this rides the existing register/connect path.

## Testing

- **Unit** — match → proceed; mismatch → the actionable error with the correct stale-side message,
  surfaced on `connect` and `status`.
- **Relay schema** — assert `version` is present/validated on the `register` message.
- **Mock fidelity** — the mock plugin (`packages/server/test/mocks/mock-plugin.ts`) MUST carry the
  same `PROTOCOL_VERSION`; assert it so server / plugin / mock drift is caught (mock-fidelity rule).

## Relationship to the plugin milestone

This handshake ships **first** and is **self-contained**. The Claude Code plugin milestone
([[figma-bridge/docs/specs/claude-plugin|claude-plugin.md]]) is built **after** and stays
**decoupled** — it does not spec or depend on this mechanism. Its only version touch-point is a
later, small **diagnosis / response skill**: when this handshake reports a mismatch, that skill
guides the user through the fix (e.g. *reinstall the Figma plugin*, or diagnose a stale server).
The `PROTOCOL_VERSION`, the wire change, and the compare all live **here**; the plugin only
*responds*.

## Out of scope

- Auto-updating either side — the handshake only **detects** and **instructs**.
- The plugin-distribution UX (compiled-in version, "reinstall the Figma plugin") — the plugin
  milestone's specialization.
