---
title: Branding — Mark, Assets & Naming
created: 2026-07-26T21:02:54+08:00
tags:
  - spec
  - figma-bridge
  - branding
  - naming
type: spec
related:
  - "[[figma-bridge/docs/principles]]"
  - "[[figma-bridge/docs/specs/claude-plugin]]"
  - "[[figma-bridge/docs/specs/dev-ops]]"
---

# Branding — Mark, Assets & Naming

> Governed by [[figma-bridge/docs/principles|the principles]]. The source of truth for the
> brand mark, the asset set derived from it, and what the project is called on each surface.
> (T1's "one canonical name" governs the agent-facing tool surface, not product names — the
> two never overlap.)

## 1. The mark

A **bridge** — one closed path — in terracotta `#D97757`.

- **Transparent is the default.** The mark carries no background, so it composes onto light
  and dark alike.
- **A solid background is a variant, for square tiles only.** A host that crops an app icon
  to a rounded container would dissolve a transparent mark into whatever sits behind it.

*Why:* the mark is seen on dark surfaces as often as light ones, so transparent is the safe
default; making the tile an explicit opt-in means a white box never appears by accident.

## 2. Assets

`@figma-agent-bridge/branding` holds the mark. One source file is the input; everything else
is generated from it (`bun run generate`) and committed, so nothing needs a build step to use
the mark.

| Asset | What it is |
| --- | --- |
| `assets/logo-on-white.svg` | The source, as exported from Figma — bridge on a white background. |
| `assets/logo.svg` | Transparent default, derived by stripping the background. |
| `assets/logo-{16…1024}.png` | Transparent raster ladder. |
| `assets/icon-{128,256,512}.png` | Solid white tiles. |
| `assets/figma-cover-1920x1080.png` | Placeholder cover art, 16:9. |
| `src/logo.generated.ts` | The SVG strings, path geometry, and viewBox, for code that renders the mark inline. |
| `src/index.ts` | `BRAND` tokens (name, colour, background), sizes, and data-URI helpers. |

The generator **fails rather than emitting output** if it cannot strip the background or
extract the geometry — a "transparent" asset that still carries a white background is the one
failure worth guarding. It is deterministic, so a stale committed asset shows up as a diff.

Consumers take geometry and colour from the generated module, never a copied path or a
restated hex. Editing a generated asset by hand is a defect; change the source and
regenerate.

## 3. Where the mark is used

- **README files** — the root README and the Claude Code plugin README, using the transparent
  mark.
- **The Figma plugin listing**, when the plugin is published — a 128×128 solid tile as the
  icon, optionally the cover. Figma's plugin manifest has no icon field, so this is uploaded
  in the publish flow rather than built.

Claude Code's plugin and marketplace manifests have no icon field either; there, the mark
appears only via the README, and the display name (§4) carries the rest.

**The Figma plugin UI does not render the mark.** Figma's own chrome already shows the
plugin's icon and name directly above the iframe, so a mark inside the UI would restate both
one row below.

## 4. Naming

The project ships two components — one into Figma, one into Claude Code — and each is named
for what it reaches from where the user is standing. The project itself, being neither
component, keeps its own name.

| Form | Value | Names |
| --- | --- | --- |
| Figma display name | `Agent Bridge` | The **Figma plugin** — manifest name, window title, published listing. |
| Claude display name | `Figma Bridge` | The **Claude Code plugin** — `displayName`, marketplace entry, README title. |
| Project name | `Figma Agent Bridge` | The **project as a whole**, in prose — this repository, the docs, the specs. |
| Identifier | `figma-agent-bridge` | Every machine-read name, where a display name would be invalid. |

In the repository and its docs, the project is `Figma Agent Bridge` in prose or
`figma-agent-bridge` in identifier form — either reads correctly, and the choice is a matter
of whether the surrounding text is prose or code. The two host display names belong to the
components they name and are used only for those.

**The name follows the component, not the document.** A Claude-facing doc that tells the user
to open the Figma plugin still calls it `Agent Bridge` — that is what they will look for in
Figma's menu. Cross-host instructions use both names, each for its own component.

*Why two:* inside Figma the user knows they are in Figma, so `Agent Bridge` is the
informative half; inside Claude, where many capabilities compete, `Figma Bridge` says which
one reaches Figma.

The identifier applies wherever a value is parsed, keyed, or namespaced rather than read:
the root package name (and so the MCP server name that prefixes every tool), the plugin and
marketplace `name`, the MCP server key, the `@figma-agent-bridge/*` scope, and the
repository. Skills and agents are already scoped by it when addressed
(`figma-agent-bridge:<slug>`), so their slugs carry only their role.
