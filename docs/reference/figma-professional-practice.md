---
title: Modern Professional Figma Practice
created: 2026-06-23T14:00:00+08:00
tags:
  - reference
  - figma-bridge
  - figma-practice
  - design-system
type: reference
related:
  - "[[figma-bridge/docs/principles]]"
  - "[[figma-bridge/docs/specs/tool-surface]]"
  - "[[figma-bridge/docs/specs/expression-formats]]"
---

# Modern Professional Figma Practice

> Reference for principle **T9** (the tool surface makes this workflow effortless) and
> for the **plugin/skill layer** (which *prefers* it, P1). Descriptive, not normative —
> it records how professionals build in Figma so both layers can target it.

## Why this matters

An AI agent, left to its defaults, builds like **HTML**: plain frames pinned at absolute
x/y, shapes copy-pasted per state, colors and sizes hard-coded as literals. A **modern
professional Figma user builds the opposite way** — reusable, token-bound, rule-based
structure. The gap between the two is the difference between output that *looks generated*
and output that looks like real design work and survives editing, theming, and dev handoff.

The professional workflow rests on three pillars. For each: what pros do, the naive
contrast, what the **tool layer must make effortless** (T9), and what the **skill layer
should prefer** (P1).

---

## 1. Auto-layout, not coordinates

Pros treat **auto-layout as the default container** (Figma's Flexbox/Grid): a frame
*declares* flow, padding, gap, alignment, and per-child sizing, and the layout solves
itself. Absolute positioning ("Ignore auto layout" in UI3) is the **rare opt-out** for
overlays/badges/floating elements — almost never used inside content.

**Practices**
- Wrap virtually every group (button, card, row, list, screen) in auto-layout; build by **nesting** auto-layout frames, each with its own rules.
- **Per-axis sizing — Hug / Fill / Fixed** set independently for width and height (button hugs its label; input fills the row; card has fixed height). This replaces resize-constraint thinking and is *the* core responsive skill.
- **Min/Max clamps** on Fill/Hug for fluid-but-bounded behavior (max line-length, min button width).
- **Padding** uniform / per-axis / per-side; **gap** as a number or **Auto** (space-between).
- **Alignment** on both axes (9-point); **Wrap** for reflowing card/chip grids.
- **Absolute** only for overlays, positioned with constraints relative to parent (+ canvas stacking order).

**Naive contrast:** pins everything at x/y and re-nudges on every content change → brittle, non-responsive, wrong CSS on handoff.

**Tool must make effortless (T9):** set `layoutMode` (+ wrap) as the natural default for any container; per-axis `HUG|FILL|FIXED` + min/max; per-side padding + `gap`/`AUTO`; both alignment axes — all in one call; cheap nested-tree creation; an explicit per-child `ABSOLUTE` opt-out; and **discourage raw x/y on auto-layout children** (no-op + warn).
**Skill prefers (P1):** reach for auto-layout first; use absolute only for true overlays.

---

## 2. Compose from components (variants + properties)

Pros build from **reusable components** — a main component is the single source of truth,
instances inherit, one edit propagates. Variation is encoded as **properties**, not
duplicated layouts.

**Practices**
- **Compose, never redraw** — place instances; never copy-paste raw shapes (that breaks inheritance and causes drift).
- **One named property per axis of change** — `Type`, `Size`, `State` as separate variant properties, never a combined `Style=PrimaryLarge`; orthogonal props mix-and-match and read like real code.
- **Variants for states/types; component properties for the rest** — **boolean** (toggle layer visibility), **text** (editable strings), **instance-swap** (swappable nested component) express variation *without* multiplying variants.
- **Avoid variant explosion** (size×type×state×icon) via nested instances + instance-swap, or a hidden **base component** all variants reference.
- **Expose nested properties** to the parent so a consumer configures everything from one instance.
- **Slots** (GA, with min/max + restrictions) for open/freeform content areas (card/modal body) where instance-swap is too rigid.
- **Set instance props without detaching** — flip a boolean, switch a variant, edit text, swap a nested instance; overrides survive variant switching.
- **Naming/organization** — slash hierarchy (`Button/Primary`) for Asset-panel folders; meaningful variant values; component descriptions; publish to a **team library**.

**Naive contrast:** duplicates whole layouts per state, detaches to edit → unmaintainable, no shared library.

**Tool must make effortless (T9):** create-component + combine-as-variants as single calls; add/edit all four property types (variant/boolean/text/instance-swap) incl. defaults & preferred values; **set instance properties without detaching** (the most common authoring action); expose nested props to parent; easy base/nested composition; full slot lifecycle (define + guardrails + fill, graceful fallback); reads that surface variant props, component props, and current overrides; warn on variant-permutation explosion.
**Skill prefers (P1):** componentize repeated UI; choose variant vs property vs slot by intent; keep one property per axis.

---

## 3. Bind to tokens, not literals

Pros treat values as **named decisions**. They build a layered token system with **Figma
Variables** (Color/Number/String/Boolean — aliasing, modes, scopes, code-syntax) plus
**Styles** where variables can't reach (composite effects, gradients, text/grid).

**Practices**
- **Three tiers in separate collections:** **Primitives** (raw palette/scale, never applied, hidden from publishing) → **Semantic/alias** (role-named: `text-secondary`, `surface-brand`, `gap-section`; holds the **modes**) → optional **Component** tokens. Each tier aliases the one below.
- **Bind designs to semantic tokens only** — never primitives or raw values; a rebrand/theme becomes a value reassignment, not a redesign.
- **Modes** (light/dark, density, brand) are parallel value sets of the same token names, applied at frame level.
- **Name by role, not appearance** (`text-secondary`, not `gray-text`).
- **Bind layout numbers too** — padding, gap, radius, stroke, sizing bind to a **Number** spacing scale, not just colors.
- **Scopes** restrict where a token appears (a gap token won't show in corner-radius).
- **Styles** for composite effects / gradients / type / grid; **Variables** for everything tokenizable. Plan for **code export** (DTCG / Tokens Studio) so engineering shares the names.

**Naive contrast:** hard-codes hex/px on each node, names by hue, duplicates files for dark mode → drift no theme switch can fix.

**Tool must make effortless (T9):** create variables/collections/modes as first-class ops; **set any property by variable binding (by name/id), with raw literals the exception**; aliasing in one op; per-mode value setting atomically; scope at creation; reads that report bound-vs-hardcoded and the token/tier; discovery of existing collections/modes/tokens (reuse, don't duplicate); bulk re-binding for normalization; clear variable-vs-style routing.
**Skill prefers (P1):** bind to semantic tokens; create/reuse a token system; never hard-code values; tokenize spacing & type, not just color.

---

## Sources

Figma Learn — *Guide to auto layout* and *Auto-layout fundamentals*; *Component properties* /
*Create and use variants* / *Slots*; *Variables* and *Modes* guides. Design-system practice
2024–2026 (three-tier token architecture; one-property-per-axis; auto-layout-first). Captured
2026-06-23 via web research.
