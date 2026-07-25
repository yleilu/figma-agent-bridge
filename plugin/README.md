<p align="center">
  <img src="https://raw.githubusercontent.com/yleilu/figma-agent-bridge/main/packages/branding/assets/logo-128.png" width="72" alt="Agent Bridge" />
</p>

<h1 align="center">Agent Bridge</h1>

<p align="center">Drive Figma from Claude Code — design, review, and file feedback.</p>

---

The **Agent Bridge** Claude Code plugin bundles the skills, agents, and hooks — plus the
MCP server and the Figma plugin payload — for building and reviewing Figma designs with an
AI agent over the MCP bridge.

## Requirements (Claude Code)

This plugin runs its server with **[Bun](https://bun.sh)**. Most developers already have it.
**Bun has to be on the PATH before the agent host starts** — the desktop app or the `claude`
CLI — because a running session keeps the PATH it was launched with and never sees a `bun`
installed after it. Install Bun first, or install it and then quit and reopen the host.

```bash
# check, and install if missing (macOS / Linux):
command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash
# Windows (PowerShell):
#   powershell -c "irm bun.sh/install.ps1 | iex"
```

There is no toolchain-free alternative: every install route runs the server on your own Bun,
so a machine without it cannot run Agent Bridge. The repository README's
[Install section](https://github.com/yleilu/figma-agent-bridge#install) lists every route.

**Supported on macOS and Linux**; on Windows the plugin runs degraded — see
[Requirements](#requirements).

## Install

### 1. Install the plugin

Installing is always **two steps** — add the marketplace, then install the plugin from it —
and you can take them wherever you already are. There are **four surfaces and three command
forms**: the Directory, the Code surface, the CLI in a session, and the CLI from a shell — and
the two slash-command surfaces are identical, so they are written once below. The desktop app
and the CLI **share one plugin state**, so every form produces the same install, and a plugin
installed from one is there in the other. On the desktop app the **Code** surface is the
supported one: on its chat surfaces the skills load, but the plugin's MCP tools are not
guaranteed to be bridged, which leaves the agent knowing how to design and unable to.

**Desktop app — the Directory.** Use the Directory's **add-a-repository** action and point it
at this repository, `yleilu/figma-agent-bridge`. That syncs the marketplace and does nothing
else. Then, from the listing that appears, install **Agent Bridge**. Stopping after the first
step leaves the install half done — nothing has gone wrong, but no plugin is installed yet.

**Slash commands — the Code surface or the CLI.** The same two steps, typed:

```
/plugin marketplace add yleilu/figma-agent-bridge
/plugin install figma-agent-bridge@figma-agent-bridge
```

**Shell — for scripting.** The same two steps, outside a session:

```bash
claude plugin marketplace add yleilu/figma-agent-bridge
claude plugin install figma-agent-bridge@figma-agent-bridge
```

The `figma-agent-bridge@figma-agent-bridge` slug is `<plugin-name>@<marketplace-name>`; both
names derive from this repository, hence the repeat. Reload or restart afterwards so the MCP
server is picked up.

The marketplace lives on GitHub; the plugin itself is published to the npm registry.
Installing fetches that package and copies it into Claude Code's own plugin cache — server
bundle, skills, agents, hooks, and the Figma plugin payload, all in one. Nothing is
downloaded afterwards, nothing is built, and there are no dependencies to install. Claude
Code then starts the MCP server with the `bun` on your PATH.

### 2. Verify the server started

A successful install does not by itself prove the MCP server came up — that only happens on
the reload. Check the host's list of MCP servers: **`figma-agent-bridge`** should be there and
connected, and its tools should appear under the namespace

```
mcp__plugin_figma-agent-bridge_figma-agent-bridge__*
```

That prefix is the plugin route's own; a server wired up by hand shows as `mcp__figma-bridge__*`
instead, so the namespace also tells you which one you are actually talking to. No server in the
list means the server never started — see [Troubleshooting](#troubleshooting).

### 3. Set up and import the Figma plugin

Ask Claude to run the **`figma-setup`** skill — it is a skill, not a slash command, so you ask
for it rather than type it. It writes the Figma plugin files to a stable location you own and
reports the exact path to import:

```
~/.figma-agent-bridge/figma-plugin/manifest.json
```

Then, in the Figma **desktop** app — the browser cannot import a manifest:

1. **Plugins → Development → Import plugin from manifest…**
2. Select the `manifest.json` at the path `figma-setup` reported.
3. Run it from **Plugins → Development → Agent Bridge**.

**It appears in a design file only.** Agent Bridge is a design-editor plugin: it shows up in the
Development menu of a **Figma design file**, and nowhere else — not FigJam, not Slides, not Dev
Mode. In the wrong editor the entry is simply absent, which reads like a failed import but isn't.

**Opening it is the entire connection step.** The panel auto-connects to the relay the MCP server
manages — there is no Connect button and no channel id to copy anywhere.

Leave the manifest and the `dist/` folder next to it together: the manifest points at
`dist/code.js` and `dist/ui.html` relative to itself, and Figma remembers the path you imported.

You import **once**. On an upgrade, **ask Claude to run `figma-setup` again** — that is what
replaces the files at that same path; it does not happen on its own. Figma re-reads them the
next time it runs the plugin, so a new version needs no re-import.

**Upgrading, in order:** refresh the marketplace → update the plugin → reload or restart
Claude Code → re-run **`figma-setup`** → no Figma re-import. Skip the `figma-setup` step and
Figma keeps running the old build, which the server then refuses at connect time on a version
mismatch.

## Requirements

- **macOS or Linux** — see the platform note below
- Claude Code (latest)
- Figma desktop (not Figma in browser)
- Bun — on the PATH before the agent host starts (see [Requirements (Claude Code)](#requirements-claude-code))
- npm — used once, at install time, to fetch the package
- git — used once, to add the marketplace

**Platform.** The MCP tools are platform-neutral; the **hooks** are not. Agent Bridge ships five
POSIX shell hooks that call `jq` and `curl`, and native Windows supplies neither. On Windows the
tools keep working, but without a POSIX shell that provides `jq` and `curl` the hooks simply do
not run — you lose agent identity injection and the turn-start presence status block. Nothing
reports that, which is why it is worth knowing up front.

## Usage

Once installed, the `figma-agent-bridge` MCP server is available in every Claude
Code session. Ask Claude to read, create, or edit Figma frames — it routes calls
through the relay to the Figma plugin running in your open document.

**`figma-setup`** has a second, separate job: **on request** it creates a `figma-bridge-prefs`
skill you own and can edit — your personal or team house style (spacing scale, tokens, type
ramp, naming, review standards) that the designer and reviewer follow. It is not created as a
side effect of setting up the Figma plugin; ask for it when you want it. Without it, you get
the basic professional defaults.

## Troubleshooting

**`bun` is not found.** Either it was installed after the agent host started — a running session
keeps the PATH it was launched with — or it is not installed at all. Install it if it is missing,
then quit the host and reopen it; the server runs on Bun and nothing else.

**The Figma panel never connects.** The relay binds loopback port **18080**; if another process
already holds it, the server attaches to that stranger instead of starting its own. Free the port,
and keep Figma, the relay, and the server on the same machine.

**Agent Bridge is missing from Figma's menu.** Wrong editor — it appears under **Plugins →
Development** in a Figma **design** file only. Open one and look again.

## Teardown

Removing it cleanly is four steps, because an install leaves files in four places:

1. **Uninstall the plugin**, from whichever surface you installed it on — the Directory, or the
   plugin commands in a session or from a shell. That drops the cached package: server bundle,
   skills, agents, hooks, and the packaged copy of the Figma payload.
2. **Remove the marketplace entry** too. Left behind, it keeps offering the plugin for reinstall.
3. **Remove the imported plugin from Figma** — in Figma desktop, take Agent Bridge out of
   **Plugins → Development**, the same list you imported it into. Do this _before_ step 4: Figma
   stores absolute paths, so deleting the files first leaves an entry pointing at nothing.
4. **Delete the materialised payload.** It lives outside the plugin cache, so uninstalling does
   not touch it:

   ```bash
   rm -rf ~/.figma-agent-bridge
   ```

   That takes the active copy and every per-version copy kept beside it.

## Architecture

```
Claude Code (MCP client)
  └── bin/server.js — the installed plugin's server bundle (MCP server + relay, run via bun)
        └── WebSocket relay  ←→  Agent Bridge Figma plugin (Figma desktop)
```

The bundle runs in two modes:

- Default (no flags): MCP stdio server — what Claude Code connects to.
- `--relay`: WebSocket relay server — auto-spawned by the MCP server on demand.

## Releases

Every `v*` tag publishes:

- the **plugin package** to the npm registry — the server bundle plus the skills, agents,
  hooks, and Figma plugin payload. This is what the Claude Code route installs, and what the
  standalone-server route runs through the package's `bin` entry.
- the **Figma plugin archive** to GitHub Releases — for hand-importing the Figma plugin.

Everything is built at release time; nothing built is committed to the repository.

## Releasing

1. Bump the version in the root `package.json` — the single version of record.
2. `bun run release:stamp` — stamps that version into every artifact.
3. Commit, tag (`v<version>`), and push. CI runs the verification gate, builds the server
   bundle and the Figma plugin into the package, publishes the package to the registry, and
   publishes the GitHub Release with its assets.

## License

MIT
