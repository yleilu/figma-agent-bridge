---
title: '@figma-agent-bridge/branding'
created: 2026-07-19T20:40:00+08:00
tags:
  - doc
  - figma-bridge
  - branding
type: doc
---

# @figma-agent-bridge/branding

Single source of truth for the **Figma Agent Bridge** brand mark — a terracotta
(`#D97757`) bridge. Source-only (no build); consumed as TypeScript.

## Source of truth

`assets/logo-on-white.svg` is the raw Figma export (bridge on white). Everything
else is **generated** from it — never edit the generated files by hand.

Regenerate after changing the source:

    bun run generate

This writes the transparent default (`assets/logo.svg`), the PNG ladders, and
`src/logo.generated.ts`.

## Default is transparent

- `LOGO_SVG`, `assets/logo.svg`, `assets/logo-*.png` — **transparent** (the default).
- `LOGO_ON_WHITE_SVG`, `assets/icon-*.png` — white full-bleed tile, for placements
  that need a solid background behind the bare symbol.

## Exports

| Export                               | Use                                        |
| ------------------------------------ | ------------------------------------------ |
| `LOGO_SVG` / `LOGO_ON_WHITE_SVG`     | Raw SVG strings (README embeds, data URIs) |
| `LOGO_PATH` / `LOGO_VIEWBOX`         | Path geometry for inline React `<svg>`     |
| `logoDataUri` / `logoOnWhiteDataUri` | `data:image/svg+xml` URIs                  |
| `BRAND`                              | `{ name, color, bg }` tokens               |
| `ICON_SIZES`                         | The generated transparent PNG sizes        |

## Assets

| File                               | Size      | Use                                   |
| ---------------------------------- | --------- | ------------------------------------- |
| `assets/logo.svg`                  | vector    | Transparent default                   |
| `assets/logo-{16..1024}.png`       | 16–1024   | Transparent raster ladder             |
| `assets/icon-{128,256,512}.png`    | 128–512   | White tile                            |
| `assets/figma-cover-1920x1080.png` | 1920×1080 | Placeholder cover (redesign in Figma) |

## Publishing the Figma plugin icon

Figma's `manifest.json` has **no icon field**. Upload `assets/icon-128.png`
(128×128, solid background per Figma's rounded-crop guidance) in the plugin
**Publish** dialog. Optional cover: `assets/figma-cover-1920x1080.png` (16:9).
