#!/usr/bin/env bash
# Install assertion (docs/specs/dev-ops.md §4.2) — proves the plugin PACKAGE installs and its
# server comes up. WHAT is asserted is owned by docs/specs/claude-plugin.md §9.
#
#   scripts/assert-install.sh                   packed-tarball form — packs plugin/ as built from
#                                               this tree (pre-publish gate: CI + release)
#   scripts/assert-install.sh --registry 0.3.0  published form — pulls that version off the
#                                               registry (post-publish gate)
#
# Both forms install the tarball with npm — the same fetcher Claude Code runs for an npm-sourced
# entry — under a CLEAN HOME (fresh cache, no prior plugin state) into a throwaway prefix, then
# assert the installed copy is complete, INERT, version-locked, and that its MCP server answers
# over stdio. The tarball form leaves its tarball at dist/<pkg>-<version>.tgz on purpose: the
# release publishes those exact asserted bytes.
#
# NOT covered (needs a real Claude Code session, so it stays a human step — see the release
# workflow): Claude Code's own resolution of the marketplace entry, skills/agents loading in a
# session, and figma-setup materialising the payload (claude-plugin.md §9.1, §9.4, §9.5).
set -euo pipefail

PKG=figma-agent-bridge
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE=tarball
VERSION="$(bun -e "console.log(require('$ROOT/package.json').version)")"
if [ "${1:-}" = "--registry" ]; then
  MODE=registry
  VERSION="${2:?--registry needs a version, e.g. --registry 0.3.0}"
fi

fail() {
  echo "ASSERT FAILED: $*" >&2
  exit 1
}

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
export HOME="$STAGE/home" # clean state: no npm cache, no prior plugin/feedback state
mkdir -p "$HOME"

# 1) Obtain the tarball.
if [ "$MODE" = tarball ]; then
  for f in plugin/bin/server.js plugin/figma-plugin/manifest.json; do
    if [ ! -f "$ROOT/$f" ]; then
      fail "$f is missing — run 'bun run build:plugin && bun run build:package' first"
    fi
  done
  mkdir -p "$ROOT/dist"
  ( cd "$ROOT/plugin" && npm pack --pack-destination "$ROOT/dist" >/dev/null )
  TARBALL="$ROOT/dist/${PKG}-${VERSION}.tgz"
else
  ( cd "$STAGE" && npm pack "${PKG}@${VERSION}" >/dev/null )
  TARBALL="$STAGE/${PKG}-${VERSION}.tgz"
fi
[ -f "$TARBALL" ] || fail "no tarball at $TARBALL"
echo "asserting $MODE form: $(basename "$TARBALL")"

# 2) An inert package ships no lockfile (claude-plugin.md §5).
if tar -tzf "$TARBALL" |
  grep -Eq '^package/(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$'; then
  fail "the tarball carries a lockfile — the package must be inert"
fi

# 3) Install it the way a host does: npm fetch + copy, into a throwaway prefix.
PREFIX="$STAGE/host"
mkdir -p "$PREFIX"
(
  cd "$PREFIX"
  npm init -y >/dev/null 2>&1
  npm install --no-audit --no-fund --loglevel=error "$TARBALL" >/dev/null
)
PLUGIN_ROOT="$PREFIX/node_modules/$PKG" # == ${CLAUDE_PLUGIN_ROOT}
[ -d "$PLUGIN_ROOT" ] || fail "the package did not install into node_modules/$PKG"

# 4) Nothing else may land in node_modules — a dependency would have been fetched here.
EXTRA="$(ls -A "$PREFIX/node_modules" | grep -v -x -e "$PKG" -e '.bin' -e '.package-lock.json' || true)"
[ -z "$EXTRA" ] || fail "the package is not inert — npm also installed: $(echo "$EXTRA" | tr '\n' ' ')"

# 5) The installed copy carries the whole agent-side product (claude-plugin.md §4b).
#    LICENSE only warns: the repo has none to package yet.
[ -s "$PLUGIN_ROOT/LICENSE" ] || echo "WARN: the package carries no LICENSE (claude-plugin.md §4b)" >&2
for f in \
  .claude-plugin/plugin.json package.json .mcp.json bin/server.js README.md \
  hooks/hooks.json \
  agents/figma-designer.md agents/figma-reviewer.md \
  skills/figma-design/SKILL.md skills/figma-feedback/SKILL.md skills/figma-reviewer/SKILL.md \
  skills/figma-connection/SKILL.md skills/figma-setup/SKILL.md \
  figma-plugin/manifest.json figma-plugin/dist/code.js figma-plugin/dist/ui.html; do
  [ -s "$PLUGIN_ROOT/$f" ] || fail "the installed package is missing (or has an empty) $f"
done

# 6) Manifest shape (inert + version lockstep) and the MCP server itself.
cat >"$STAGE/assert-server.mjs" <<'MJS'
// Assert the installed plugin copy: manifest shape, then a real MCP stdio round-trip.
import { readdir } from 'node:fs/promises'

const [root, wantVersion] = process.argv.slice(2)
const fail = m => {
  console.error(`ASSERT FAILED: ${m}`)
  process.exit(1)
}
const readJson = async p => JSON.parse(await Bun.file(p).text())

// --- manifest -------------------------------------------------------------
const pkg = await readJson(`${root}/package.json`)
if (pkg.name !== 'figma-agent-bridge') fail(`package.json name is ${pkg.name}`)
if (pkg.version !== wantVersion) fail(`package.json version ${pkg.version} !== ${wantVersion}`)
for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']) {
  if (pkg[k] && Object.keys(pkg[k]).length > 0) fail(`package.json declares ${k} — the package must be inert`)
}
for (const s of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']) {
  if (pkg.scripts?.[s]) fail(`package.json declares a ${s} script — the package must be inert`)
}
const bin = pkg.bin?.['figma-agent-bridge']
if (!bin || bin.replace(/^\.\//, '') !== 'bin/server.js') {
  fail(`package.json bin.figma-agent-bridge is ${bin} — expected bin/server.js`)
}
const manifest = await readJson(`${root}/.claude-plugin/plugin.json`)
if (manifest.version !== wantVersion) {
  fail(`plugin.json version ${manifest.version} !== package version ${wantVersion} (lockstep)`)
}
const mcp = await readJson(`${root}/.mcp.json`)
const entry = mcp.mcpServers?.['figma-agent-bridge']
if (entry?.command !== 'bun' || !entry.args?.[0]?.endsWith('/bin/server.js')) {
  fail(`.mcp.json does not launch bin/server.js with bun: ${JSON.stringify(entry)}`)
}

// --- the server -----------------------------------------------------------
const proc = Bun.spawn(['bun', `${root}/bin/server.js`], {
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'inherit',
  env: { ...process.env },
})
const send = msg => {
  proc.stdin.write(`${JSON.stringify(msg)}\n`)
  proc.stdin.flush()
}
const reader = proc.stdout.getReader()
const decoder = new TextDecoder()
let buf = ''
const nextMessage = async () => {
  for (;;) {
    const nl = buf.indexOf('\n')
    if (nl >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) return JSON.parse(line)
    } else {
      const { value, done } = await reader.read()
      if (done) throw new Error('the server closed stdout before answering')
      buf += decoder.decode(value, { stream: true })
    }
  }
}
const withTimeout = async (p, what) => {
  let timer
  try {
    return await Promise.race([
      p,
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), 30_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
const reply = async (id, what) => {
  for (;;) {
    const msg = await withTimeout(nextMessage(), what)
    if (msg.id === id) {
      if (msg.error) fail(`${what} returned an error: ${JSON.stringify(msg.error)}`)
      return msg.result
    }
  }
}

try {
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'assert-install', version: '0.0.0' },
    },
  })
  const init = await reply(1, 'initialize')
  if (init?.serverInfo?.name !== 'figma-agent-bridge') {
    fail(`initialize returned serverInfo ${JSON.stringify(init?.serverInfo)}`)
  }
  if (init.serverInfo.version !== wantVersion) {
    fail(`the server reports version ${init.serverInfo.version} !== ${wantVersion} (lockstep)`)
  }
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const list = await reply(2, 'tools/list')
  if (!Array.isArray(list?.tools) || list.tools.length === 0) fail('tools/list returned no tools')
  for (const t of ['connect', 'create_node', 'record_feedback']) {
    if (!list.tools.some(x => x.name === t)) fail(`tools/list is missing ${t}`)
  }

  // claude-plugin.md §9.6 — record_feedback writes a well-formed item to the store.
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'record_feedback',
      arguments: {
        category: 'bugs',
        title: 'install assertion probe',
        description: 'Written by the install assertion (dev-ops.md §4.2) in a throwaway HOME.',
      },
    },
  })
  const call = await reply(3, 'record_feedback')
  if (call?.isError) fail(`record_feedback failed: ${JSON.stringify(call.content)}`)
  const dir = `${process.env.HOME}/.figma-agent-bridge/feedbacks/bugs`
  const written = await readdir(dir).catch(() => [])
  if (!written.some(f => f.endsWith('.md'))) fail(`record_feedback wrote no Markdown item to ${dir}`)

  console.log(
    `MCP server ok: ${init.serverInfo.name} ${init.serverInfo.version}, ` +
      `${list.tools.length} tools, record_feedback wrote ${written.length} item(s)`,
  )
} finally {
  proc.kill()
}
MJS
bun "$STAGE/assert-server.mjs" "$PLUGIN_ROOT" "$VERSION"

echo "install assertion ok — $PKG@$VERSION ($MODE form)"
