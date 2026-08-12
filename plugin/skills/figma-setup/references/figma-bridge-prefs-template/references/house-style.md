---
name: figma-bridge-prefs/house-style
description: >-
  Load when building or editing — this user's strict design-system-first /
  component-first level and concrete tokens, scale, ramp, and naming.
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

## Concrete values

- **Spacing scale:** 4, 8, 12, 16, 24, 32, 48, 64 (px).
- **Type ramp:** 12, 14, 16, 20, 24, 32 (px).
- **Corner radius:** 4, 8, 12, 9999 (pill).
- **Token starter set (colour roles):** `bg`, `surface`, `text`, `text-muted`,
  `primary`, `primary-contrast`, `border`.

## Naming convention

- Descriptive PascalCase / Title-Case names.
- Component `/` taxonomy (e.g. `Button/Primary`).
- Semantic names for structural text nodes.
