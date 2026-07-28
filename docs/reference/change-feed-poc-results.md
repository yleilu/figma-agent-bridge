---
title: "Change Feed POC — measured results"
created: 2026-07-27T04:00:00+08:00
tags:
  - figma-bridge
  - change-feed
  - poc
  - reference
type: reference
---

# Change Feed POC — measured results

The Change Feed's self-write filter rests on one number that cannot be derived on paper: **how long
after a command exits does Figma keep delivering that command's `documentchange` events?** Figma
documents that the callback is batched but not the period. Below that floor the filter fails
**open** — every agent write reads as a user edit, `pending_edits` never returns to 0, and the
feature is worse than not shipping.

This document records what was measured against the real plugin, and the value the implementation
takes from it.

> **`SETTLE_MS` no longer exists.** The wall-clock window this document sweeps and sizes was
> **removed** from the codebase; retention is now keyed on the **command**, per
> `docs/specs/change-feed.md`, and is sized by three constants in
> `packages/shared/src/change-feed.ts`:
>
> | Constant | Value | Sized against |
> |---|---|---|
> | `RETAINED_COMMANDS` | 64 | the ≥28 dispatches outstanding in [the idle-delivery leak](#the-idle-delivery-leak--gate-item-2-is-open) |
> | `RETENTION_CEILING_MS` | 5 min | the 49.2 s longest deferral (Probe 1), with margin |
> | `MAX_DISPATCH_MS` | 60 s | 2× the server's own 30 s dispatch timeout |
>
> Every **measurement** below stands and is what those constants are sized against — the sweep
> tables, the batch period, the deferral samples. Only the *mechanism* they were originally used to
> size is gone. Read `SETTLE_MS` anywhere below as "the retired window". **Gate item 2 is still
> OPEN**: command-keyed retention has not been live-verified.

## Method

A probe in the plugin sandbox recorded every `documentchange` with its arrival time, the exiting
command's identity and exit time, and the filter's verdict. Commands were driven **one at a time**
through the real server handlers, with a drain between shapes so no command's tail is measured
against a later command's exit. Frames rode a dedicated relay with its token bucket disarmed, so
the rate limiter could not silently drop the samples being measured.

Population filter (load-bearing, not hygiene): `tExit > 0`, `inFlight == false`, a non-null verdict,
and no context records. A change arriving while a command is still running is measured against the
*previous* command's exit and is not a batch-period sample.

## Measurement A — the batch period

Nine command shapes, each into its own capture:

| Command | n | p50 | p99 | max |
|---|---|---|---|---|
| `create_tree` (100 nodes) | 234 | 95 ms | 95 ms | 95 ms |
| `batch` (50 × `update_node`) | 10 | 84 ms | 84 ms | 84 ms |
| `update_node` | 6 | 100 ms | 100 ms | 100 ms |
| `create_styles` | 2 | 97 ms | 97 ms | 97 ms |
| `delete_node` | 1 | 99 ms | 99 ms | 99 ms |
| `create_node` | 2 | 30 ms | 30 ms | 30 ms |

**All shapes: p50 95 ms · p99 100 ms · p99.9 100 ms · max 100 ms.**

The tail does **not** widen behind a font load or a network fetch. Those commands take longer to
run, but their events still settle within the same ~100 ms of exit — the period is a property of
Figma's delivery, not of the command's duration.

The single most informative sample: a 100-node `create_tree` delivered **202 changes in one batch,
48 ms after the command exited**. A window shorter than that admits all 202 as user edits.

## The `SETTLE_MS` sweep — where the filter breaks

The quiet-user regression (20 mixed agent writes, user idle, pending count must reach exactly 0)
re-run at each value, rebuilding and reloading between:

| `SETTLE_MS` | pending count | cascade records | |
|---|---|---|---|
| 400 ms | **0** | 12 | pass |
| 200 ms | **0** | 12 | pass |
| 120 ms | **0** | 12 | pass |
| 80 ms | **15** | 0 | **fail — fail-open** |
| 40 ms | **15** | 0 | **fail — fail-open** |

**The floor lies between 80 ms and 120 ms**, exactly where Measurement A predicts: the window must
outlast the batch. Below it the cascade count also collapses to 0 — the window closes before the
reflow records arrive at all, so the closure stops working before the touched set does.

## The value

**`SETTLE_MS` = 400 ms.**

Derived, not chosen: 4× the measured p99.9 of 100 ms, and 3.3× the empirical floor of ~120 ms. The
margin covers a slower machine, a loaded Figma, and shapes not in the battery.

The measured value **coincides with the placeholder** the implementation plan carried before the POC
ran. Equality with 400 therefore cannot, on its own, distinguish a measured value from a forgotten
edit, so `packages/shared/test/change-feed.test.ts` pins `SETTLE_MS` against the two measurements it
is derived from — the 100 ms p99.9 batch period and the ~120 ms sweep floor — rather than against a
bare "not the placeholder" inequality.

The upper bound is set by the opposite failure — a window so wide it swallows the user's concurrent
edits. That was tested directly and did not occur at 400 ms: with the window continuously open, 50
overlapping user edits on a different node all survived, and 61 user reorders of a node inside the
agent's own reflow closure all survived. There is no evidence of a ceiling anywhere near 400 ms.

## Gate

> **Scope of this table: the POC probe, under an ACTIVE Figma.** Every row below was measured with
> the file in the foreground and edits flowing. The shipped code was later re-checked against the
> same criterion under an **idle** Figma and did **not** reproduce row 1 — see
> [the shipped-code live sweep](#shipped-code-live-sweep) and, specifically,
> [the idle-delivery leak](#the-idle-delivery-leak--gate-item-2-is-open). Read this table as "the
> filter's *rule* is sound", not as "the shipped feature passes".

| Criterion | Result |
|---|---|
| Quiet-user regression reaches exactly 0 | **PASS** — 3 runs, row counts verified non-vacuous |
| A concurrent user edit survives at the same value | **PASS** — 50 overlapping edits, all kept |
| The remaining observable cases pass | **PASS** |
| False user edits per agent command | **0** |
| `SETTLE_MS` derived from measurement | **PASS** |

**The self-write filter is not falsified *as a rule*.** The design's central risk — a batch tail
heavy enough that the window suppressing agent writes would also swallow concurrent user edits — did
not materialise. Both requirements hold simultaneously with roughly 4× margin.

What the POC did **not** establish is that the rule's *precondition* always holds. The rule is
"`documentchange` arrives within `SETTLE_MS` of the command that caused it"; the measurements above
sample that arrival only while Figma is active. The shipped-code sweep found the precondition
failing outright when it is not.

## Behaviours confirmed against the live runtime

- **`DocumentChange` field names** — `node`, `style`, `properties`, `type`, `origin`, `id` are all
  real; `properties` appears only on the PROPERTY_CHANGE shapes.
- **Property-level subtraction works on genuinely mixed records.** Figma coalesced a user's rename
  and the agent's cascaded reflow into one record; the filter kept `name` and subtracted
  `relativeTransform`/`y`. A whole-record drop would have lost the rename silently.
- **Both creation claim sites are required.** A node claimed at creation has an empty reflow closure
  every time (no parent yet); the closure only becomes reachable after the node is appended.
- **The window's reset genuinely clears.** A node the agent touched, moved by the user 30 s later,
  is attributed to the user.
- **A user delete survives** — the change that matters most, since acting on a deleted node is the
  failure the feature exists to prevent.

## Known limits at the time of measurement

- **One agent per file.** A second agent's writes are invisible to the first: the filter is
  source-side in the plugin and drops self-caused changes before they reach the wire, without
  knowing which session issued the command. Multi-agent awareness needs a wire addition and is
  out of scope for this cycle.
- **Undo/redo** was not exercised.
- **Sustained load** (a continuous multi-hundred-node drag against a production-sized relay) was not
  measured; the rate limiter's drop behaviour under that load is characterised only by the relay's
  own configuration.
- **Only an ACTIVE Figma was sampled.** Every measurement here was taken with the file in the
  foreground and the probe driving edits continuously. Nothing in this document says what the
  `documentchange` batch period is when Figma has been left alone — and that turned out to be the
  case that matters.

## Shipped-code live sweep

The POC measured a probe wired into `code.ts`. This section records what was checked against the
**shipped** pipeline (accumulator → flusher → wire → server buffer → count mirror → presence hook),
live, on 2026-07-28. It is deliberately separate from everything above: the numbers above are still
true of the probe, and one of them is **not** true of the shipped code.

### The idle-delivery leak — gate item 2 is OPEN

The plan's live-sweep item 2 re-checks the gate on the shipped code: *20 agent writes of mixed shape,
user idle, `pending_edits` must be exactly 0; if it is not, stop and re-open the GATE.* **It was not
0.** The correct status of this branch is **blocked**, not shipped.

What was observed, with a Figma that had been left untouched for a long stretch before the run:

| Evidence | What it shows |
|---|---|
| Sweep PHASE 5 → PHASE 7 | The 20-write battery produced **no push frame at all** while it ran (`pushFramesDelta=0`). Four phases later a **single frame, `seq=1`, `records=19`** arrived carrying nothing but the agent's own creates — including eight from a **previous run of the same script**. `pendingCount` went 0 → 19. |
| The drain that followed | Listed `{"op":"create","id":"19:161","name":"T16Doomed"}` for a node that run had created **and deleted**. Per change-feed.md's collapse algebra a create+delete cancels; here the create survived. The leak therefore does not merely miscount — it can name a node that does not exist. |
| Probe 1 | One `create_node`. The push arrived **49.2 s after the command exited** and carried the create as a kept record. `SETTLE_MS` is 400 ms, so a 49 s delivery is 120× outside the window: the filter evaluates `admit` at event time and the window was long closed. |
| Probe 2 | The same shape, sampled every 3 s for 90.3 s: `pendingCount=0` throughout and **no push frame in the window**. This run distinguishes nothing on its own — see the vacuity note below. |
| Probe 2 control (`p2c`) | `create_component` under the same idle conditions → push at **t+0.42 s**, `indexStale=true`, `records=0`. Delivery was prompt *and* the filter dropped the agent's own create. This is the one **witnessed** run: it proves the harness, the socket and the filter all work, and that the pathology is intermittent rather than universal. |

**Vacuity note (POC correction 2 applies to this section too).** Probe 2's "0 over 90 s" rests on
absence alone: with no push frame anywhere in its window, nothing inside that window separates "the
filter worked" from "delivery was still deferred". It is **not** evidence that the filter held, and
the 90 s figure should not be quoted as such. Only the `p2c` control carries a liveness marker, and
it is a different run nine minutes later. The same objection retires the sweep's own
`RESULT case 11: pendingCount=0` — PHASE 6's liveness control reported `pushFramesDelta=0` in the
very same window, i.e. the harness correctly refused to witness that zero.

**Trigger and threshold are uncharacterised.** The runs differ in whether Figma was idle, which
command shape was used, and how long the plugin had been up; none of those was varied
systematically. Until it is, the honest statement is that `documentchange` delivery to the plugin
sandbox is **not reliably prompt**, and that the self-write filter — which is time-windowed — fails
**open** whenever it is not. Fail-open is the "worse than not shipping" direction the gate exists to
catch.

**Next step, before this branch can merge:** reproduce the pathology deliberately (leave Figma
untouched, then issue one agent write and watch `pending_edits`), characterise the trigger and the
threshold, and then either fix it or — if it is an unfixable Figma/Chromium throttling fact — reopen
the gate as an explicit human decision and record that decision here.

### Verified live, with a liveness witness

Each of these was watched for a positive signal, not for the absence of one:

- **Baseline open → `{0, no_baseline}`**, written immediately as the `_unattributed` sentinel.
- **Adoption and migration.** The sentinel's record reappeared as `<sessionId>.json` sharing the
  sentinel's exact `updatedAt` (`1785176097936`) — the record *moved*, it was not re-derived.
- **`no_baseline` → `ok` on the first drain**, witnessed by a moving `updatedAt`.
- **Reconnect arm.** A plugin reload produced a new epoch and the spec's opening flush verbatim
  (`seq=0 epoch=epoch-ynl4sh6jnjr2 indexStale=false records=0`), then `state: gap` in both the count
  file and the presence block, and `pull_changes → {changes: [], state: 'gap'}`.
- **Drain.** 19 real records out; the count file read 19 before and 0 after.
- **Presence rendering, all three cases** — a count file present (`pending_edits: 0`), absent (both
  fields omitted, not `0`), and `gap` (`pending_edits: 0` **plus** `pending_edits_state: gap`).
- **Default-directory agreement.** One run with `FIGMA_BRIDGE_CHANGES_DIR` unset on both the server
  and the hook: the server wrote and the hook read the same
  `~/.figma-agent-bridge/changes/<key>/<session>.json`.
- **Count-file shape.** `{schema, fileKey, writer, pendingCount, state, updatedAt}`, one file per
  `<fileKey>/<session>`, no `.tmp` left behind.

### Deferred, with what each would prove

None of the following was run. They are listed so the record is not read as more complete than it is.

| Deferred | What it would prove |
|---|---|
| Quiet-agent baseline (20 real user edits → `pending_edits: 20`) | The capture path end to end from a human's hands, not the agent's. |
| Collapse (drag one node 40× → `pending_edits: 1`) | The collapse algebra on **user** input. See the note below — collapse currently has *no* clean live evidence. |
| Navigation never counts | That `page`/`select` records stay out of the count. |
| Reconnect → `gap` driven by closing and reopening the plugin by hand | The in-band arm from a real user action rather than a scripted reload. |
| Unsaved file addressed by synthKey | That an unsaved file's counts render and drain under its channel. |
| Reply health under sustained drag | The token-bucket invariant: the feed must never spend budget a paired reply needs. |
| Socket close → `gap` by killing the relay | Covered only by a same-arm proxy (`client.disconnect()`), which exercises the server's handler but not a real socket death. |
| **The real `session_id` chain** | The sweep hand-passed `sess-task16`. The full chain — identity `PreToolUse` → `meta.sessionId` → `sanitizeKey` stem → presence-hook stdin `.session_id` → `SessionEnd` sweep — has never run end to end in a real Claude Code session, and it is the single contract that makes the per-session path work at all rather than degrading to `_unattributed`. |
| **The real MCP server process** | The harness re-declares `packages/server/src/index.ts`'s wiring rather than running it. The two agree today (diffed), but a future divergence in `index.ts` is invisible to this sweep. |

### Collapse algebra is NOT verified live

An earlier draft claimed it was. Withdrawn: the only live collapse evidence came from the leaked
batch — a dataset this section declares corrupt — and it contains a counter-example to itself. Run
2's create-then-delete (`19:169`) cancelled; run 1's identical create-then-delete (`19:161`, same
script) did not, and its `create` survived into the drain. Whether that is a real collapse defect or
an artifact of split delivery cannot be told apart without a run-1 log, which does not exist. Fold it
into the idle-delivery investigation. Collapse's only trustworthy evidence today is the unit suite.

### The window cannot be widened out of the problem (tested 2026-07-28)

The obvious fix — raise `SETTLE_MS` until it covers the delivery tail — was tried and **failed**.
Same rig, same conditions, only the constant changed. Each run: 20 mixed agent writes with the user
idle and Figma backgrounded, ending in a `create_component` **liveness marker** (it emits a frame
even when every record is filtered, so "no leak" cannot be confused with "nothing delivered").

| `SETTLE_MS` | runs leaking | leaked payload |
|---|---|---|
| 400 ms | 1 of 7 | 1 record |
| 2000 ms | **2 of 7** | **18 and 9 records** |

Frame arrival relative to the marker's exit, at 2000 ms: **395, 1121, 1239, 1910, 2435, 3907 ms**.
The deferral routinely exceeds two seconds, so a two-second window does not cover it — it only lets
more writes accumulate before the leak lands, which is why the payload grew from 1 record to 18.

**A prior 7-run sample at 400 ms with delivery at 304-416 ms was luck, not refutation.** Sampling
the prompt case repeatedly is not evidence that the deferred case is gone; this is the same
absence-of-evidence trap as the vacuity note above, and it fooled a full round of investigation.

**Conclusion: no bound has been established on the deferral, so no value of `SETTLE_MS` can be shown
to close this.** A time-windowed self-write filter is the wrong shape for a delivery channel whose
latency is unbounded. `SETTLE_MS` is left at 400 — 2000 carries a strictly larger residual (more
cascade records dropped on closure members) for no demonstrated benefit.

**Gate item 2 remains OPEN.** What would close it is a filter keyed on something other than wall
clock — e.g. retaining the touched set per COMMAND for the last K commands, so a deferred event
still matches the command that caused it however late it arrives. That is a design change, not a
tuning change, and it belongs to a spec revision rather than this branch.

### That design change has since been specified and built (2026-07-28)

`docs/specs/change-feed.md` was revised to key retention on the command, and the plugin now
implements it: every event-causing dispatch opens a **generation**, sealed at exit and retained
until `RETAINED_COMMANDS` newer ones exist or the scope has been idle for `RETENTION_CEILING_MS`.
`SETTLE_MS` is deleted. Membership is asked at event time and answered from what is retained then,
so how long delivery took is no longer part of the question.

**Gate item 2 is still OPEN and this is the assertion that closes it**: 20 mixed agent writes, the
user idle and Figma backgrounded, ending in the `create_component` liveness marker — the frame it
forces must carry `changes: []`, `pending_edits` exactly 0, repeated. Add one case for the
page-closure regression while live: `set_current_page`, then the **user** drags a top-level frame on
that page — that record must survive.

### Command-keyed retention closes it (verified 2026-07-28)

The window was replaced by retention keyed on the command (change-feed.md, "Retention is keyed on
the command"). Re-run of the same battery, same rig, Figma backgrounded, `create_component` liveness
marker, drain widened to 75 s so deferrals of the observed size can actually be seen:

| Design | runs leaking | largest deferral survived |
|---|---|---|
| `SETTLE_MS` = 400 ms | 1 of 7 | ~0.4 s |
| `SETTLE_MS` = 2000 ms | 2 of 7 | ~2 s |
| **Command-keyed retention** | **0 of 5** | **60.6 s** |

Frame arrival relative to the marker's exit, all five with `records = 0`:
**8.8 s, 23.3 s, 31.5 s, 46.1 s, 60.6 s**. A standalone marker measured **42.5 s** with
`indexStale: true, records: 0` — the frame arrived, proving the path live, and every record in it
was still matched to the command that caused it and dropped.

**No run was vacuous.** Every trial witnessed a frame, so these are observations rather than
absences. An earlier pass at a 15 s drain reported `frames=0` on five of seven trials — that drain
was shorter than the deferral, and those trials proved nothing; they are not counted here.

**Delivery deferral is confirmed, larger than first measured, and no longer decisive.** The first
sweep saw 49.2 s and this one 60.6 s, against writes that complete in tens of milliseconds. What
changed is that the filter no longer asks *when* an event arrived — only whether its id is still
retained — so an arbitrarily late batch is decided correctly.

**One observation left unexplained.** The 15 s-drain pass leaked a single STYLE record at
marker+9.5 s. It did not recur in the 75 s runs, and the test file accumulates styles across runs,
so it may have been a stale record from an earlier run rather than a live leak. It is recorded
rather than dismissed: style identity is matched on the key, not the id string, and that path is
worth re-checking if a style ever appears in a clean run.

**Gate item 2 is closed** under this design, with the residuals in change-feed.md's Limitations
unchanged: retention reaches past the command it belongs to, and the idle ceiling is still a
wall-clock bound on a delivery channel with no proven one.
