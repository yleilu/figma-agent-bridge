---
name: figma-connection
description: >-
  Use when the Figma MCP raises an addressing or connection question — which file to
  target, driving multiple files at once, or a WRONG_FILE / DISCONNECTED / INCOMPATIBLE
  response — or when the version handshake says the plugin and server are incompatible, or
  tools time out / say disconnected. Carries the fileKey addressing doctrine and guides the
  fix: refresh the Figma plugin (re-run figma-setup), or update a stale server, and how to
  confirm it.
version: 0.2.0
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
  **stale** side; see below. Version order is not build recency: after a version
  renumber the lower number can be the newer build, so diagnose by which side was
  actually rebuilt, never by comparing the two numbers).

_(`connect` / `status` and the machine-global feedback and GitHub-auth tools are the
exceptions — they take no per-call `fileKey`.)_

---

## What a mismatch means

A version mismatch is a **breaking major.minor version skew** — the app-semver
handshake (principle B2, see `version-handshake.md`) compares the plugin's reported
version to the server's on connect. Patch differences are ignored; a minor or major
difference trips the error:

> _"Agent Bridge plugin vX is incompatible with server vY — update the {plugin | server}."_

The two sides only differ when they were built from different releases. Same-build
plugin + server always match.

---

## Usual cause: stale Figma plugin

The Figma plugin is **imported by hand** (Plugins → Development → Import plugin from
manifest), and Figma re-reads whatever files sit at the path it imported. Nothing refreshes
those files on its own, so once the server side moves forward the Figma side stays on the
old build until someone updates it.

**Fix — refresh the files at the path Figma already imported.** Which files depends on how
the user installed:

- **Claude Code plugin (the usual case).** In this order: refresh the marketplace, update
  the plugin, reload or restart Claude Code, then **run the `figma-setup` skill** — it
  replaces the payload's contents at the path it reports (the copy mechanics are
  `figma-setup` Part 1's). Run `figma-setup` before the plugin is updated and the host
  reloaded and it just re-copies the old version.
- **From a clone.** Pull, rebuild the Figma plugin (`bun run build:plugin`), and reopen it —
  the import points into `packages/figma-plugin/`, which the build rewrites in place.
- **Hand-imported release archive.** Download `figma-plugin.zip` from the GitHub release at
  the version the server reports, and unzip it **over the same directory** that was
  imported from.

Then **close and reopen the plugin in Figma** — it re-reads its files on each run and
auto-connects on launch.

**No re-import** in any of those cases: the path Figma stored is unchanged. Re-importing is
for a **broken** import only — the manifest or its sibling `dist/` was moved or deleted, so
the stored path resolves to nothing. Repair that by importing again from the new location
(**Plugins → Development → Import plugin from manifest…**, selecting the `manifest.json`
`figma-setup` reported, or the one in the clone / unzipped archive), never by reinstalling
the server side.

---

## Less common: stale server

If the **server** is the stale side — it was not rebuilt/reinstalled when the plugin
was (do not trust the numeric comparison alone; the error's "older side" wording
assumes version order equals build recency, which a renumber breaks) — then the
server side has to move forward. There is no binary to refresh — the
server is a JavaScript bundle run with `bun`, shipped inside whatever installed it:

- **Claude Code plugin:** the server bundle and the plugin metadata are the same package,
  so a stale server means a stale _plugin_. Refresh the marketplace, update the plugin,
  then reload or restart Claude Code (`/mcp restart` or a new session). Finish by re-running
  `figma-setup`, so both sides land on the same version.
- **Standalone MCP entry** (`bunx figma-agent-bridge@<version>`): the entry pins an exact
  version — bump it to the version the Figma plugin reports, then restart the MCP client.
- **Local dev:** the server runs from the clone's source, so there is nothing to rebuild —
  pull, then restart the MCP server (`/mcp restart` or start a new Claude Code session).

---

## Connection problems (timeout / disconnected)

If tools time out or return a disconnected error without a version mismatch message:

1. Confirm the Figma plugin is open and shows **Connected** (not Connecting or error).
2. If it shows an error, close and reopen the plugin from the Figma canvas — it
   auto-connects to the relay.
3. If the relay is not running, the MCP server auto-starts it on first tool call; a
   new session clears stale state.

---

## Presence status block

Every turn starts with an injected `figma_bridge:` YAML block (see
`docs/specs/plugin-presence.md` in the repo, not shipped) — passive awareness, not something you
fetch. Read it for what
it tells you about **reachability**; its `pending_edits` / `pending_edits_state` fields are
design-loop tool usage and belong to `figma-design`.

- **`online[]`** — the files you can address right now, each with its `fileKey`. `current_page`
  and `selected` say where the user is in that file at this moment.
- **`recently_offline[]`** — a file you were just using went offline since last turn; expect
  `DISCONNECTED` if you address it now — re-plan around it or ask the user to reopen it rather
  than retrying blind.
- **`relay: unreachable` or an empty `online: []`** — no Figma files are connected; there's
  nothing to address until one comes online.

---

## Confirm the fix

- `status()` — returns per-file `version` in `joined[]`; the entry for your file
  shows the plugin version. Versions should match the server.
- Run any file tool with the target `fileKey` — if it returns a result (no `INCOMPATIBLE`
  or `DISCONNECTED`), the handshake passed.
