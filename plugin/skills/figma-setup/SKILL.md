---
name: figma-setup
description: >-
  Use after installing or upgrading figma-agent-bridge to set up the Figma
  plugin: it copies the packaged Figma plugin files to a stable place the
  user owns and reports the one manifest path to import into Figma desktop.
  Also use when the user wants to set up, edit, or update their personal or
  team Figma house style and preferences — design-system-first /
  component-first strictness, spacing scale, tokens, type ramp, naming,
  file organization, data display, review standards — that figma-agent-bridge
  should follow; that job creates/updates the figma-bridge-prefs skill. Do NOT
  use for building or reviewing a design (that is figma-design / figma-reviewer).
version: 0.1.0
---

# figma-setup

Two independent jobs:

1. **Set up the Figma plugin** (Part 1) — materialise the Figma plugin files
   this package carries at a stable, user-owned path, and report the one
   `manifest.json` path to import into Figma. Run it on a fresh install, and
   again after **every** upgrade.
2. **Author or update `figma-bridge-prefs`** (Part 2) — the user's own
   house-style overlay skill. Only on an explicit request; **never** as a
   side effect of Part 1.

An unqualified _"set up figma-agent-bridge"_ means Part 1. Don't touch Part 2
until the user asks about house style, preferences, or standards.

This skill only sets up and authors; it never builds or reviews a design
itself — that's `figma-design` / `figma-reviewer`.

---

## Part 1 — Set up the Figma plugin

The Claude Code plugin package ships the built Figma plugin inside it. Figma
can't load it from there, so this part copies it somewhere stable and tells
the user what to import. Full design:
`docs/specs/claude-plugin.md` §5.1 in the repo (not shipped).

### Where the files go

| Role                 | Path                                        | What it is                                                              |
| -------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| **Source**           | `${CLAUDE_PLUGIN_ROOT}/figma-plugin/`       | `manifest.json` + `dist/{code.js,ui.html}`, inside the installed plugin |
| **Per-version copy** | `~/.figma-agent-bridge/versions/<version>/` | one directory per installed version — history and rollback              |
| **Active copy**      | `~/.figma-agent-bridge/figma-plugin/`       | a **real directory** holding the active version — what Figma imports    |

Why the detour, and the two rules that follow from it: Figma stores the
**absolute paths** it imported and **re-reads** those files on every run.

- **Copy, never symlink into the plugin's directory.** That directory is
  version-keyed and reclaimed on upgrade or uninstall, so a link into it
  dangles and the user's import silently breaks.
- **`figma-plugin/` is a real directory, never a symlink.** Whether Figma
  records a symlink's own path or its resolved target is unspecified, and a
  resolved target would defeat the whole indirection.

### Steps

1. **Resolve the installed plugin root.** `$CLAUDE_PLUGIN_ROOT` when the
   environment carries it; otherwise find the cached copy:

   ```bash
   root="$CLAUDE_PLUGIN_ROOT"
   [ -f "$root/figma-plugin/manifest.json" ] || root=$(
     find ~/.claude/plugins -type f \
       -path '*figma-agent-bridge*/figma-plugin/manifest.json' 2>/dev/null \
       | sed 's:/figma-plugin/manifest.json$::' | sort -V | tail -1
   )
   echo "$root"
   ```

   Older versions stay in the cache, so `find` may return several roots. The
   sort picks the highest version-keyed path; confirm it by reading that
   root's `.claude-plugin/plugin.json` (step 2). If it's still ambiguous,
   **ask** rather than guess.

   Nothing found and `$CLAUDE_PLUGIN_ROOT` unset means the user isn't on the
   Claude Code plugin route — from a clone they import
   `packages/figma-plugin/manifest.json`, and from the standalone route the
   `manifest.json` in the unzipped `figma-plugin.zip`. Say so; don't invent a
   source.

2. **Read the version** from `<root>/.claude-plugin/plugin.json` — its
   `version` field, which is always present. Use it as `<version>` below.

3. **Write the per-version copy:**

   ```bash
   mkdir -p ~/.figma-agent-bridge/versions/<version>
   cp -R "<root>/figma-plugin/." ~/.figma-agent-bridge/versions/<version>/
   ```

4. **Activate it at the stable path.** Copy _over_ the existing contents —
   don't delete the directory first; that path is what Figma remembers:

   ```bash
   # a stray symlink from an older setup would defeat the indirection
   [ -L ~/.figma-agent-bridge/figma-plugin ] && rm ~/.figma-agent-bridge/figma-plugin
   mkdir -p ~/.figma-agent-bridge/figma-plugin
   cp -R ~/.figma-agent-bridge/versions/<version>/. ~/.figma-agent-bridge/figma-plugin/
   ```

5. **Verify before you report anything** — all three files present, and the
   active copy a real directory:

   ```bash
   ls -l ~/.figma-agent-bridge/figma-plugin/manifest.json \
         ~/.figma-agent-bridge/figma-plugin/dist/code.js \
         ~/.figma-agent-bridge/figma-plugin/dist/ui.html
   [ -L ~/.figma-agent-bridge/figma-plugin ] && echo 'BAD: symlink' || echo 'ok: real directory'
   ```

   If anything is missing, report the failure and stop. Never hand the user
   a path that isn't importable.

### Report the path

Finish by stating the one path to import, on its own line:

```
~/.figma-agent-bridge/figma-plugin/manifest.json
```

**First run — the user imports it once:**

1. In the Figma **desktop** app (the browser client cannot import a
   manifest): **Plugins → Development → Import plugin from manifest…**
2. Select that `manifest.json`.
3. Open **Agent Bridge** from a Figma **design** file — it is absent in
   FigJam, Slides, and Dev Mode, which reads like a failed import but isn't.
   Opening it is the whole connection step: it auto-connects, with no Connect
   button and no channel id to copy.

**Upgrade — the path already held files:** the contents were replaced at that
same path, so there is **no re-import**. Tell the user that explicitly, or
they'll redo the import for nothing. Figma re-reads the files the next time it
runs the plugin; if the panel is open, close and reopen it to pick up the new
build.

Either way, the `manifest.json` and its sibling `dist/` must stay together —
the manifest names `dist/code.js` and `dist/ui.html` relative to itself.

### Upgrades and rollback

- **Nothing refreshes the payload on its own** — this skill is the only thing
  that does. The upgrade order is: refresh the marketplace → update the
  plugin → reload or restart Claude Code → **then** run this skill. Run it
  before those, and it simply re-copies the old version.
- **Keep `versions/`.** It is the history; rolling back is copying a
  different version's files over `figma-plugin/` exactly as step 4 does.
- **A stale payload is never silently wrong.** The connect-time version
  handshake refuses a mismatched Figma plugin loudly — an `INCOMPATIBLE`
  report is `figma-connection`'s diagnosis, and re-running this part is
  usually the fix.

---

## Part 2 — House style: the `figma-bridge-prefs` overlay

A lightweight, Figma-specific skill-creator. On the user's explicit request it
instantiates — or updates — a **user-authored** skill named exactly
`figma-bridge-prefs`: the sanctioned home for one user's or team's house style
(strict design-system-first / component-first levels, concrete tokens and
scales, naming, file organization, data display, review standards). Full design:
`docs/specs/customization.md` §5 in the repo (not shipped).

### What this produces

A single skill, always named `figma-bridge-prefs` — the name is **fixed**,
never taken from user input, so there is no path-traversal surface. It's
produced by copying the shipped template directory
`references/figma-bridge-prefs-template/` wholesale into the user's skills
tree, then tailoring the copy by interview. `figma-bridge-prefs` is not
shipped by the plugin, and `figma-setup` is the _only_ path that writes it —
see `docs/specs/customization.md` §5 in the repo (not shipped) for the
full model of how the overlay reaches the build loop and overrides upward.

### Scope selection — user vs project

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

### Instantiate flow

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
   scale, token set, type ramp, naming conventions, file organization (the
   page scheme and where masters sit), data display (how a delta or a status
   renders), how strict design-system-first / component-first should be, review
   standards — and edit the copied `references/*.md` files to match. **Preserve
   the floor-preserving header** in every file you touch: a tailoring edit may
   only _tighten_ (add a scale, a stricter rule); it must never relax
   verification discipline or destructive-op safety.
   Accessibility thresholds are a preference you set here (the template ships
   WCAG AA as the default). If a requested preference would cross that floor,
   say so plainly and keep the floor intact rather than encoding the
   relaxation.

### Update flow

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

### No hook, no auto-seed

`figma-bridge-prefs` is written only when the user explicitly runs this
skill. There is no `SessionStart` hook, no install-time write, no silent
default file — a user who never invokes `figma-setup` gets the shipped basic
floor from `figma-design` / `figma-reviewer`, and nothing is ever written
into their config. Part 1 never triggers it either: materialising the Figma
plugin leaves the user's skills tree untouched.
