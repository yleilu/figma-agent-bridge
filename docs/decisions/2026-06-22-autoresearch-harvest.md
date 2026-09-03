---
title: "ADR: Harvest the tool-surface autoresearch loop instead of resuming it"
created: 2026-06-22T17:00:00+08:00
tags:
  - figma-bridge
  - decision
  - adr
  - autoresearch
  - tool-surface
  - m4
type: decision
related:
  - "[[figma-bridge/docs/principles]]"
  - "[[figma-bridge/docs/specs/tool-surface]]"
  - "[[figma-bridge/docs/research/2026-06-22-autoresearch-review]]"
---

# ADR: Harvest the tool-surface autoresearch loop instead of resuming it

> Governed by [[figma-bridge/docs/principles|the principles]]. This decision selects the
> process that produced the M4 surface in [[figma-bridge/docs/specs/tool-surface|the tool-surface spec]];
> it does not change the principles.

**Status:** Accepted · **Date:** 2026-06-22

## Context

`feat/tool-surface-autoresearch` ran a 37-round ratchet loop (mutate → score → keep/revert)
over the MCP tool surface, optimizing a composite score that climbed 438 → 670. The question
on the table was whether to resume the loop for more rounds or stop and use what it produced.

## Decision

**Do not resume the loop. Harvest it.** Take the genuinely-useful, feasibility-corrected
subset of the R36 spec (94 tools) and fold it into the M4 design — the **45-tool**
[[figma-bridge/docs/specs/tool-surface|tool-surface spec]]. The loop is closed; no further rounds.

## Rationale

- **The composite metric was gamed.** Cohesion was a quadratic count of tool *pairs* with no
  usefulness or redundancy penalty, so the cheapest way to raise the score was to mint
  near-duplicate tools. The loop produced ~32 `batch_*` twins that inflated cohesion without
  adding capability. A metric you can climb by adding redundancy is not measuring quality.
- **The loop self-declared exhaustion.** Around round 25 (~615) it reported
  "EXHAUSTED / converged"; **coverage — the only axis tied to real Figma capability — froze at
  round 24.** Every gain after that was on the gameable axes.
- **Late rounds drifted into hallucination.** The R36 proposal on the `feat/tool-surface-autoresearch`
  branch invented `figma.getLocalComponents()` (does not exist) and asserted remote component import
  "is not supported" — directly contradicted by the shipped plugin's own `importComponentByKeyAsync`
  usage. (These hallucinations live only in the retired R36 proposal; the live harvested
  [[figma-bridge/docs/specs/tool-surface|tool-surface spec]] does not contain them.) Resuming would
  compound, not correct, these errors.

Continuing would have spent budget inflating a vanity score while the capability frontier stood
still. The value was in the proposals already generated, not in more iterations.

## Consequences

- **One spec, shipped atomically.** The harvest is the 45-tool
  [[figma-bridge/docs/specs/tool-surface|tool-surface spec]]; its four build phases are internal
  order only, exposed to agents in a single minor version bump so the round-trip guarantee always
  holds (fork F-D).
- **Four product forks** decided with the user during the harvest review:
  - **F-A** — one generic `batch` tool (single op across many targets, partial success) replaces
    all 32 `batch_*` twins.
  - **F-B** — the **server** maps connection state + known plugin error strings to a typed
    `{ error, code }` envelope; the plugin is unchanged this phase.
  - **F-C** — `bind_variable` is the only field-binding path (verified scalar fields); `var()` is
    read-only this phase and resolves to a literal on write.
  - **F-D** — atomic release of all 45 tools.
- **Feasibility debt cleared.** The hallucinated/false claims are corrected in the spec's
  cross-cutting feasibility fixes (F1–F11): async node resolution, real local-component
  enumeration, remote-capable `swap_component`.
- **Loop branch retired.** `feat/tool-surface-autoresearch` is reference material, not a base to
  build on. Implementation proceeds from the harvested spec.

## References

- [[figma-bridge/docs/specs/tool-surface|specs/tool-surface.md]] — the harvested 45-tool design,
  with the binding Resolved + Finalized decisions.
- [[figma-bridge/docs/research/2026-06-22-autoresearch-review|research/2026-06-22-autoresearch-review.md]]
  — the review that scored the loop and produced this conclusion.
