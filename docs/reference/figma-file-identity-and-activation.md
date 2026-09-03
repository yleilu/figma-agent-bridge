---
title: "Figma Runtime Gotchas — File Identity & Plugin Activation"
created: 2026-07-08T20:40:00+08:00
tags:
  - doc
  - figma-bridge
  - figma-runtime
  - file-identity
  - activation
type: doc
related:
  - "[[figma-bridge/docs/scratch/handovers/2026-07-08-component-library-multifile-handover]]"
  - "[[figma-bridge/docs/specs/overview]]"
  - "[[figma-bridge/docs/principles]]"
---

# Figma Runtime Gotchas — File Identity & Plugin Activation

> **Why this doc exists.** Live-verified runtime facts (2026-07-08) gathered while
> designing **per-file channels** (one-file-one-channel). These are hard Figma-runtime
> constraints on how we identify a file and detect which file is "active." They were
> established with a throwaway `__probe` command driven over the relay against a real
> running plugin — not read from docs alone. Plugin-runtime behaviour must be
> live-verified (headless mock can't catch it); this is that verification.

## TL;DR — the design-binding facts

| Question | Answer |
|---|---|
| Stable per-file id? | **`figma.fileKey`** — but only with `"enablePrivatePluginApi": true` in the manifest (see §2). |
| `figma.root.id`? | **`"0:0"`** — the same for every file. Useless as identity. |
| `figma.root.name` (file name)? | Available & reliable. The relay's `ChannelInfo.fileName: null` is a **timing bug**, not an availability problem. |
| Passive "window active/inactive" hook? | **No.** UI `focus`/`blur`/`visibilitychange` do **not** fire on a Figma focus change. |
| Any "which file is frontmost" signal? | **None exists.** Only per-file interaction events (`selectionchange` etc.). |

## 1. File identity

Probed on **"iOS and iPadOS 27 (Community)"** (a Community file the user was viewing).

| Candidate | Result | Verdict |
|---|---|---|
| `figma.fileKey` (no flag) | `undefined`; `'fileKey' in figma === false` | Absent for a normal plugin. |
| `figma.fileKey` (with `enablePrivatePluginApi`) | `"qCZ3T6oQxO87myTIx9seZ1"` (a real, stable key) | ✅ **Usable identity** — see §2 for the cost. |
| `figma.root.id` | `"0:0"` | ❌ Non-unique across files. Dead. |
| `figma.root.name` | `"iOS and iPadOS 27 (Community)"` (via `get_document_info`) | ⚠️ Available, but **mutable & non-unique**. Good display name / fallback, not a hard id. |
| `figma.currentUser` | **Threw:** `"currentuser" permission not specified in manifest.json` | Gated; confirms Figma's permission model gives actionable errors. Not a file id. |

**The `fileName: null` bug is confirmed as timing, not availability.** `get_document_info`
returns the real name every time; the relay registry shows `null` because the plugin's
`register` frame is sent before the `file-name` message from the main thread has been
processed (`useRelay.ts` reads `fileNameRef.current`, still `null`). Fixable independently.

## 2. `enablePrivatePluginApi` — the cost of `fileKey`

Figma docs (verbatim): *"The file key of the current file this plugin is running on.
**Only private plugins and Figma-owned resources** (such as the Jira and Asana widgets)
have access to this. To enable this behavior, you need to specify
`enablePrivatePluginApi` in your `manifest.json`."*

Verified empirically:

- Adding `"enablePrivatePluginApi": true` to `manifest.json` + a plugin relaunch →
  `figma.fileKey` returned a real key on a **dev-loaded** plugin. So a dev-loaded Agent
  Bridge **does** count as eligible.
- No blocking consent dialog was observed on the relaunch (the headless relaunch
  completed and the plugin auto-reconnected).

**Deployment caveat — `fileKey` viability depends on how the plugin is installed:**

| Deployment | `fileKey` with flag? |
|---|---|
| Dev-loaded (import manifest — today's install flow) | ✅ Verified working |
| Private organization plugin (Enterprise) | ✅ Per docs |
| **Published to the public Figma Community** | ❌ Flag is for private plugins; expect `fileKey` unavailable |

Agent Bridge's current distribution is **dev-loaded** (each user imports the manifest via
the Claude Code plugin), so `fileKey` **is** viable — provided we ship the flag. The
design must still carry a **fallback identity** (fileName) for any context where `fileKey`
is `undefined`.

## 3. Activation — "which file is the user looking at?"

- **UI iframe `focus`/`blur`/`visibilitychange`: DO NOT FIRE.** Across two full
  Finder↔Figma app-focus toggles, the activity log captured **only** the initial `mount`
  event — zero focus/blur/visibility events. `document.hasFocus()` is `false` even while
  Figma is foreground (the canvas holds focus, not the plugin iframe). ➜ **The
  "window active/inactive hook" idea is not viable.**
- **Sandbox core events (`figma.on`) DO fire.** A scripted, self-restoring page toggle
  produced two `currentpagechange` events. `selectionchange` / `documentchange` are the
  same class of core event and fire the same way.
- **But there is no frontmost-window signal.** These events say *"the user interacted with
  **this** file"* — not *"this file is the frontmost window."* No Figma API reports which
  open file/window is focused. So "active file" can only be **inferred** (most-recently-
  interacted) or **set explicitly** by the agent.

## 4. Implications for the per-file-channel design

1. **Identity:** adopt `figma.fileKey` as the per-file key, gated behind
   `enablePrivatePluginApi`, with **fileName** as the documented fallback for contexts
   where `fileKey` is `undefined`.
2. **Availability, not activation.** The design uses the relay **availability registry**
   (`{fileKey → {channel, fileName, connectedAt}}`, maintained by register/close/heartbeat)
   plus **explicit** `fileKey` targeting with a **hard no-guess failure** (B3: an unavailable
   target fails and asks — no default, not even the only open file). The passive focus hook is
   dropped, and the "last-interacted"/most-recently-active heuristic was **considered and NOT
   adopted** (availability was chosen over activity — a most-recently-active default is exactly
   the guess B3 forbids). Do not promise automatic frontmost detection (T7).
3. **`fileName` timing bug** must be fixed regardless (it is the fallback identity and the
   human-facing label in the registry).

## 5. Untested edges (follow-ups before the spec hardens)

- **Never-saved "Untitled" file (no URL yet):** `fileKey` is likely `undefined` even with
  the flag — **untested** (only a saved Community file was open). Confirm with an
  unsaved file.
- **Two concurrent files / two windows:** the cross-file broadcast collision is already
  proven in the handover (§2d); per-file activation across two windows was not re-tested
  here.
- **First-run consent for `enablePrivatePluginApi`:** none observed on relaunch; confirm
  behaviour on a truly first install.
- **`requestAnimationFrame` / `setTimeout` throttling** as an "is-this-iframe-backgrounded"
  proxy (browsers throttle background-tab timers) — untested in Figma's webview; likely
  moot since `visibilitychange` already doesn't fire, but flagged by the web research as
  the most promising *untested* heuristic.

## 6. Web-research verdict — reliable active-file detection is IMPOSSIBLE

A 6-angle deep-research pass (16 primary + forum sources; 25 claims adversarially verified,
22 confirmed) settles the activation question, **high-confidence and unanimous across
primary sources**:

- **No API, property, or `figma.on(...)` event reveals which of several open
  files/windows is frontmost.** The entire `figma` surface and every event are
  single-document-scoped. Verified against the Plugin API changelog dated **2026-06-23**.
- **The only 2024–2026 "focus" additions are node-level:** `figma.currentPage.focusedNode`
  (Dev Mode / Slides / Buzz) reports a focused *node within one page* — structurally cannot
  indicate which *window* is frontmost.
- **Presence signals are per-file:** `activeUsers` / `currentUser` / `ActiveUser` expose no
  `isActive`/`frontmost` flag (grep of the master typings: zero hits).
- **Official stance:** *"Users can only run one plugin and one action at a time"* and *"it's
  not possible to build plugins that run in the background."* This is in **tension with the
  handover's empirically-proven two-concurrent-plugins finding** (§2d, separate windows).
  Reconciliation: each window runs its own instance; "one at a time" is per-invocation.
  Background instances are **not documented to be suspended** (community evidence shows them
  still running), but this is unofficial — so **do not rely on a "heartbeat = active" proxy.**
- **The least-bad in-API heuristic is weak:** `ActiveUser.position` (cursor) is non-null
  only while the mouse is on *that* file's canvas — `null` over panels or the plugin UI, and
  document-scoped (can't be compared across files). Not reliable.
- **What this leaves for the design:** since no signal identifies the frontmost file, the
  design relies on the relay **availability** set (which files have a live plugin) plus
  **explicit** `fileKey` targeting. A server-side *last-interacted* heuristic (heartbeating a
  `selectionchange`/`documentchange` timestamp, "active" = most-recently-active) was weighed as
  a possible default and **rejected** — B3 forbids any guessed default, so an unavailable or
  ambiguous target fails and asks rather than auto-selecting. *(Recorded here as a
  considered-and-rejected option, not part of the shipped design.)*

**Sources:** developers.figma.com `/docs/plugins/api/figma`, `/ActiveUser`, `/User`,
`/properties/figma-on`, `/updates` (changelog); `forum.figma.com` "how to determine if the
plugin window is active"; `github.com/figma/plugin-samples#24` (Figma staff: "plugins can
only run one at a time").

**Design implication:** activation cannot be auto-detected, so the design does **not** try.
Use the relay **availability** set + **explicit** `fileKey` targeting; an unavailable/ambiguous
target **fails and asks** (B3 — no soft default, no most-recently-active fallback). Do not
promise passive or frontmost detection (T7).

## Evidence & method

- **Probe:** a temporary `__probe` command added to `packages/figma-plugin/src/code.ts`
  (returning `fileKey`/`root.id`/`root.name`/`currentUser` + a buffered activity log),
  plus temporary UI focus listeners and sandbox `figma.on` listeners. All reverted; the
  main repo is clean.
- **Driver:** throwaway `bun` scripts under `packages/server/` talking to the live plugin
  over the relay (`ws://localhost:18080`), per the `figma-plugin-automation` skill's
  `build:hot` hot-reload loop. All deleted.
- **Key raw results:** `fileKey` `undefined`→`"qCZ3T6oQxO87myTIx9seZ1"` (flag flip);
  `root.id` `"0:0"`; activity log = `mount` only after focus toggles, then
  `currentpagechange ×2` after a scripted page toggle.
