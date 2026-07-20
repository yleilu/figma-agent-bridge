---
name: figma-setup
description: >-
  Use when the user wants to set up, edit, or update their personal or team
  Figma house style and preferences — design-system-first / component-first
  strictness, spacing scale, tokens, type ramp, naming, review standards
  — that figma-agent-bridge should follow. Creates/updates
  the figma-bridge-prefs skill. Do NOT use for building or reviewing a
  design (that is figma-design / figma-reviewer).
version: 0.1.0
---

# figma-setup

A lightweight, Figma-specific skill-creator. On the user's explicit request it
instantiates — or updates — a **user-authored** skill named exactly
`figma-bridge-prefs`: the sanctioned home for one user's or team's house style
(strict design-system-first / component-first levels, concrete tokens and
scales, naming, review standards). This skill only authors
that overlay; it never builds or reviews a design itself — that's
`figma-design` / `figma-reviewer`. Full design:
[[figma-bridge/docs/specs/customization|customization.md]] §5.

---

## What this skill produces

A single skill, always named `figma-bridge-prefs` — the name is **fixed**,
never taken from user input, so there is no path-traversal surface. It's
produced by copying the shipped template directory
`references/figma-bridge-prefs-template/` wholesale into the user's skills
tree, then tailoring the copy by interview. `figma-bridge-prefs` is not
shipped by the plugin, and `figma-setup` is the _only_ path that writes it —
see [[figma-bridge/docs/specs/customization|customization.md]] §5 for the
full model of how the overlay reaches the build loop and overrides upward.

---

## Scope selection — user vs project

Two places `figma-bridge-prefs` can live:

| Scope                | Path                                        | When to offer it                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **User** (default)   | `~/.claude/skills/figma-bridge-prefs/`      | Always offered first — applies across all of this user's Figma work, per-machine.                                                                                                                                                                                 |
| **Project** (opt-in) | `<repo>/.claude/skills/figma-bridge-prefs/` | Only when the session is inside a git repo that already uses a design system (tokens, styles, or components already in play) — a house style there is a team artifact worth committing and sharing, so offer this _in addition to_ user scope, not instead of it. |

**Shadowing guard (bidirectional).** Claude Code resolves same-named skills
personal (user) > project — a user-scope `figma-bridge-prefs` silently shadows
a project-scope one. Guard **both** write directions:

- **Before writing a project-scope copy**, check whether
  `~/.claude/skills/figma-bridge-prefs/` already exists and, if it does, warn
  the user first: _"a user-scope figma-bridge-prefs will shadow this project
  one"_.
- **Before writing a user-scope copy** (the default scope), detect an existing
  `<repo>/.claude/skills/figma-bridge-prefs/` in the current git repo and, if
  it exists, warn first: _"a user-scope figma-bridge-prefs will shadow this
  project's committed one"_.

Either way, let the user choose whether to proceed anyway, edit the
other-scope copy instead, or maintain both knowingly. Never write the skill
under any name other than `figma-bridge-prefs`, in either scope.

---

## Instantiate flow

The target directory name is **always** exactly `figma-bridge-prefs`,
whichever scope was chosen.

1. **Locate the template.** It ships beside this skill at
   `references/figma-bridge-prefs-template/`. If the absolute path isn't
   already known at runtime, resolve it:
   ```
   find ~/.claude/plugins -type d -path '*figma-setup/references/figma-bridge-prefs-template' | head -1
   ```
2. **Copy wholesale.** Don't cherry-pick files — the template is a complete,
   self-consistent skill and every reference in it matters:
   ```
   cp -R "<template>/." "<target>/"
   ```
3. **Rename the skill file.** The template ships its skill file as
   `SKILL.md.tmpl` on purpose, precisely so the _template_ itself is never
   discoverable as a live skill:
   ```
   mv "<target>/SKILL.md.tmpl" "<target>/SKILL.md"
   ```
   Only the renamed copy — sitting under the user's own skills directory —
   becomes the real, loadable `figma-bridge-prefs` skill.
4. **Tailor by interview.** Ask the user for concrete values — spacing
   scale, token set, type ramp, naming conventions, how strict
   design-system-first / component-first should be, review standards — and
   edit the copied `references/*.md`
   files to match. **Preserve the floor-preserving header** in every file you
   touch: a tailoring edit may only _tighten_ (add a scale, a stricter rule);
   it must never relax verification discipline, destructive-op safety, or
   accessibility minimums. If a requested preference would cross that floor,
   say so plainly and keep the floor intact rather than encoding the
   relaxation.

---

## Update flow

On a later `figma-setup` run against an already-instantiated
`figma-bridge-prefs`:

1. Read the installed `SKILL.md`'s `template_version` and compare it to the
   shipped template's.
2. If they differ, offer a diff / selective merge — walk the user through
   what changed, section by section, rather than overwriting silently.
3. A **pristine** installed copy — byte-identical to the template it was
   seeded from, never edited — may be refreshed to the latest template
   safely.
4. An **edited** file is **never clobbered**. If the user has touched it,
   merge is the only path; a blind overwrite would destroy their house
   style.

---

## No hook, no auto-seed

`figma-bridge-prefs` is written only when the user explicitly runs this
skill. There is no `SessionStart` hook, no install-time write, no silent
default file — a user who never invokes `figma-setup` gets the shipped basic
floor from `figma-design` / `figma-reviewer`, and nothing is ever written
into their config.
