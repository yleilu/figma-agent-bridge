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
})
