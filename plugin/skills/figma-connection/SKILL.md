---
name: figma-connection
description: >-
  Use when the Figma MCP raises an addressing or connection question — which file to
  target, driving multiple files at once, or a WRONG_FILE / DISCONNECTED / INCOMPATIBLE
  response — or when the version handshake says the plugin and server are incompatible, or
  tools time out / say disconnected. Carries the fileKey addressing doctrine and guides the
  fix: reinstall/update the Figma plugin, or diagnose a stale server, and how to confirm it.
version: 0.1.0
---

# figma-connection skill

Diagnose and fix a version mismatch or lost connection between the Figma plugin and
the MCP server.

---

## Addressing a file

**Every file tool needs a `fileKey`.** After `connect`/`status`, read the target file's
`fileKey` from `status().joined[]` (or `connect().available[]`) and pass it on **every**
file-addressed call — the server never guesses which file (B3).

- **Multiple files:** one agent can drive several at once; address each by its own `fileKey`.
- **`WRONG_FILE`** (unknown/unavailable fileKey) → the server lists the available files and
  asks you to choose — **ASK, never retry with a guessed fileKey.**
- **`DISCONNECTED`** = no plugin for that file (open/reopen it).
- **`INCOMPATIBLE`** = plugin↔server version skew (reconnecting won't help — update the
  older side; see below).

*(`connect` / `status` / `record_feedback` are the exceptions — they take no per-call
`fileKey`.)*

---

## What a mismatch means

A version mismatch is a **breaking major.minor version skew** — the app-semver
handshake (principle B2, see `version-handshake.md`) compares the plugin's reported
version to the server's on connect. Patch differences are ignored; a minor or major
difference trips the error:

> *"Agent Bridge plugin vX is incompatible with server vY — update the {plugin | server}."*

The two sides only differ when they were built from different releases. Same-build
plugin + server always match.

---

## Usual cause: stale Figma plugin

The Figma plugin is **manually imported** (Plugins → Development → Import plugin from
manifest), so it does **not** auto-update when the server binary is refreshed.

**Fix — reinstall the Figma plugin:**

1. In Figma desktop, go to **Plugins → Development → Manage plugins in development**.
2. Remove the current `figma-agent-bridge` entry.
3. Re-import the manifest: **Plugins → Development → Import plugin from manifest** →
   select `packages/figma-plugin/manifest.json` from the repo (or the installed plugin
   directory — see the README Install § 2).
4. Open the plugin from the Figma canvas. It auto-connects on launch.

---

## Less common: stale server

If the plugin version is **newer** than the server (the error names the server as stale),
the binary needs to be updated or rebuilt:

- **Installed plugin:** wait for the next release — the `SessionStart` bootstrap
  re-downloads the binary when its `--version` differs from `$EXPECTED_VERSION`.
- **Local dev:** rebuild — `bun run build` in `packages/server`, then restart the MCP
  server (`/mcp restart` or start a new Claude Code session).

---

## Connection problems (timeout / disconnected)

If tools time out or return a disconnected error without a version mismatch message:

1. Confirm the Figma plugin is open and shows **Connected** (not Connecting or error).
2. If it shows an error, close and reopen the plugin from the Figma canvas — it
   auto-connects to the relay.
3. If the relay is not running, the MCP server auto-starts it on first tool call; a
   new session clears stale state.

---

## Confirm the fix

- `status()` — returns per-file `protocolVersion` in `joined[]`; the entry for your file
  shows the plugin version. Versions should match the server.
- Run any file tool with the target `fileKey` — if it returns a result (no `INCOMPATIBLE`
  or `DISCONNECTED`), the handshake passed.
