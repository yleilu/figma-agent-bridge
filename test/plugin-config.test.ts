import { describe, it, expect } from 'bun:test'
const root = new URL('../', import.meta.url).pathname // test/ → repo root
const read = (p: string) => Bun.file(`${root}${p}`).json()

describe('plugin config', () => {
  it('marketplace lists the plugin at ./plugin', async () => {
    const m = await read('.claude-plugin/marketplace.json')
    expect(m.name).toBe('figma-agent-bridge')
    expect(
      m.plugins.some((p: any) => p.source === './plugin'),
    ).toBe(true)
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
  it('marketplace + plugin versions agree (bump together)', async () => {
    const m = await read('.claude-plugin/marketplace.json')
    const p = await read(
      'plugin/.claude-plugin/plugin.json',
    )
    expect(m.plugins[0].version).toBe(p.version)
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
})
