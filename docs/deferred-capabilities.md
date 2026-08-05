---
title: Deferred Capabilities — Spec-Completeness Backlog
created: 2026-06-27T16:00:00+08:00
tags:
  - figma-bridge
  - spec
  - backlog
  - deferred
type: reference
---

# Deferred Capabilities — Spec-Completeness Backlog

**What this is: the TBD list.** A capability belongs here only if it passes **both** tests:

1. **We will ship it** — not "might", not "if someone asks".
2. **A specific reason blocks it now** — named and checkable. *"Nobody has built it yet"* is not a
   blocker, it is a schedule.

The canonical shape is the team-library row below: we intend to source components from a team
library, publishing one needs a paid Figma plan, we do not have one, so it cannot be verified.
Committed, blocked, blocker named.

**Not for** bugs, roadmap, wishes, settled decisions or internal quality work — see
[`docs/README.md`](README.md) for where each of those goes. Seven entries left this file on
2026-08-05 for failing one test or the other.

**Why they're separate from bugs:** bugs are **code↔spec** mismatches (the spec declares it, the code is wrong → fix the code). These gaps are **spec↔principles** mismatches — the **spec itself never declared them**, so it's incomplete relative to its governing principles (T1 symmetry, T6 "expose every distinct capability", T2 round-trip). See `principles.md`.

> **Process gate — do NOT fill these piecemeal.** Before implementing _any_ of these, run a **spec-completeness audit** (sweep the spec against T1/T6/T2 to surface the _full_ set, not just the ones a sweep happened to hit), then per feature: **brainstorm → update the spec first → plan → build** (cascade per the doc-management hierarchy). Several of these are one coherent family and should be decided together.

Surfaced 2026-06-27 during the comprehensive live tool sweep + per-issue spec review.

> **Audit 2026-08-05.** Re-verified every *Still deferred* item against `dev` after the
> tool-contract merge (`a6e90e0`), by execution rather than by reading the notes. **Nothing in
> Still deferred has completed** — TEXT_PATH, grid track-sizing/child-placement,
> `create_tree` BOOLEAN_OPERATION, `vectorNetwork`, the auto-layout HUG default, unknown-key
> rejection on the create face, Community distribution and reconnect-with-backoff all still hold,
> each re-checked in code. **Two bugs listed below as open are now closed** (`B17`, `B20`), and the
> plugin-apply extraction advanced by one of its four named field-applies. The `set_instance`
> `overrides` entry was added 2026-08-04 and is deliberately untouched.

> **Audit 2026-07-29.** This file had accumulated shipped capabilities and **already-fixed bug notes** among the live deferrals. Everything finished has moved to [§ Shipped](#shipped--history) at the bottom; what remains above is genuinely deferred and was re-verified against `dev` code. Two sections were **routed out** entirely (they duplicated tracked QA-backlog items) — see [§ Routed out](#routed-out-2026-07-29).

## Still deferred

### T6 — real Figma capabilities not yet exposed

| Capability | Figma API (verified real) | Current status | What fulfilling it needs |
| ---------- | ------------------------- | -------------- | ------------------------ |
| **TEXT_PATH** (text on a path) | `figma.createTextPath(vector, startSegment, startPosition) → TextPathNode` (typings `^1.132.0`) | **Writer DEFERRED — M11 ship-gate failed live (2026-07-18):** `createTextPath` works + creates a TEXT_PATH, but `get_node` cannot recover the source-vector ref — `TextPathNode.vectorNodeId`/`startSegment`/`startPosition` are NOT exposed at runtime (and the node has no readable `vectorPaths`), so the write is write-only → deferred per T2 (never ship a write-only tool). Text content DOES read back; existing TEXT_PATH nodes still read type+text. Full impl preserved on unmerged branch `feat/m11-textpath`. **Re-verified 2026-08-05:** the branch still exists and is unmerged; `packages/` carries only comments explaining the absence. ⚠️ **The blocker may have moved.** The 2026-07-18 finding was against typings 1.123.0; in **1.132.0 `TextPathNode` declares `vectorPaths` AND `vectorNetwork` as readable**, so the node's GEOMETRY can be read back after all. Still absent: `vectorNodeId`/`startSegment`/`startPosition` — they exist only as `createTextPath` parameters — so which vector it was built from, and where along it, remain unrecoverable. A shape round-trip may now be possible where a construction round-trip is not. **Probe live before deciding** — typings and runtime disagreed on `PatternPaint` this same week. | Re-enable when the runtime surfaces the source-path ref on `TextPathNode` (then finish the export enrichment + merge `feat/m11-textpath`). |

### Blocked on an account we do not have

- **Team-library component sourcing — cannot be verified.** `team-library-registry.md` specs
  sourcing components from a published team library, and the surface is designed for it. But
  **publishing a library requires a paid Figma plan** (`docs/specs/team-library-registry.md:135-136`)
  and we do not have one, so neither the publish side nor the consume side can be exercised
  end-to-end — a library key cannot be produced to test against. The read path
  (`importComponentByKeyAsync` / `importComponentSetByKeyAsync`) is built and the error path is
  live-verified; only the SUCCESS path is unproven. **To fulfil:** a paid plan, or a collaborator
  with one who can publish a fixture library we can point at.

### Read round-trip limitations (JSON_REST_V1 gaps)

- **`vectorNetwork` / `setVectorNetworkAsync` — full bezier authoring (M3-V3, DEFERRED).** `vectorPaths` (M3-V1/V2, ✅ SHIPPED merged `4430194`) covers VECTOR node write + read-back for non-curved paths via `node.vectorPaths`. The deeper `vectorNetwork` API (`VectorNetwork` with bezier handles, vertices, segments, regions) enables exact bezier editing but requires a non-atom struct grammar (it is a complex nested object, not a string). **Consequence:** `vectorPaths` read-back from `get_node` is a **documented lossy projection** for pre-existing vectors that have bezier curves or multi-region shapes — their _exact_ geometry lives in `vectorNetwork`, not `vectorPaths`. This is a deliberate, documented T2 asymmetry (T7 honest: the limitation is stated here and in `expression-formats.md`), not a silent gap. **Re-verified 2026-07-29: zero hits** for `vectorNetwork` across `packages/*/src`. **To fulfill:** design the `vectorNetwork` struct grammar, add a `vectorNetwork` field to `NodeSpec`, implement writer + plugin apply (`setVectorNetworkAsync`) + reader read-back.

### Distribution & publishing (surfaced 2026-07-10 — dev-ops workflow design)

- **Public Figma Community distribution — self-issued `fileKey`.** The plugin sets `enablePrivatePluginApi: true` and reads `figma.fileKey`, which Figma restricts to **private/Organization plugins and Figma-owned resources** — public Community plugins are deliberately barred from the file key ([developers.figma.com/docs/plugins/api/figma](https://developers.figma.com/docs/plugins/api/figma/)). So the plugin **cannot be published to the public Community as-is**. **Current path:** the fig-plugin travels as a **manifest-import payload** distributed with the Claude Code plugin package and is imported by the user — a privately distributed plugin, so the private API stays available and no Figma review is involved. **Deferred:** public Community distribution (to be discussed before building). **Plan when we do it:** keep the same identity key name **`fileKey`** on the wire/register protocol, but populate it with an **id we generate ourselves** — a stable per-file id stored on the document via `figma.root.setPluginData`/`getPluginData` (survives sessions, shared across collaborators on the same file) — and drop `enablePrivatePluginApi`. This is **transparent to the server**, which already trusts whatever id the plugin reports on `register`; only the _source_ of the value changes. Trade-off: we lose the _real_ Figma file key (no Figma REST-API correlation), which the localhost bridge does not use today. See the dev-ops spec's distribution section.

### Dev-ops — deferred verification & follow-ups (surfaced 2026-07-11 — dev-ops workflow shipped)

The dev-ops workflow is **built + merged to dev** (CI gate, release pipeline, and the npm-published Claude Code plugin package — see `docs/specs/dev-ops.md`). The headless-verifiable parts are done and green; the following need a real machine / app / release and are **deliberately deferred** — the workflow is treated as complete:

> ⚠️ **Flagged, not asserted (audit 2026-07-29): this section is partially overtaken by events.** `377ebde` (2026-07-26, *"distribute the plugin from npm; retire the committed bundle"*) changed the distribution model the live-install checklist below was written against. Worth a re-read by whoever owns dev-ops before the checklist is trusted. The 2026-07-29 audit did **not** verify the install flow itself — that is outside the QA-backlog scope.

- **Live installs (human, GUI/CLI):** the Claude Code plugin install + run on a box **with Bun on PATH** (including that the package installs inert — no dependency-install step); and, since **Bun is a prerequisite of every route** (`docs/specs/dev-ops.md` §3.1), that a **missing Bun** surfaces the clear error the design promises — pointing at the README check-install — rather than failing silently; the **Windows** path (Bun `.mcp.json` PATH resolution on a real Windows box); the Figma plugin **manifest import** from the path `figma-setup` reports, including that an upgrade needs no re-import.
- **Windows coverage for the plugin's hooks:** the shipped hooks are bash scripts using `jq` and `curl`. No Windows-native equivalent or graceful degradation exists when a shell/`jq` is absent — behaviour there is unaddressed, not just unverified.
- **P2 / P3 (non-code):** cloud CI turns on the moment `dev`/branches are pushed (`ci.yml` already triggers); branch protection on `main` and the release pipeline's actor exemption are GitHub ruleset configuration (`docs/specs/dev-ops.md` §5).

## Routed out (2026-07-29)

Two sections left this file because they duplicated items already tracked elsewhere. **One source of truth per item** — the QA backlog wins for anything with an id.

- **"Skill guidance (figma-design) — deferred improvements (surfaced 2026-07-16)"** — both bullets were verbatim duplicates of tracked skill items: *component-first extends to containers/shells* is **`S1`** and *don't pile masters at `[0,0]`* is **`S2`**, both in [`docs/scratch/qa/issues/3-skill.md`](scratch/qa/issues/3-skill.md), which is the tracked home (it carries the severity, the rule-text status and the A/B verification gate this file has no way to express). Removed here; nothing lost.
- **"Skill guidance (figma-design) — deferred improvements (surfaced 2026-07-29 — change-feed)"** — *a large foreign `pending_edits` count means RE-EVALUATE, not replay* → allocated as **`S16`** in `3-skill.md`, with its measurement (draining 41 entries ≈ 1.1k tokens vs ≈ 3k to re-read the same 40-child subtree — so the crossover sits near the default drain limit) and its concentration-not-count caveat carried across intact. ⚠️ **the tool-side half stayed behind and is recorded here** for whoever picks it up: *emitting the drain's `remaining.frames` buckets on **every** drain rather than only on truncation* would make the skill rule mechanical instead of heuristic. Worth doing only if the rule proves hard to follow in practice — not specced, deliberately.

---

# Shipped — history

Capabilities that were deferred here and have since landed. Kept for traceability; the "what fulfilling it needs" column is gone because it was fulfilled.

## T6 — capabilities now exposed

| Capability | Merged | Notes |
| ---------- | ------ | ----- |
| **css-grid / GRID auto-layout** (M12) | `e87cc39` | `layout.mode:'GRID'` + `rows/cols/rowGap/colGap` on the `LayoutSpec` struct; writer/reader/plugin-apply all wired; feature-detected (T7 — degrades gracefully on old runtimes). Track sizing + child placement remain deferred above. |
| **Masks** — `node.isMask` (+ `maskType`) (M9) | `0fa4612` | Writer, plugin-apply and reader all handle mask round-trip. Sibling-ordering semantics documented. |
| **GROUP creation** — `figma.group(nodes)` (M10) | `f959647` | `group_nodes` tool added; GROUP **read** round-trip also wired (T2 — existing GROUP nodes no longer silently flattened). |
| **`create_tree` composites — `TRANSFORM_GROUP`** (M15) | `5e7f613` | Shipped as the `transform_group` tool. Decision: composites route to dedicated op tools rather than `create_tree`. `BOOLEAN_OPERATION` remains deferred above. |
| **Library/remote instance round-trip** (M14) | `7bc5618` | `get_node`/`get_nodes`/`inspect` emit `component.{id, key, remote:true}` for the directly-requested INSTANCE root via `getMainComponentAsync` (feature-detected, T7); `create_node(INSTANCE)` prefers `importComponentByKeyAsync(key)` when `remote===true`, falls back to `id`. **Root-only asymmetry (T10):** the same instance reads back `key+remote` as the `get_node` root but id-only as a descendant inside a deep inspect — a deliberate bounded-scan optimization, not an inconsistency. Resolved via `isRoot` gating. |

## T1 — symmetry / CRUD holes now closed

| Capability | Merged | Notes |
| ---------- | ------ | ----- |
| **`delete_variables` / `delete_styles`** (M1a/M1b) | `1f8fada` | CRUD symmetry with `create_*` restored. |
| **`delete_page` handling (page-guard)** (M4) | `1f8fada` | Current-page guard added to `delete_node` — switches away then removes, or returns a clear error if it is the last page. |

## Shipped in the M-build (2026-07-18) — not previously tracked as deferred

Built and merged as part of the M-items build; they arose from the same spec-completeness audit but were not in the tables above, so they are recorded here for traceability.

| Capability | Merged sha | Notes |
| ---------- | ---------- | ----- |
| **Slots — define (createSlot via `update_component`) + fill (append into an instance's slot)** (M2) | `2c5e83f` | Slot definition on components + slot-filling on instances. |
| **VECTOR `vectorPaths` authoring + round-trip, the `path()` atom, re-homed `pointCount`/`innerRadius`/`sectionContentsHidden`, field-symmetry meta-test** (M3) | `4430194` | Closes the **field-strip class** for `vectorNodeId`/`booleanOperation`/`component`. `vectorPaths` (V1/V2) merged; full bezier `vectorNetwork` (V3) remains deferred above. |
| **Variable aliases round-trip (B2) + per-node explicit variable-mode selection** (M13) | `3453977` | Variable-alias expressions resolve through the alias chain on read; per-node `variableMode` override field added. |
| **`transform_group` (`figma.transformGroup` repeat-pattern)** (M15) | `5e7f613` | Enables repeat-pattern layout via `figma.transformGroup`. |

## Bug notes that this file carried until they were fixed

These sat in the deferred tables long after the code was corrected. Each was **re-verified fixed on 2026-07-29**, at the cited line.

| Was listed as | Bug id | Fixed where |
| ------------- | ------ | ----------- |
| "Read round-trip limitations → `get_node` `profile` crashes on an unrecognized value" | **B4** | `read/project.ts:100-107` — the `!keys` guard replaced `=== null`. |
| "Read round-trip limitations → Rotated-node size/position read-back" | **B7** | `code.ts:299-307` — the plugin enriches `doc.width`/`doc.height` from the Plugin API (always unrotated) so the reader prefers them over the REST bbox. |
| "Read round-trip limitations → gradient angle reads back `linear(0)`" | **B1** | `node-spec-reader.ts` — the transform is derived from `gradientHandlePositions`. **`B17` (the RADIAL/ANGULAR/DIAMOND identity fallback) is now CLOSED too**, by `cb9a6bf`: all four types derive the full transform from three handles and emit it as `{tf=[…]}`. Re-verified 2026-08-05 by execution — linear, radial, angular and diamond each recover `tf=` rather than falling back. |
| "Authoring ergonomics → `update_component` adds property definitions but does NOT bind them" | **B3** | `code.ts` emits `componentPropertyReferences`, read back by the reader. **`B20` is now CLOSED**, by `2c4220d`: `profile:'full'` short-circuits to identity rather than an enumerated key list (`read/project.ts:99-106`), so it cannot omit a field again. Re-verified 2026-08-05 by execution — `full` keeps both `componentPropertyReferences` and `component`; `minimal` still narrows. |
| "Test-infrastructure → **B-i** writer↔plugin field-symmetry test" | *(`I12`)* | Shipped with M3 (`4430194`): `packages/server/test/serialize/field-symmetry.test.ts`. ⚠️ top-level-key granularity only — struct members are unguarded, which is how `text.runs` (**`B15`**) walked through. Residual tracked as `I12`. |

## See also

- `docs/principles.md` (T1/T2/T6 — why these are obligations)
- `docs/specs/tool-surface.md` · `docs/specs/expression-formats.md` (the spec these complete)
- `docs/reference/api-coverage.md` (canonical Figma-API coverage checklist — reconcile statuses here)
- `docs/scratch/qa/issues/README.md` (the QA backlog — the tracked home for anything with a B/M/I/S id)
- `docs/scratch/plans/2026-06-27-bug-sweep-fixes.md` (the bug-fix pass these are deferred from)
