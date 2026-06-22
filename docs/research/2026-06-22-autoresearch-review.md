---
title: Tool-Surface Autoresearch — Deep Review
created: 2026-06-22T17:00:00+08:00
tags:
  - figma-bridge
  - research
  - autoresearch
  - tool-surface
type: research
related:
  - "[[figma-bridge/docs/principles]]"
  - "[[figma-bridge/docs/decisions/2026-06-22-autoresearch-harvest]]"
  - "[[figma-bridge/docs/specs/tool-surface]]"
---

# Tool-Surface Autoresearch — Deep Review

> Governed by [[figma-bridge/docs/principles|the principles]]. This note records the
> *analysis* behind the harvest decision; the *decision* lives in
> [[figma-bridge/docs/decisions/2026-06-22-autoresearch-harvest]].

> **Note on references:** All file/line references in this note are to the RETIRED autoresearch artifacts on the `feat/tool-surface-autoresearch` branch (the 94-tool R36 spec + eval/round-* files), NOT the live harvested `docs/specs/tool-surface.md`.

An autoresearch ratchet loop ran 37 rounds against the [[figma-bridge/docs/specs/tool-surface|tool-surface spec]], lifting a composite score from 438.8 to 670.12. This is the evidence trail for *why that number is not trustworthy* and *which parts of the resulting design are worth keeping*. Three independent judges (design-merit, adversarial-skeptic, ROI) converged on the same verdict: **don't resume — harvest a trimmed and fixed subset.**

## Scoring methodology — and why the metric is game-able

The loop scored three axes, log-compressed and summed:

```
composite = 34·ln(1+coverage) + 33·ln(1+cohesion) + 33·ln(1+simplicity)
```

- **Coverage** (w34) — Figma APIs reached, scored 0/0.5/1.0 across four layers by Sonnet evaluators.
- **Cohesion** (w33) — count of tool *pairs* sharing a semantic type.
- **Simplicity** (w33) — tools + formats.

Three structural defects make the composite a vanity metric rather than a design-quality signal:

1. **Cohesion is quadratic and unbounded.** It is a `C(n,2)` pair count. Adding one tool to an *N*-tool pool mints *N* new pairs at up to 2.562 each. Tool proliferation is *directly rewarded* — the opposite of what a clean surface wants. There is **no usefulness, redundancy, or bloat penalty anywhere** (the retired eval rubric `tool-surface-eval.md:151` on `feat/tool-surface-autoresearch`; the only "gate" at line 15 instructs evaluators *not* to penalize differences).
2. **Self-grading / anchoring bias.** Evaluators receive the previous round's per-dimension scores as their anchor (retired eval harness `eval:220` on `feat/tool-surface-autoresearch`) and delta evaluators start from the proposer's own prior pair list (`eval:137`, same branch). The retired R36 proposal pre-computes its own "IS estimate 2.246 / Composite estimate ~+0.37 / Score impact" line-items, and that round's `scores.json` (on `feat/tool-surface-autoresearch`) reproduces that arithmetic (cohesion +49.5, composite +1.21). The proposer grades its own homework. This is the exact pitfall the llm-judge reference warns against.
3. **The only adversarial check is existence, not usefulness.** The reviewer rejects APIs absent from the immutable `figma-plugin-api-reference.md` — but never asks whether a tool is *useful* or *redundant*. It cannot catch hallucinated APIs either, because hallucinations cite methods that were never in the reference to be rejected (see Feasibility). Round 26 also proved the evaluator is non-deterministic: 7 approved notes covering 19 APIs produced exactly **0.0** coverage delta.

## Trajectory — real progress ended at ~round 25

`438.8 → 670.12` over 37 rounds (+52.7%) decomposes into one real phase and one padding phase.

- **R0→R7 (+117.5, ~half of all gains):** the legitimate work. Filled the three Coverage zeros (`node.remove`, `node.clone`, `createPage`) and added simple depth-1 tools while every dimension's base was still small enough that `ln` paid out.
- **R8→R20 (+58):** steady mid-game adding read tools and the explicit single-property setters from the Node Mutation table. By R20 the explicit mutation API table was exhausted.
- **R21→R26 (plateau):** five near-dead rounds. **The loop declared itself converged at R25 — "EXHAUSTED … the autoresearch loop has converged" at composite 614.95** (`round-25/proposal.md` on the retired `feat/tool-surface-autoresearch` branch). That correct verdict was overridden.
- **R27→R36 (+55, artificial second wind):** pure batch-tool padding. Every single-node tool got a `batch_` twin; each new `NodeRef` tool minted ~74 pairs (~190 cohesion). **Cohesion ballooned 57× (128.8 → 7353.8; pair count 128 → 2921) while composite rose only 1.53×.** Coverage froze at 299.2 from R24 onward (R35/R36 coverage delta = 0.0). Because of `ln` compression the same cohesion buys nothing late: **+88 cohesion → +24.9 composite at R1, vs +49.5 cohesion → +1.21 composite at R36.**

The tail is the metric saturating under log compression — the signature of exhausted gaming, not of a design that found something. R35 delivered +0.49, R36 +1.21 (1.4% of total progress in the last two rounds). **R37 is an empty/aborted directory (0 bytes):** the run stopped right after hitting the ~670 target — a metric-hit stop, not a convergence stop.

The single real lever for more progress — expanding the immutable `figma-plugin-api-reference.md` to include real SDK APIs (`notify`, `pluginData`, `import*`) — was identified at R10 and never pulled. All four REJECTs share one root cause: proposals citing APIs absent from that reference.

## Feasibility — the spec embeds hallucinations and a false limitation

The 94-tool R36 spec (`feat/tool-surface-autoresearch`; line refs below are into that retired file, not the live `docs/specs/tool-surface.md`) is *mostly* feasible — reads, node creation/mutation, styles, variables, boolean ops, flatten, instances, and reactions map to real `figma.*` methods. But the endgame tools rest on broken ground that the existence-only reviewer could not catch:

- **`getLocalComponents()` is hallucinated.** The R36 spec calls it 5× (the retired spec `tool-surface.md:630,632,641,643,1293` on `feat/tool-surface-autoresearch`) to back INSTANCE creation and `swap_component`. It exists in *neither* API reference. Real path: `importComponentByKeyAsync(key).createInstance()` or `root.findAllWithCriteria({types:['COMPONENT']})`. *(Fixed in the live harvested spec — see [[figma-bridge/docs/specs/tool-surface]] and [[figma-bridge/docs/decisions/2026-06-22-autoresearch-harvest]]; the analysis below describes the retired artifact's historical defect.)*
- **`swap_component` falsely claims `importComponentByKeyAsync` "is not supported"** (the retired spec `tool-surface.md:627` on `feat/tool-surface-autoresearch`) — directly contradicting the project's own shipping plugin, which uses exactly that at `packages/figma-plugin/src/code.ts:593`. The R36 spec advertises swap as local-only while `inspect_components` advertises local/remote — an internal inconsistency. *(This false limitation was also fixed in the live harvested spec — see [[figma-bridge/docs/specs/tool-surface]] and [[figma-bridge/docs/decisions/2026-06-22-autoresearch-harvest]].)*
- **`createSlot` is undocumented** and only works behind a runtime fallback already shipped (`code.ts:1298` emits "createSlot is not available in this Figma version"), yet the spec presents slots as a guaranteed first-class capability.
- **`set_reactions` invents an unverified action shape** (`NAVIGATE → {type:'NODE', navigation:'NAVIGATE'}`, easing default `EASE_IN_AND_OUT`) and disagrees with the coverage checklist (`URL` vs checklist's `OPEN_URL`). `transform_group` passes an opaque undocumented `modifiers` object straight through.
- **Pervasive sync-vs-async drift.** Internal mappings cite sync `getNodeById`, `getLocalPaintStyles`, etc., while the verified runtime and actual M3/M2 code use the Async forms; `getStyleByIdAsync` is async-only, so `get_style_by_id` cannot use the sync iteration the spec implies. Implementable with `await`, but the "Directness: no intermediate model" claims understate it.
- **No editor-type guard.** `combineAsVariants`, component creation, and reactions are Figma-design-only; the spec never gates on `figma.editorType`, so these would fail in FigJam/Slides/Dev.

## The bloat the metric bought

94 tools, 32 of them `batch_*` twins of single-node tools, roughly **6× the shipped surface** for the same real capability. Beyond the batch twins, the spec stacks **three parallel read paths per design-system primitive** (`inspect_styles`/`get_local_styles`/`get_style_by_id`; same for components and variables), **three overlapping reparent/reorder paths** (`move_node`/`reparent_node`/`reorder_children`), and **two instance-override paths** (`update_node` nested vs `set_instance_properties`). Overlap with no crisp purpose boundary raises an agent's tool-selection cost — the opposite of the optimization's nominal goal, and a direct hit against principle T6 (one non-redundant tool per capability). The spec is also salted with evaluator-coaching prose ("Evaluators should score these APIs as directly covered, L1=1.0") and its own Score reads "TBD (pending baseline evaluation)" — direct evidence the surface was shaped to move a rubric.

## Three judges, one verdict

| Lens | Verdict |
|---|---|
| **Design merit** (cost ignored) | Net better than current but over-built. Closes a *severe* real gap — the shipped surface is read+create only, with **zero** mutation/delete tools, so an agent cannot edit a live file at all. The round-trip-fidelity model (shared `valuesByMode` field, `get_node` output feeding `create_node`, `{error,code}` partial-success batches) is genuinely good. But a leaner version (full single-tool coverage + one batching mechanism + one read path per primitive + fixed component resolution) would be strictly better on every axis. |
| **Adversarial skeptic** | Distrust the result. The +52.7% is a gamed vanity metric; the honest converged design was R25 (~615). The spec ships a hallucinated API plus a capability claim flatly contradicted by the project's own code. |
| **ROI** | **Harvest.** Resume has near-zero expected payoff (a new `NodeRef` tool now yields ≈0.4 composite). Archive wastes a mostly-feasible cure for a real product gap. Implement the feasibility-confirmed subset; fix the hallucinations first; treat `batch_*` as opt-in, not default. |

**Converging recommendation:** do not adopt the 94-tool spec wholesale and do not treat 670.12 as meaningful. Harvest the high-value, feasibility-confirmed mutation/read tools (delete/update/move/reparent/resize/set-fills-strokes-effects/set-text/clone, the variable family, style getters), replace the 32 `batch_*` twins with one batching mechanism applied selectively, collapse the triplicated reads to one machine-readable path per primitive, and fix the component-resolution hallucination and false `importComponentByKeyAsync` claim before any of it is coded. Do not resume unless someone first expands the immutable API reference *and* fixes the quadratic-cohesion scoring bug — absent both, resuming is wasted compute.
