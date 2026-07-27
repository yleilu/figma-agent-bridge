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

**`SETTLE_MS = 400 ms.**

Derived, not chosen: 4× the measured p99.9 of 100 ms, and 3.3× the empirical floor of ~120 ms. The
margin covers a slower machine, a loaded Figma, and shapes not in the battery.

The upper bound is set by the opposite failure — a window so wide it swallows the user's concurrent
edits. That was tested directly and did not occur at 400 ms: with the window continuously open, 50
overlapping user edits on a different node all survived, and 61 user reorders of a node inside the
agent's own reflow closure all survived. There is no evidence of a ceiling anywhere near 400 ms.

## Gate

| Criterion | Result |
|---|---|
| Quiet-user regression reaches exactly 0 | **PASS** — 3 runs, row counts verified non-vacuous |
| A concurrent user edit survives at the same value | **PASS** — 50 overlapping edits, all kept |
| The remaining observable cases pass | **PASS** |
| False user edits per agent command | **0** |
| `SETTLE_MS` derived from measurement | **PASS** |

**The self-write filter is not falsified.** The design's central risk — a batch tail heavy enough
that the window suppressing agent writes would also swallow concurrent user edits — did not
materialise. Both requirements hold simultaneously with roughly 4× margin.

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
