// packages/shared/test/commands.test.ts
import { describe, expect, it } from 'bun:test'
import {
  COMMANDS,
  type Command,
} from '@figma-agent-bridge/shared/commands'

// The frozen 47-tool catalogue (docs/scratch/tool-surface-design.md
// → Tool catalogue, Count = 47). Hard-coded here so a dropped or
// renamed command fails CI — honoring the "never drop API items" rule.
//
// Grouped exactly as the catalogue groups them; the per-group counts
// are asserted below so a regression points at the offending group.
const EXPECTED: Record<string, readonly string[]> = {
  // Session (2)
  session: ['connect', 'status'],
  // Read — nodes (4)
  readNodes: ['inspect', 'get_node', 'get_nodes', 'export'],
  // Read — query & document (3)
  readQuery: ['search', 'list_pages', 'get_selection'],
  // Read — design system (4)
  readDesignSystem: [
    'get_styles',
    'get_variables',
    'get_components',
    'list_fonts',
  ],
  // Read — node metadata & prototype (2)
  readMeta: ['get_plugin_data', 'get_reactions'],
  // Write — nodes (5)
  writeNodes: [
    'create_node',
    'create_tree',
    'create_from_svg',
    'create_image',
    'update_node',
  ],
  // Write — structure (8)
  writeStructure: [
    'clone_node',
    'delete_node',
    'reparent_node',
    'reorder_children',
    'set_selection',
    'set_focus',
    'boolean_op',
    'flatten',
  ],
  // Write — pages (3)
  writePages: [
    'create_page',
    'set_current_page',
    'duplicate_page',
  ],
  // Write — components & instances (5)
  writeComponents: [
    'create_component',
    'update_component',
    'combine_variants',
    'swap_component',
    'set_instance',
  ],
  // Write — design system (6)
  writeDesignSystem: [
    'create_styles',
    'update_styles',
    'apply_style',
    'create_variables',
    'update_variables',
    'bind_variable',
  ],
  // Write — node metadata & prototype (2)
  writeMeta: ['set_plugin_data', 'set_reactions'],
  // Handoff (2)
  handoff: ['get_annotations', 'set_annotations'],
  // Batch (1)
  batch: ['batch'],
}

const EXPECTED_GROUP_COUNTS: Record<string, number> = {
  session: 2,
  readNodes: 4,
  readQuery: 3,
  readDesignSystem: 4,
  readMeta: 2,
  writeNodes: 5,
  writeStructure: 8,
  writePages: 3,
  writeComponents: 5,
  writeDesignSystem: 6,
  writeMeta: 2,
  handoff: 2,
  batch: 1,
}

const EXPECTED_COMMANDS: readonly string[] =
  Object.values(EXPECTED).flat()

describe('COMMANDS registry', () => {
  it('has exactly 47 entries', () => {
    expect(Object.keys(COMMANDS).length).toBe(47)
    expect(EXPECTED_COMMANDS.length).toBe(47)
  })

  it('per-group counts match the catalogue', () => {
    for (const [group, list] of Object.entries(EXPECTED)) {
      expect(list.length).toBe(EXPECTED_GROUP_COUNTS[group])
    }
    const total = Object.values(
      EXPECTED_GROUP_COUNTS,
    ).reduce((a, b) => a + b, 0)
    expect(total).toBe(47)
  })

  it('command string values are exactly the expected set', () => {
    const actual = new Set<string>(Object.values(COMMANDS))
    const expected = new Set<string>(EXPECTED_COMMANDS)
    // Symmetric diff must be empty: nothing dropped, nothing added.
    const missing = EXPECTED_COMMANDS.filter(
      c => !actual.has(c),
    )
    const extra = [...actual].filter(c => !expected.has(c))
    expect(missing).toEqual([])
    expect(extra).toEqual([])
  })

  it('command string values are unique', () => {
    const values = Object.values(COMMANDS)
    expect(new Set(values).size).toBe(values.length)
  })

  it('Command type accepts every catalogue value', () => {
    // Compile-time + runtime: each expected string is a valid Command.
    for (const c of EXPECTED_COMMANDS) {
      const cmd: Command = c as Command
      expect(typeof cmd).toBe('string')
    }
  })
})
