---
title: "Team-Library Registry"
created: 2026-07-08T20:00:00+08:00
tags:
  - figma-bridge
  - specs
  - libraries
  - registry
  - components
type: spec
related:
  - "[[figma-bridge/docs/specs/component-index]]"
  - "[[figma-bridge/docs/specs/tool-surface]]"
  - "[[figma-bridge/docs/principles]]"
---

# Team-Library Registry

> Governed by [[figma-bridge/docs/principles|the principles]] (**T6/T7** honest capability, **T10**
> bounded reads). Layers on the [[figma-bridge/docs/specs/component-index|Component Index]] engine and
> reuses its record shape, cache, and `search_components` tool. The user-facing **register flow** is
> orchestrated by a Claude Code plugin skill; this spec defines the underlying design.

## Overview

A file can use components from **published team libraries**. Figma's Plugin API cannot enumerate a
team library's components from a consuming file (`teamLibrary` exposes variables only), and a remote
instance carries no library identity — so the set of a file's libraries is maintained by this system.
A registered library's catalog is indexed by the same engine as local components, so its components are
searchable and usable alongside them.

## Scope

**Covers:** registering / listing / removing **published team libraries** per file, file-scoped search
over enabled libraries, placing components by key, and a consumer map.

**Does not cover:**
- **Community libraries.** A community component is unusable by key until it is **published** as a team
  library. Adopting a community kit means the user duplicates and publishes it first; it is then a team
  library and this design applies.
- **REST full-catalog fetch** (would require an explicit credential — the catalog is read by opening the
  library's home file instead).

## Taxonomy addition

Beyond the local components and instances of [[figma-bridge/docs/specs/component-index|the index]], a
**team-library component** is a remote component from a published team library. It is detected in a
consuming file only via **instances**: an instance whose resolved main is remote reveals a used team
library component (its published `key`), but no library identity.

## Registering a library

A library is indexed by opening its **published home file** — which opens with file **access** alone
(no paid plan; e.g. *right-click an instance → Go to main component*, or from the file browser) — and
scanning it, keeping only **published** components (`getPublishStatusAsync`). If no component is
publishable, registration is refused with guidance to publish the file as a team library first.

- A registered library is identified by its **`fileKey`** + name + the set of its published component
  keys (globally unique — used for consumption matching).
- Registration **indexes the catalog once** (server-side, shared) and **enables** it for the current
  file. Enabling an already-indexed library in another file requires no re-harvest.

## Storage

- A file's **enabled libraries** → `figma.root.setPluginData` — file-scoped, rides with the file,
  survives sessions.
- **Harvested library indexes** → server-side, keyed by `fileKey`, reused across files.

## Search scope

`search_components` for a file returns that file's local components **plus the libraries enabled for
that file** — never the global set — so libraries of different styles are never pickable together. Index
entries from a library carry `source: 'team-library'`.

## Using a component

A component is placed via `importComponentByKeyAsync(key)`; a `COMPONENT_SET` via
`importComponentSetByKeyAsync`. Import requires only that the component is **published** and the user
has **access** — not that the library is enabled in the target file — and runs in a file **other than**
the library's home file. A "no published component with that key" result means the component is not
published.

## Consumer map

Scanning a file's `INSTANCE` nodes resolves the **used published keys** (with counts); matching them
against the file's enabled libraries yields both directions — `{ library → consuming files }` and
`{ file → libraries }`. A used key matching no registered library surfaces a prompt to register it.
Unresolvable or soft-deleted mains go to an explicit **unresolved** set rather than being dropped.

## Register flow (user side)

The user reasons in one question — *"which libraries can I use in this file?"* — with two levels:
**registered** (indexed, cached globally) and **enabled for this file** (turned on, stored in the file).
Operations:

- **list** — libraries enabled here, available to enable (indexed elsewhere), and used-but-unregistered.
- **register** — the user opens the library's home file; the agent harvests its published components and
  indexes them, then enables the library for the working file.
- **enable** — turn an already-indexed library on for this file (no re-open, no re-harvest).
- **use** — `search_components` → place by key.
- **remove / refresh** — disable a library for this file, or re-open its home file to re-harvest.

The agent orients itself by `figma.root.name` (to confirm which file it is indexing) and turns the
consumer map into a nudge: a file that already uses an unregistered library prompts registration. The
sequencing of these prompts and the guidance to open/publish files is owned by the **plugin skill**;
the tools below are its primitives.

## Tool surface

All tools take `fileKey` and obey `overview.md`'s `{error, code}` envelope. `register_library` /
`unregister_library` / `list_libraries` are **first-party** tools (no `figma.*` library-enumeration
exists); like `record_feedback` they are classified as non-facade in `tool-surface.md`, outside the
`figma.*` tool-count invariant. All error codes below are declared in
[[figma-bridge/docs/specs/overview|overview.md]]'s single authoritative `ErrorCode` enum (including
`LIBRARY_UNPUBLISHED` and `WRONG_FILE`).

| Tool | Contract | Error codes |
|---|---|---|
| `register_library` | `{fileKey, name}` (run in the library's home file) → harvest published, register, enable for `fileKey` | `INVALID_PARAM`, `LIBRARY_UNPUBLISHED`, `WRONG_FILE` |
| `unregister_library` | `{fileKey, libraryFileKey}` → disable / remove | `INVALID_PARAM`, `NODE_NOT_FOUND` |
| `list_libraries` | `{fileKey}` → `{ enabled[], available[], usedButUnregistered[] }` with per-library status | `INVALID_PARAM` |

`search_components` (defined in [[figma-bridge/docs/specs/component-index|Component Index]]) gains the
`source: 'team-library'` results and the enabled-library scope described above.

## Design constraints

Figma Plugin API facts that shape this design:

- **No API enumerates a team library's components** from a consuming file (`teamLibrary` is
  variables-only) — a library's catalog is read by opening its home file.
- **Only published components import by key across files** — the registry is team-libraries-only and the
  harvest filters by publish status.
- **Import requires published + access, not the library enabled in the target file.**
- **A team library's home file opens with file access alone** (no paid plan); publishing a library
  requires a paid plan.
- **No REST credential is reachable from the `figma` object** — a REST path would require an explicit
  token, so the plugin-side (open-the-home-file) route is the design.
