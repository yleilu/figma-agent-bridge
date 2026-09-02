---
name: figma-bridge-prefs/house-style
description: >-
  Load when building or editing — this user's strict design-system-first /
  component-first / everything-responsive level and concrete tokens, scale,
  ramp, naming, file organization, accessibility affordances, and
  data-display conventions.
---

# House style

The strict level of the professional practices, plus this user's concrete values. Edit
these to match your team; they only ever make the build stricter, never below the shipped
floor.

## Design-system-first (strict / proactive)

- Always establish tokens and styles first, even for a one-off.
- Never place a raw value that could be a token.
- Every colour, spacing, and type value is bound to a variable or style.

## Component-first (strict)

- **Everything placed on a page is an instance** — author in components, compose pages
  from instances only. A block gets its states (responsive sizes, variants) at authoring
  time; page content is then swapped by changing variants, never by editing the page.
- Any element used twice or more **must** be a component.
- Prefer variants over duplicated components.
- Never detach an instance.
- Name components by role.

## Everything responsive (strict)

- Every component survives any width its parent gives it — no exceptions beyond
  intrinsic art.
- Every text-bearing master carries a min/max width contract.
- Text measure cap: 420 px at 14 px body (scale with the ramp).
- Breakpoint widths: 390 / 768 / 1200 / 1440 (edit to taste).
- **A bar shows only its essentials plus one `⋯` overflow menu — at every width.** Figma cannot
  switch a bar's look by width (no container queries, no automatic variant switching), so the
  collapse is not an event: the lesser actions live in the `⋯` menu always. Never overhang,
  never clip, **never wrap taller**; a bar stays one line; the most important control and the
  identity mark stay outside the menu.

## Concrete values

- **Spacing scale:** 4, 8, 12, 16, 24, 32, 48, 64 (px).
- **Type ramp:** 12, 14, 16, 20, 24, 32 (px).
  (The scale and the ramp are **mirrored in `review-standards.md`** — the reviewer measures
  against its copy. Edit both together.)
- **Corner radius:** 4, 8, 12, 9999 (pill).
- **Token starter set (colour roles):** `bg`, `surface`, `text`, `text-muted`,
  `primary`, `primary-contrast`, `border`.

## Accessibility

- **Status and sentiment carry a non-colour affordance** — a sign, an arrow, an icon, or a
  shape alongside the hue, never hue alone. Up-green / down-red says nothing in greyscale
  and nothing to a red-green-blind reader.
- Contrast ratios are not set here: `references/review-standards.md` carries them (WCAG AA
  by default).

## Data display

- **A zero or neutral delta renders muted** — no arrow, no `+`. Keep the sentiment colours
  and the arrow for real movement, so a flat number reads as flat at a glance.

## Icons (Material-derived defaults; edit to taste)

- **Family:** 16 / 20 / 24 / 32 px; home size 24.
- **Live area:** 20×20 inside the 24 box — a 2px inviolable rim.
- **Stroke:** 2 at 24, round caps, 2px silhouette corner radius.
- **Ink coverage:** ≈80% of the box.
- **Keylines:** square 18 · circle 20 · portrait 16×20 · landscape 20×16.

## Naming convention

- Descriptive PascalCase / Title-Case names.
- Component `/` taxonomy (e.g. `Button/Primary`).
- Semantic names for structural text nodes.

## File organization

- **Design-system page:** `🧩 Design System` — every **shared** master, style, and token demo.
  A master exactly one screen consumes stays beside that screen (the skill's scope rule), not
  here.
- **One page per screen or flow**, named for the screen (`Dashboard`, `Checkout`), with the
  blocks that screen alone consumes sitting beside it.
- **No standing extra pages** — no scratch page, no archive page. A build creates only the
  design-system page and the screen pages.
- **DS sections stack in ONE page-root auto-layout wrapper** (V, gap 100) — growth then reflows
  instead of colliding with a neighbor section.
- **Master grid:** masters laid out left to right with 100 px gutters, grouped by family (all
  `Button/*` on one row, all `Card/*` on the next).
- Page names follow the naming convention above; no page keeps a Figma default.
