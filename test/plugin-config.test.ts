import { describe, it, expect } from 'bun:test'
const root = new URL('../', import.meta.url).pathname // test/ → repo root
const read = (p: string) => Bun.file(`${root}${p}`).json()
const exists = (p: string) =>
  Bun.file(`${root}${p}`).exists()

// A non-path plugin source is a nested OBJECT carrying its own
// `source` discriminator. The flat form (`source: 'npm'` with
// sibling package/version) is rejected by the host —
// `claude plugin validate` reports
// "plugins.0.source: Invalid input" and warns that the sibling
// `package` field is ignored — so the shape is asserted, not
// merely tolerated.
const sourceOf = (entry: any) => {
  expect(typeof entry.source).toBe('object')
  return entry.source
}

const pluginEntry = (m: any) =>
  m.plugins.find(
    (p: any) => p.name === 'figma-agent-bridge',
  ) ?? m.plugins[0]

describe('plugin config', () => {
  it('marketplace sources the plugin from npm', async () => {
    const m = await read('.claude-plugin/marketplace.json')
    expect(m.name).toBe('figma-agent-bridge')
    const src = sourceOf(pluginEntry(m))
    expect(src.source).toBe('npm')
    expect(src.package).toBe('figma-agent-bridge')
    expect(src.version).toMatch(/^\d+\.\d+\.\d+/)
  })
  it('plugin.json has a name + version', async () => {
    const p = await read(
      'plugin/.claude-plugin/plugin.json',
    )
    expect(p.name).toBe('figma-agent-bridge')
    expect(p.version).toMatch(/^\d+\.\d+\.\d+/)
  })
  it('.mcp.json runs the bundle via bun', async () => {
    const c = await read('plugin/.mcp.json')
    const entry = c.mcpServers['figma-agent-bridge']
    expect(entry.command).toBe('bun')
    expect(entry.args).toEqual([
      '${CLAUDE_PLUGIN_ROOT}/bin/server.js',
    ])
  })
  it('plugin.json, package.json + marketplace versions agree (one version of record)', async () => {
    const m = await read('.claude-plugin/marketplace.json')
    const p = await read(
      'plugin/.claude-plugin/plugin.json',
    )
    // root package.json is the version-of-record everything
    // else is stamped from (release:stamp)
    const rootPkg = await read('package.json')
    expect(p.version).toBe(rootPkg.version)
    const entry = pluginEntry(m)
    expect(entry.version).toBe(p.version)
    // the npm source pins the exact version to fetch
    expect(sourceOf(entry).version).toBe(p.version)
    // the published package's npm metadata — the fourth leg of
    // the lockstep
    const npmPkg = await read('plugin/package.json')
    expect(npmPkg.version).toBe(p.version)
  })
  it('the published package is inert (no deps, no install scripts, no lockfile)', async () => {
    const npmPkg = await read('plugin/package.json')
    // deps or a lockfile trigger the host's post-copy
    // dependency install, whose failure is silent
    expect(npmPkg.dependencies).toBeUndefined()
    expect(npmPkg.optionalDependencies).toBeUndefined()
    expect(npmPkg.peerDependencies).toBeUndefined()
    expect(npmPkg.scripts).toBeUndefined()
    expect(await exists('plugin/bun.lock')).toBe(false)
    expect(await exists('plugin/package-lock.json')).toBe(
      false,
    )
    // a bin entry is only a symlink — it triggers nothing
    expect(npmPkg.bin).toEqual({
      'figma-agent-bridge': 'bin/server.js',
    })
  })
  it('registers the PreToolUse identity hook for both tool namespaces', async () => {
    const hooks = await read('plugin/hooks/hooks.json')
    const pre = hooks.hooks.PreToolUse
    expect(Array.isArray(pre)).toBe(true)
    const entry = pre[0]
    // matcher catches BOTH the dev namespace and the plugin-install namespace,
    // and NOT the unrelated mcp__figma__ / mcp__FigmaDesignBuilder__ servers.
    expect(entry.matcher).toBe(
      'mcp__(figma-bridge|plugin_figma-agent-bridge_figma-agent-bridge)__.*',
    )
    const re = new RegExp(entry.matcher)
    expect(re.test('mcp__figma-bridge__update_node')).toBe(
      true,
    )
    expect(
      re.test(
        'mcp__plugin_figma-agent-bridge_figma-agent-bridge__update_node',
      ),
    ).toBe(true)
    expect(re.test('mcp__figma__get_code')).toBe(false)
    expect(
      re.test('mcp__FigmaDesignBuilder__create_frame'),
    ).toBe(false)
    expect(entry.hooks[0].command).toContain(
      'hooks/identity',
    )
  })

  it('the identity hook script exists and is executable', async () => {
    const { stat } = await import('node:fs/promises')
    const st = await stat(`${root}plugin/hooks/identity`)
    expect(st.mode & 0o100).toBeGreaterThan(0) // owner-executable bit set
  })

  it('registers the Stop/SubagentStop/SessionEnd lifecycle hooks', async () => {
    const hooks = await read('plugin/hooks/hooks.json')
    const cases: [string, string][] = [
      ['Stop', 'hooks/stop'],
      ['SubagentStop', 'hooks/subagent-stop'],
      ['SessionEnd', 'hooks/session-end'],
    ]
    for (const [event, scriptSuffix] of cases) {
      const entries = hooks.hooks[event]
      expect(Array.isArray(entries)).toBe(true)
      const entry = entries[0]
      expect(entry.hooks[0].command).toContain(scriptSuffix)
      expect(entry.hooks[0].async).toBe(false)
      expect(entry.hooks[0].timeout).toBe(10)
    }
  })

  it('the lifecycle hook scripts exist and are executable', async () => {
    const { stat } = await import('node:fs/promises')
    for (const script of [
      'stop',
      'subagent-stop',
      'session-end',
    ]) {
      const st = await stat(`${root}plugin/hooks/${script}`)
      expect(st.mode & 0o100).toBeGreaterThan(0) // owner-executable bit set
    }
  })
})
