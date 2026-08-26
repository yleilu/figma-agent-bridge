---
name: figma-design/responsive
description: The responsive-sizing doctrine — nothing FIXED without a reason, masters hug while instances fill, text wraps, floors live on containers, collections flow with wrap or hold with grid. Load before sizing any component, slot, or text block.
---

# Responsive-sizing reference

A component must survive a container it was not drawn in. The failure this
doctrine kills: a component looks right at its authored width, and the first
narrower instance pushes its own text outside its bounds. Every rule here was
validated live.

## 1. The two layers

Responsiveness has two layers with different jobs:

| Layer | Question | Mechanism | Change |
|---|---|---|---|
| Per-component | What does this do at any width? | sizing + min/max + wrap/grid | continuous |
| Device | When does the structure change? | variants, variable modes | discrete |

A component must not know the device. It must know its container. The
decision rule between the layers: **stretch handles size. Variants handle
structure.** A variant earns its place only when the structure changes (a nav
bar becomes a hamburger). A size change never earns a variant.

## 2. FIXED needs a reason

A FIXED dimension is a decision, not a default. Intrinsic art earns it:
icons, avatars, dots, glyph boxes, chart plot frames. Their size IS their
content. Everything else sizes by relationship: HUG to content, or FILL to
container. A stated size in the request or the brief is also a reason.
Record it, then keep the interior responsive.

## 3. Masters hug, instances fill

- The master carries no frozen size. Width and height HUG the content. Each
  instance decides its own relationship to its container. Usually the
  instance FILLs the axis the container owns.
- The floor lives on the container as a min-size. A hugging master with
  all-FILL children collapses exactly to its minWidth. That collapse is the
  floor working, not a defect.
- Min/max propagate to every instance as family bounds. The clamp is
  one-way: clearing a min/max restores no size, and HUG does not re-resolve.
  A binding clamp can overwrite an instance's own size override
  destructively. Set family floors before instances diverge. Re-check
  instance sizes after any floor change.
- Write min/max on FRAMES and containers, never on leaf rectangles. Verify a
  floor by read-back: reads emit minWidth/minHeight.

## 4. Text fills and wraps

- Multi-word text takes FILL width, never HUG. HUG-width text is the
  overflow mechanism: it cannot shrink below its content, so a narrower
  instance pushes it outside the box. FILL tracks the container. The block
  grows taller instead of leaking sideways.
- Give long text a maxWidth so a wide container cannot stretch a line past a
  readable measure. The concrete cap is a house value
  (`figma-bridge-prefs`).
- A single-word label inside HUG chrome stays HUG. Its container hugs it,
  and the container is what fills.

## 5. Collections: wrap flows, grid holds

Two peer tools carry repeating items. Choose by what must happen on resize:

- **Wrap flows.** `layout: {mode: 'H', wrap: true, gap}` reflows the column
  count as the container narrows: 3 → 2 → 1, with zero variants. Give
  children FILL width: each row distributes its width across its members,
  and the family min/max does the column math. A lone last-row child grows
  only to the family max.
- **Grid holds.** `layout: {mode: 'GRID', rows, cols, rowGap, colGap}` keeps
  its track count under any resize. Tracks distribute FILL children like
  `fr` units. The structure never reflows by itself — changing the track
  count is a deliberate, discrete move: one `update_node` layout write
  retracks a live grid and every child follows. Use grid when rows AND
  columns must stay aligned, or when a layout must hold its shape while it
  squeezes.
- Pick wrap when the column count should answer the width. Pick grid when
  the structure is the design. They compose: a grid shell can hold a wrap
  region.
- Tool note: cell SPANS (a header across all columns, a sidebar down two
  rows) are not expressible on the surface yet. Until then, compose spanning
  shells from nested H/V frames and use grid for the uniform regions.

## 5b. Concentric radii

A rounded box inside a rounded box needs a smaller inner radius: **inner
= outer − the inset between them.** Outer 20 with a 2px rim needs inner
18. The token scale does not override geometry — take the off-scale
literal knowingly (the same "knowingly" the binding splits use). This
governs every box-in-box: cards inside cards, rings, focus outlines.
For borders specifically, prefer the gradient-stroke recipe
(`mechanics.md`, *Gradient borders*) — a stroke follows the outline and
removes the inner radius entirely.

## 6. Slot sizing

The modeling half of slots is `components.md` §5. The sizing half:

- Optional slot: width FILL, height written to plain 0 at rest. An empty
  slot adds nothing to its bar. (Figma stores a sub-pixel epsilon for 0. Any
  read-back height under 1px IS the 0 you wrote.)
- Required-content slot: HUG with no stored height. The children own their
  heights. The container's min-size carries any floor.
- Either kind, once filled: set the instance slot to HUG in the same breath.
  A FIXED-0 slot clips its content invisible.

## 7. The squeeze check

Before calling a text-bearing master done: place a probe instance in scratch
space. Set its width to the master's minWidth (no floor: ~60% of natural).
Read the descendants' bounds against the container box. Nothing escapes —
text wraps or truncates, children stay inside, the block grows downward.
Then delete the probe. A component that only works at its authored width is
not done. The reviewer runs this same probe as a scored dimension
(`figma-reviewer`, Responsiveness) — build so it finds nothing.

## 8. The device layer

- Breakpoint variants carry structure changes only (§1's rule). Never make
  one per page or per size.
- Variable modes are the token mechanism: a breakpoint collection with one
  mode per device, spacing/type values per mode, each screen pinned to a
  mode (`bind_variable {mode}`). One parameter switches a screen.
  Plan-gated: a Starter-plan file allows one mode per collection — the
  create degrades with warnings. Fall back to per-screen literal tokens
  carrying the values the modes would hold.
- The house breakpoint widths are a preference (`figma-bridge-prefs`).
