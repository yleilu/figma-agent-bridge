---
name: figma-bridge-prefs/review-standards
description: >-
  Load when reviewing — the house scale, tokens, ramp, and stricter naming
  standard the reviewer measures a design against.
---

# Review standards

The concrete standards the figma-reviewer measures against when this skill is installed.
These **add stricter house checks** on top of the reviewer's floor.

## House scale (measure against these)

- **Spacing:** 4, 8, 12, 16, 24, 32, 48, 64 (px) — flag spacing off this scale.
- **Type ramp:** 12, 14, 16, 20, 24, 32 (px) — flag type off this ramp.
  (These two lists are **mirrors of `house-style.md` §Concrete values** — the builder reads
  that copy. Edit both together.)

## Naming standard (stricter than the floor)

- Components must use the `/` taxonomy (e.g. `Button/Primary`); flag a component master
  without it.
- Descriptive PascalCase / Title-Case; flag opaque names beyond the shipped
  blank/default-name floor.

## Accessibility standard (WCAG AA — the shipped default; edit to taste)

Your editable accessibility standard. The reviewer measures contrast, text size, and
touch-target size against these when this skill is installed; without it, accessibility is
unchecked (the reviewer asserts no threshold of its own).

- **Contrast (WCAG AA):** normal text ≥ 4.5:1; large text ≥ 3:1 (≥ 18 pt, or ≥ 14 pt bold);
  UI components and graphical objects ≥ 3:1.
- **Minimum text size:** body / label text ≥ 11 px (below 9 px is unreadable at standard
  density).
- **Touch-target size:** interactive elements ≥ 44 × 44 pt (≥ 24 × 24 pt in a compact /
  dense layout).

## Responsive standards

- Probe each text-bearing master at the breakpoint widths in the house style (390 /
  768 / 1200 / 1440 by default); any escape is a blocker.
- Flag a text-bearing master without a min/max contract.
- Flag body text whose line exceeds the measure cap (420 px at 14 px by default).

## The reviewer's floor (non-overridable)

The reviewer's floor is fixed and applies regardless of these house checks: destructive-op
safety, and export + read-back verification. A house standard only ever adds stricter checks
on top; it never changes the floor. Accessibility is **not** part of this floor — it is the
editable standard above.
