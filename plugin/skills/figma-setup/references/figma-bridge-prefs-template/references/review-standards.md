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

## Naming standard (stricter than the floor)

- Components must use the `/` taxonomy (e.g. `Button/Primary`); flag a component master
  without it.
- Descriptive PascalCase / Title-Case; flag opaque names beyond the shipped
  blank/default-name floor.

## The reviewer's floor (non-overridable)

The reviewer's floor is fixed and applies regardless of these house checks: WCAG AA
contrast (4.5:1 / 3:1 large), touch-target and text-size minimums, and export + read-back
verification. A house standard only ever adds stricter checks on top; it never changes the
floor.
