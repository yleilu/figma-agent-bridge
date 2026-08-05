---
title: "docs/ — what lives where, and where a new finding goes"
created: 2026-08-05T00:00:00+08:00
tags:
  - figma-bridge
  - docs
  - index
type: reference
---

# docs/ — what lives where

Read this before writing into `docs/`. Every document here has one job, and the commonest way
this tree rots is a finding filed in the wrong place — a bug parked in the TBD list, a design
question buried in a spec, a status note aging inside a timeless document.

## The truth hierarchy

Four layers. **Higher layers win every conflict**, and a conflict means the *lower* layer is the
bug — never "the spec is stale".

| Layer | What | Where |
|---|---|---|
| 1 | **Principles** — unbreakable rules | `principles.md` |
| 2 | **Specs** — agreed designs; the only truth for intended behaviour | `specs/` |
| 3 | **Code + governed content** — code, READMEs, plans | repo, `scratch/plans/` |
| 4 | **Independent docs** — notes with no governing spec | `reference/`, `research/` |

Two gates. **A principle changes only with explicit human approval**, and so does a spec's
**intent or mandated mechanism** — propose, wait, then write. Everything else an agent may revise
directly, cascading downward. See the `doc-management` skill for the full procedure.

## The tracked documents

| Path | Job | Not for |
|---|---|---|
| `principles.md` | the governing rules (B1-B3, T1-T10, P1) and why each exists | mechanism — that lives in specs |
| `specs/` | how each part is designed to behave. One subject per file | status, progress, or what is built |
| `architecture.md` | cross-cutting mechanism: package layout, transport, write semantics | per-feature design |
| `deferred-capabilities.md` | **the TBD list** — see below, it is the most misused file here | bugs, roadmap, wishes |
| `reference/` | verified external facts: Figma API behaviour, coverage checklists | our design decisions |
| `decisions/`, `research/` | one-off investigations, dated, kept for provenance | anything still changing |
| `milestones/` | historical build records (M1-M4) | current work |
| `live-verification.md` | how to verify against a real Figma session | findings from doing so |
| `release-checklist.md` | the release procedure | release history |

## `deferred-capabilities.md` — the TBD list

**Two tests, and an item must pass BOTH:**

1. **We will ship it.** Not "might", not "if someone asks" — a capability we intend to have.
2. **A specific reason blocks it now.** Name the blocker. "Nobody has built it yet" is not a
   blocker; it is a schedule.

The canonical shape: *we should be able to source components from a team library, but publishing
a library needs a paid Figma plan and we do not have one, so we cannot verify it — deferred until
we do.* Committed, blocked, and the blocker is named and checkable.

**It does not hold:**

- **Bugs** — something behaving wrongly against its spec. Nothing blocks a bug; it is unfixed.
  → `scratch/qa/issues/`
- **Roadmap** — work we intend but nothing prevents. → `scratch/qa/issues/2-improvement.md`
- **Wishes and ideas** — unowned, undecided. → `scratch/`
- **Settled decisions** — "we route boolean ops to their own tool" is an answer, not a to-do.
  → the relevant spec
- **Internal quality work** — refactors, test coverage. → `scratch/qa/issues/`

When an item's blocker clears, it stops being deferred: build it, or move it to the backlog with
the blocker struck. When it ships, move the row to `# Shipped — history` at the bottom rather than
deleting it — the record of what was fulfilled and where is worth more than a tidy list.

## The working area — `scratch/`

**`docs/scratch/` is gitignored.** Nothing there survives a fresh clone or a deleted worktree.
Anything that must outlive the session belongs in a tracked document above.

| Path | Job |
|---|---|
| `scratch/qa/issues/` | **the bug backlog** — the tracked home for anything with a `B`/`M`/`I`/`S` id. Its own README is the state doc |
| `scratch/plans/` | implementation plans, one per piece of work |
| `scratch/reviews/` | review and audit reports |

## Routing a new finding

Ask in this order — the first yes wins:

1. **Does something behave against its spec?** → a bug → `scratch/qa/issues/`
2. **Does a spec contradict a principle?** → fix the spec (gated if it touches intent)
3. **Will we ship this, and is something specific blocking it?** → `deferred-capabilities.md`
4. **Do we intend it, with nothing blocking?** → roadmap → `scratch/qa/issues/2-improvement.md`
5. **Is it a verified fact about Figma?** → `reference/`
6. **None of these?** → `scratch/`, and it may not be worth writing down

A finding that is hard to route is usually two findings.
