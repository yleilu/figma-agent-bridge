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

> **Status:** implemented (shipped on `dev`). A **standalone, buildable** feature that landed **before** the Claude
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

- **App semver, per [[figma-bridge/docs/principles|B2]]** — each side reports its **app version**
  (`APP_VERSION`, the root `package.json` semver, frozen into the build). A breaking change bumps
  the **minor**; a patch is non-breaking. There is **no** separate protocol-version constant.
- **Plugin reports it on register** — add `version: string` to `registerMessageSchema`
  (`packages/shared/src/ws-schemas.ts`, today `{ type, channel, fileName }`). The plugin sends its
  `APP_VERSION` on join/register.
- **Server compares on connect** — the `connect` handler reads the reported version and compares
  it to its own `APP_VERSION` on **major + minor only** (patch ignored); the outcome is also
  surfaced in `status`.
- **Mismatch → actionable error** — naming the stale side: *"Agent Bridge plugin vX is incompatible
  with server vY — update the {plugin | server}."* Subsequent tool calls short-circuit with the
  same message until resolved.
- **Model:** **major.minor** match of the app semver (B2). A **patch** difference does **not** trip
  it; a **minor or major** difference — i.e. a breaking change — does. The two versions differ only
  when the sides are built from different releases (each build freezes its version), so a same-build
  plugin+server always match.

## Wire contract & layer alignment (B1)

- `registerMessageSchema` gains `version: string` (the sender's `APP_VERSION` semver). The **relay
  stays semantics-free** — it only routes/stores the value and gains **no** version logic (B1). The
  **server owns** the comparison (**major.minor**, per B2).
- The comparison is **one-way** (the server is the reference), surfaced on `connect` + `status`.
- Tool names/commands are unaffected; this rides the existing register/connect path.
- **Per-file channels extend this same schema.** The
  [[figma-bridge/docs/specs/overview|per-file channel]] change adds **`fileKey`** to
  `registerMessageSchema` and a **`targetFileKey`** to the command envelope (the B3 identity
  guard) — a **breaking wire change**, so it **bumps the minor** (B2) and trips *this* handshake
  on a mixed-version plugin/server. The relay stays semantics-free — it stores `fileKey` in the
  availability registry but gains no logic (B1); the server owns targeting and the compare.

## Testing

- **Unit** — same `major.minor` → proceed; a **patch-only** difference → proceed (not a break); a
  **minor/major** difference → the actionable error, surfaced on `connect` and `status`.
- **Relay schema** — assert `version` is present/validated on the `register` message.
- **Mock fidelity** — the mock plugin (`packages/server/test/mocks/mock-plugin.ts`) reports the same
  `APP_VERSION` by default; assert it so server / plugin / mock drift is caught (mock-fidelity rule).

## Relationship to the plugin milestone

This handshake ships **first** and is **self-contained**. The Claude Code plugin milestone
([[figma-bridge/docs/specs/claude-plugin|claude-plugin.md]]) is built **after** and stays
**decoupled** — it does not spec or depend on this mechanism. Its only version touch-point is a
later, small **diagnosis / response skill**: when this handshake reports a mismatch, that skill
guides the user through the fix (e.g. *reinstall the Figma plugin*, or diagnose a stale server).
The version compare (major.minor), the wire change, and the actionable error all live **here**; the
plugin only *responds*.

## Out of scope

- Auto-updating either side — the handshake only **detects** and **instructs**.
- The plugin-distribution UX (compiled-in version, "reinstall the Figma plugin") — the plugin
  milestone's specialization.
