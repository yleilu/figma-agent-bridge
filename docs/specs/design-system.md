---
title: "Plugin UI Design System"
created: 2026-07-18T22:10:00+08:00
tags:
  - figma-bridge
  - specs
  - plugin-ui
  - design-system
  - tailwind
type: spec
related:
  - "[[figma-bridge/docs/specs/status-monitor]]"
  - "[[figma-bridge/docs/specs/claude-plugin]]"
  - "[[figma-bridge/docs/principles]]"
---

# Plugin UI Design System

> The single source of truth for **how the plugin iframe UI looks** — tokens, type, spacing, radius,
> motion, interaction. Feature specs (e.g. [[figma-bridge/docs/specs/status-monitor|status-monitor.md]])
> describe *behaviour* and reference this doc for *style*; they do not restate token values. **North star:
> match native Figma UI as closely as possible** — the panel should read as part of Figma, not a generic
> web widget.

## Foundation

- **Tailwind v4**, `@theme inline`. The plugin's `index.css` bridges Figma's injected theme variables into
  Tailwind utilities, so components use semantic utilities rather than hard-coded colors.
- **Figma theming is on:** `figma.showUI(…, { themeColors: true })`. Figma injects `--figma-color-*` CSS
  variables and a `figma-light` / `figma-dark` class on `<html>`, and updates them **live** when the user
  flips the app theme. Everything below is token-driven, so light/dark is automatic — never hard-code a
  hex.

## Color tokens

Consume Figma's `--figma-color-*` variables (via the `figma-*` Tailwind utilities). The core set:

| Purpose | Variable |
|---|---|
| Panel bg / recessed / deeper | `--figma-color-bg` · `-bg-secondary` · `-bg-tertiary` |
| Row hover / selected fill | `-bg-hover` · `-bg-selected` |
| Accent (Figma blue) | `-bg-brand` (+ `-hover`/`-pressed`) |
| Status fills | `-bg-success` · `-bg-warning` · `-bg-danger` |
| Text ramp | `-text` · `-text-secondary` · `-text-tertiary` · `-text-disabled` |
| Icon ramp | `-icon` · `-icon-secondary` · `-icon-tertiary` · `-icon-success` · `-icon-warning` · `-icon-danger` |
| Borders | `-border` · `-border-strong` · `-border-selected` |

Any token absent from the `@theme inline` block (a deliberately curated subset, not an exhaustive mirror)
can be used directly as `var(--figma-color-…)` — the Tailwind mapping is a convenience, not a gate.

**Semantic status colors** (used by the status monitor's progress dot and elsewhere):

| Meaning | Token |
|---|---|
| busy / in-progress | amber — `--figma-color-icon-warning` |
| ok / done | green — `--figma-color-icon-success` |
| error / danger | red — `--figma-color-icon-danger` |
| muted row / skeleton / pending | tertiary ramp — `--figma-color-text-tertiary` / `-icon-tertiary` |

## Typography

- **Font:** Inter, with system fallback: `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
  sans-serif`. (Don't rely on Tailwind's default `font-sans` — it resolves to the wrong stack.)
- **Body:** 11px / 16px line-height / weight 400. This is the default and dominant size.
- **Weights:** 400 and 600 **only** — no 500. Emphasis (labels, section titles) is 600, not a heavier
  weight and not uppercase tracking.
- **One step up:** 12px for the occasional larger line (e.g. a headline); never 14px in plugin chrome.
- **Labels** are 11px body text in a secondary/tertiary color (optionally 600) — Figma does **not** use
  small-caps / letter-spaced labels.
- **Metadata:** 10px tertiary is allowed for *trailing metadata only* — a row's relative timestamp, a
  strip's page name. It is never used for a primary label or body copy.

## Spacing, size, radius

- **Grid:** 4px base. Scale: 4 · 6 · 8 · 12 · 16 · 20 · 24. 8px is the default rhythm; 4px for tight gaps.
- **Controls:** 24px height (buttons, inputs). Panel padding 8–12px.
- **Radius:** window/panel **8px**; inputs **4px**; buttons **6px**. **Rows do not round** — see
  interaction.
- **Section strip:** a full-width 24px context line above a list (e.g. the status monitor's selection
  bar), separated by a single `-border` bottom hairline, square like a row. Panel padding applies
  horizontally; it carries no fill of its own beyond the panel background.

## Interaction & row emphasis

Follow Figma's **layers-panel** interaction, not a card/pill style:

- **Row emphasis (hover / selected / busy) is a full-width, no-radius fill** (`bg-hover` / `bg-secondary`).
  Because it is square and edge-to-edge, **consecutive emphasized rows merge into one continuous band** —
  avoiding the double-notch seam that touching rounded fills produce.
- **Focus:** a 1px inset `border-selected` — never a heavy ring or drop shadow.
- Communicate hover/selected/focus purely through the background swap + inset border; no elevation on hover.

## Motion

Restrained, matching Figma's own chrome:

- **Springs are the panel's motion system.** Panel motion (the window edge, row enter/exit, status-text
  crossfade, the busy pulse) is physical — react-spring, tuned once and named centrally, never
  hand-rolled per component. Configs are approved as a set, not chosen ad hoc.
- **Restrained, not bouncy.** Springs are damped so motion reads as settling, not overshooting; a
  spring that visibly bounces is mistuned. Non-spring micro-state toggles stay `0.1s ease-out`.
- The few looping animations the UI uses (a busy pulse, a loading/skeleton, a "connecting" pulse) stay
  subtle: ≤1.8s loops, low-contrast.

## Do / don't

- **Do** drive every color from `--figma-color-*`; **don't** hard-code hex — it breaks live theming.
- **Do** default text to 11px and weights 400/600; **don't** reach for `text-sm`/`text-xs` or 500-medium.
- **Do** use full-width square row fills; **don't** give rows their own rounded pill (they seam when
  stacked).
- **Do** use the named springs for panel motion and keep them damped; **don't** hand-roll per-component
  tuning, add visible bounce, or put elevation on hover.
