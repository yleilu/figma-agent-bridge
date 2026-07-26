---
title: figma-agent-bridge Overview — Implementation Map & Tool Contract
created: 2026-06-22T17:00:00+08:00
tags:
  - spec
  - figma-bridge
  - overview
  - tool-contract
type: spec
related:
  - "[[figma-bridge/docs/principles]]"
  - "[[figma-bridge/docs/architecture]]"
  - "[[figma-bridge/docs/specs/tool-surface]]"
  - "[[figma-bridge/docs/specs/plugin-presence]]"
  - "[[figma-bridge/docs/specs/connection-liveness]]"
  - "[[figma-bridge/docs/specs/change-feed]]"
  - "[[figma-bridge/docs/specs/expression-formats]]"
---

# figma-agent-bridge — Overview

> Governed by [[figma-bridge/docs/principles|the principles]]. This spec is the
> implementation-level map: what the bridge **is** as an artifact, and the one
> cross-cutting **tool contract** the principles footer ("Where mechanism lives")
> sends down to the specs. It implements B1 (uniform contract) and the result-shape
> half of T1/T4. Per-tool truth lives in [[figma-bridge/docs/specs/tool-surface|the tool-surface spec]];
> value grammar in [[figma-bridge/docs/specs/expression-formats|expression-formats]].

## What it is

A bun monorepo (`figma-agent-bridge`, npm workspaces over `packages/*`) realizing the
three principle layers. Layer detail and data flow live in
[[figma-bridge/docs/architecture|architecture.md]]; this is the at-a-glance map of the
workspaces.

| Package | npm name | Layer | Role |
|---|---|---|---|
| `shared` | `@figma-agent-bridge/shared` | bridge/tool | One vocabulary: `NodeSpec`/`ParsedNode` schemas, types, constants, zod schemas. Depended on by relay + server. |
| `relay` | `@figma-agent-bridge/relay` | bridge | WebSocket relay. Pairs the MCP server with each Figma file's plugin over that file's own channel (one file, one channel — B3) and keeps the availability registry (`fileKey → {channel, fileName, connectedAt, epoch}`); default port **18080**. |
| `figma-plugin` | `@figma-agent-bridge/figma-plugin` | bridge | The Figma plugin (React UI + sandbox `code`). Executes commands inside Figma; the only layer that touches `figma.*`. Built with Vite (two configs: `ui`, `code`). |
| `server` | `@figma-agent-bridge/server` | tool | The MCP server — the agent-facing tool surface. Parses expressions, owns the typed error envelope, sends commands over the relay. |
| `cli` | `@figma-agent-bridge/cli` | — | CLI entry (scaffold). |
| `branding` | `@figma-agent-bridge/branding` | — | Source of truth for the brand mark; source-only (no build), consumed as TypeScript. |
| `worker` | `@figma-agent-bridge/worker` | — | CloudFlare Worker behind the feedback send-flow's anonymous filing path ([[figma-bridge/docs/specs/feedback-system\|feedback-system.md]] is authoritative). |

Server consumes `shared`; relay consumes `shared`; server dev-depends on `relay`.

## Build / run / test

All scripts run from the repo root (`bun run <script>`) unless noted.

- **`dev`** — watch-build the plugin (UI + code) and run the relay concurrently. The
  working loop for plugin + transport changes.
- **`relay`** / **`server`** — run a single workspace's `start` (`bun run src/index.ts`).
- **`test`** — `bun test` across every workspace. **`typecheck`** — `tsc --noEmit` across
  every workspace.
- **`format`** / **`format:check`** — Prettier. **`lint`** / **`lint:fix`** — ESLint.
- **`packages/figma-plugin` `build`** — production plugin bundle (`vite build` ×2 configs).

**Starting the MCP stack:** `scripts/start-mcp.sh`. It starts the relay if nothing is
listening on `$PORT` (default **18080**), waits up to ~5s for it, then `exec`s the server
(passing through args). The server auto-discovers the relay port via a ping/pong probe, so
the port is a default, not a hard coupling.

## Connection lifecycle

The plugin (`figma-plugin`) is the only layer that opens the WebSocket to the relay. Every
open file runs its own plugin instance, and **each file gets its own channel** — so the server
drives one specific file with no ambiguity (B3). The lifecycle contract:

- **File identity (B3).** Each file is identified by its **`fileKey`** (`figma.fileKey`), a
  stable per-file id. `figma.fileKey` requires **`"enablePrivatePluginApi": true`** in the
  manifest and resolves for dev-loaded (manifest-imported) plugins — the project's
  distribution ([[figma-bridge/docs/specs/dev-ops|dev-ops.md]] §3.8); it is
  expected to be `undefined` for a never-saved file (untested edge — see the reference §5). `fileName` (`figma.root.name`) is the human-readable
  label and the **fallback** identity when `fileKey` is absent. *(There is no Figma API for
  "which file is frontmost/active" — verified; see
  [[figma-bridge/docs/reference/figma-file-identity-and-activation]].)*
- **One file, one channel.** The plugin binds its channel to its `fileKey`, so a reload
  deterministically rejoins the *same* file's channel, and registers `{ fileKey, channel,
  fileName }`. This replaces the prior single `channel-id` in `figma.clientStorage` —
  `clientStorage` is per-user and shared across **all** files, so the old design had every open
  file's plugin rejoin the **same** channel and a command broadcast to all of them (the
  multi-file collision). When `fileKey` is unavailable (never-saved file), the plugin falls
  back to a per-session channel registered under `fileName`; reload determinism there is
  best-effort.
- **Availability, not activity (the availability registry).** The relay maintains
  `{ fileKey → { channel, fileName, connectedAt, epoch } }` — the files with a **live plugin**
  (reachable/writable). **Each entry is bound to the registering plugin's socket.** A plugin's
  `register` on a channel it has joined creates the entry, or — from a new socket — rebinds the
  existing one and refreshes its fields in place; every binding mints a fresh `connectedAt`, so
  that value identifies one plugin *connection*, not one channel. The entry then lives exactly as
  long as that socket: an explicit `leave` frame (a clean plugin close), the socket's `close`, or
  a missed heartbeat (`DEFAULT_HEARTBEAT_INTERVAL = 10_000` ms → dead within ~2 ticks) removes
  it, so **closing a file drops it from the set** — even while other members (the MCP server)
  still hold the channel open. Channel membership is a different fact from availability: a
  channel with members but no registered plugin has **no** entry, because the registry answers
  *which files have a live plugin*, not *which channels exist*. The interval and the companion
  **command-liveness watchdog** (which fast-fails a command sent to a plugin that died mid-use)
  are owned by [[figma-bridge/docs/specs/connection-liveness|connection-liveness.md]]. This is
  availability — a transport fact — not activity: Figma exposes no "frontmost/active file" signal,
  so the agent never guesses which file is meant. `fileName` is populated **reliably at register
  time**: the prior `fileName: null` was a timing bug (the register frame was sent before the
  main-thread file name arrived); the fix carries `fileKey`+`fileName` on register (re-sending if
  the name arrives late). The entry also carries the plugin `version` (the **B2** handshake) and
  is **enriched** with the user's `currentPage` and `selected` count — presence fields the plugin
  self-reports (initial on `register`, refreshed via a dedicated `presence` frame that leaves the
  connection-level fields untouched) for passive turn-start awareness, owned by
  [[figma-bridge/docs/specs/plugin-presence|plugin-presence.md]]. It further **publishes** the
  plugin's connection **`epoch`**, refreshed on every `register` (including a re-register onto an
  entry that already exists), so a consumer reading `/channels` can tell one plugin connection
  from the next without receiving a frame. The nonce itself — who mints it, and where else it
  rides — is owned by [[figma-bridge/docs/specs/request-envelope|request-envelope.md]]; what a
  change in it *means* by [[figma-bridge/docs/specs/change-feed|change-feed.md]].
- **Addressing model (B3) — this spec is the single source of truth.** Every tool takes an
  explicit **per-call `fileKey`** parameter naming the file it operates on (identity per B3, the
  canonical param name everywhere); `connect` establishes the pairing/availability. The `fileKey`
  is not server-stamped from the connection — the agent addresses files per-call. On the wire it
  rides in the command's `meta` block — the request-metadata mechanism is owned by
  [[figma-bridge/docs/specs/request-envelope|request-envelope.md]]. Other specs link
  here rather than restating it.

  **The addressable identity is the `synthKey`: `fileKey ?? channel`** — a registry entry's
  `fileKey` when the file has one, and its `channel` when it does not (a never-saved file). This
  is the value the agent passes as the `fileKey` param, and the value everything downstream keys a
  file by: the file gate matches against it, the availability listing prints it, the presence
  block renders it, and a plugin-initiated frame stamps it. One name, one rule — a tool never sees
  a `null` identity, and an unsaved file is addressable on the same terms as a saved one.

  An unsaved file's channel — and therefore its synthKey — is **per plugin session**: stable
  across that session's reconnects, but a plugin *reload* mints a new one. So an unsaved file
  reappears at a **new address** after a reload, never as the same file rejoining, and anything
  keyed by the old synthKey is orphaned. A saved file's synthKey is its `fileKey` and is stable
  indefinitely.
- **Targeting + guard (B3).** The agent names a target file by `fileKey`; the server resolves
  it against the availability registry and drives only that file's channel. An **unavailable**
  target (file closed / never matched) **fails and asks the agent to choose** — never a silent
  fallback to another available file, not even the only one open. Defense-in-depth: each command
  carries its `meta.fileKey`, and the plugin **refuses to execute if `figma.fileKey` doesn't
  match** — so a stale registry entry can never land a write in the wrong file. The command
  envelope that carries `meta.fileKey` is defined by
  [[figma-bridge/docs/specs/request-envelope|request-envelope.md]].
- **`close_plugin` (internal lifecycle command, not a tool).** A relay command that calls
  `figma.closePlugin()` for a deterministic teardown, used by the dev `rebuild → close →
  reopen` reload loop so new plugin code is picked up. It is **deliberately not** an MCP tool:
  unlike `connect`/`status` (which the agent uses to pair and read connection state), closing
  the plugin is a dev-workflow teardown, not a `figma.*` capability the agent composes during
  design work — so the tool surface stays unchanged
  ([[figma-bridge/docs/specs/tool-surface|tool-surface.md]] is authoritative for its count).

## Tool contract (cross-cutting result / error shape)

The principles demote the *mechanism* of B1's "uniform contract" to the specs. This is it —
the shape **every** tool obeys, so the agent learns one envelope, not one per tool. It is normative for
all tools; [[figma-bridge/docs/specs/tool-surface|tool-surface.md]] is authoritative for what
each individual tool returns within these rules, and
[[figma-bridge/docs/specs/expression-formats|expression-formats.md]] for the value grammar
inside payloads.

### Transport envelope

Every call returns the MCP `ToolResult`:
`{ content: ({ type:'text'; text:string } | { type:'image'; data:string; mimeType:string })[] }`.

### Success payloads — plain serializable objects

- **Writes** emit `JSON.stringify(result, null, 2)` of a plain object (`{ id, name, type, … }`)
  or array — **never** a Figma node reference. Node-writes return at minimum `{ id, name, type }`
  plus operation-salient fields, with an optional `warning?: string` as the canonical channel
  for non-fatal notes (e.g. `createSlot` unavailable, auto-layout no-op).
- **Reads** split by audience: machine readers (`get_*`) emit JSON `ParsedNode`/arrays; human
  readers (`inspect`, `list_pages`) emit YAML.
- **`export`** returns an `image` block (PNG/JPG/PDF) or a `text` block (SVG).

### Error envelope — server-owned, typed

Errors are uniform: `{ error: string, code: ErrorCode }`, emitted as one JSON `text` block.

`ErrorCode = 'NODE_NOT_FOUND' | 'INVALID_PARAM' | 'FONT_LOAD_FAILED' | 'DISCONNECTED' | 'TIMEOUT' | 'UNSUPPORTED_NODE_TYPE' | 'API_UNAVAILABLE' | 'WRONG_EDITOR' | 'LIBRARY_UNPUBLISHED' | 'WRONG_FILE' | 'INCOMPATIBLE'`.

`INCOMPATIBLE` is the plugin↔server **version skew** code (B2): distinct from `DISCONNECTED` (you *are* connected, just to an incompatible build — retrying `connect` won't help). Surfaced when the major.minor compare fails; see [[figma-bridge/docs/specs/version-handshake|version-handshake.md]].

The **server** owns the mapping — connection state plus known plugin error strings → a code —
and adds the `code`. The plugin is unchanged this phase: it keeps returning `{ error: string }`
and the server enriches it (fork F-B). `DISCONNECTED` replaces the legacy free-text
"Not connected" string; `API_UNAVAILABLE` is the feature-detect degrade path (T7);
`WRONG_EDITOR` guards design-only APIs.

### Partial success — `{ results, errors[] }`

Only the multi-target paths can partially succeed: the generic `batch` tool plus the legitimate
array-envelope tools — `create_tree` (sibling-array form), `create_styles`, `create_variables`,
`update_styles`, `update_variables`, and `get_nodes`. Their payload carries `results` and
`errors[]` (`{ index, error, code }`). Every single-target tool either fully succeeds or returns
one error envelope — it never partially succeeds.
[[figma-bridge/docs/specs/tool-surface|tool-surface.md]] is the authoritative source for each
tool's exact return shape, so this set stays in sync there.

### Handler order

The connection/addressing gate now lives in the shared `withFile`/`requireFile` **wrapper** that
registers every file-addressed tool — it runs *before* the handler and emits `DISCONNECTED` (no
plugin), `WRONG_FILE` (the `fileKey` is not available — ASK, never guess, B3), or `INCOMPATIBLE`
(B2 version skew). The per-handler `requireConnected` check was removed. Each handler then runs a
fixed sequence (so failures surface consistently): input cross-validation → convert expressions
server-side → `sendCommand` → null-result guard → `result.error` guard → success. Cross-field validation lives in the **handler**, not the
zod schema. Tool names may differ from plugin command strings (e.g. tool `inspect` → command
`get_node`; the six setters → command `update_node` with field-scoped payloads). `export` and
large `create_tree` pass a larger `timeoutMs`. This whole section is a cross-cutting summary of
the contract every tool obeys; for any single tool's exact return shape and per-tool deviations,
[[figma-bridge/docs/specs/tool-surface|tool-surface.md]] is authoritative.
