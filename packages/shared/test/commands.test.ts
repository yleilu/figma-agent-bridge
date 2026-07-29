// packages/shared/test/commands.test.ts
import { describe, expect, it } from 'bun:test'
import {
  COMMANDS,
  READ_ONLY_COMMANDS,
  isEventCausing,
  type Command,
} from '@figma-agent-bridge/shared/commands'

// The frozen tool catalogue (docs/specs/tool-surface.md → the 53-tool
// surface: the 51 base tools + the 2 component-index tools). Hard-coded
// here so a dropped or renamed command fails CI — honoring the "never
// drop API items" rule. document_changed and ping are internal
// protocol commands (not MCP tools) and are tracked separately in
// INTERNAL below.
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
  // Write — structure (10)
  writeStructure: [
    'clone_node',
    'delete_node',
    'reparent_node',
    'reorder_children',
    'set_selection',
    'set_focus',
    'boolean_op',
    'flatten',
    'group_nodes',
    'transform_group',
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
  // Write — design system (8)
  writeDesignSystem: [
    'create_styles',
    'update_styles',
    'delete_styles',
    'apply_style',
    'create_variables',
    'update_variables',
    'delete_variables',
    'bind_variable',
  ],
  // Write — node metadata & prototype (2)
  writeMeta: ['set_plugin_data', 'set_reactions'],
  // Handoff (2)
  handoff: ['get_annotations', 'set_annotations'],
  // Batch (1)
  batch: ['batch'],
  // Component index (2)
  componentIndex: ['search_components', 'reindex'],
}

// Non-tool protocol commands: wire commands that are not MCP tools.
// document_changed is the unsolicited plugin→server freshness push.
// ping is the app-level connection-liveness heartbeat (B2 wire change).
const INTERNAL: readonly string[] = [
  'document_changed',
  'ping',
]

const EXPECTED_GROUP_COUNTS: Record<string, number> = {
  session: 2,
  readNodes: 4,
  readQuery: 3,
  readDesignSystem: 4,
  readMeta: 2,
  writeNodes: 5,
  writeStructure: 10,
  writePages: 3,
  writeComponents: 5,
  writeDesignSystem: 8,
  writeMeta: 2,
  handoff: 2,
  batch: 1,
  componentIndex: 2,
}

const EXPECTED_COMMANDS: readonly string[] = [
  ...Object.values(EXPECTED).flat(),
  ...INTERNAL,
]

describe('COMMANDS registry', () => {
  it('has exactly 55 entries (53 tools + 2 internal)', () => {
    expect(Object.keys(COMMANDS).length).toBe(55)
    expect(EXPECTED_COMMANDS.length).toBe(55)
  })

  it('per-group counts match the catalogue', () => {
    for (const [group, list] of Object.entries(EXPECTED)) {
      expect(list.length).toBe(EXPECTED_GROUP_COUNTS[group])
    }
    const total = Object.values(
      EXPECTED_GROUP_COUNTS,
    ).reduce((a, b) => a + b, 0)
    expect(total).toBe(53)
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

  it('PING command exists', () => {
    expect(COMMANDS.PING).toBe('ping')
  })

  // NO version assertion here, deliberately. The handshake compares
  // major.minor, so a breaking wire change does bump the MINOR — but the
  // version is a single number stamped across every artifact by the release
  // pipeline from the release PR's label, never edited on a branch
  // (dev-ops.md, "Version lockstep"). Pinning a number here would make this
  // suite fail on every release that is not the one it was written for, and
  // would encode the stamp as a branch's job. What this change owes is that
  // the breaking frame is enumerated in version-handshake.md, and that its
  // release PR carries `release:minor`.
})

// The event-causing axis (change-feed.md, "Only a dispatch that can cause an
// event is harvested"). A command wrongly classed READ-ONLY leaks its own
// writes back as user edits — the fail-open direction — so the enumerated set
// is the read-only one and doubt defaults to event-causing.
describe('event-causing classification', () => {
  it('is TOTAL and DISJOINT over the registry', () => {
    // Total: every command lands on one side or the other by construction,
    // and the guard that matters is that READ_ONLY_COMMANDS holds nothing
    // that is not a real command — a typo there silently classes a writer
    // as a read. This is the "never drop API items" rule on the new axis:
    // a command added later without a classification decision shows up here.
    const values = new Set<string>(Object.values(COMMANDS))
    const strays = [...READ_ONLY_COMMANDS].filter(
      c => !values.has(c),
    )
    expect(strays).toEqual([])
    for (const c of values) {
      expect(isEventCausing(c)).toBe(
        !READ_ONLY_COMMANDS.has(c),
      )
    }
  })

  it('is exactly the 16 event-free switch entries + the 5 that never dispatch', () => {
    // The 16 are the entries in code.ts's switch that emit no
    // documentchange / currentpagechange / selectionchange. Their REACH is
    // what makes this load-bearing: `search` returns hundreds of ids and
    // `inspect({pageId})` names a page whose closure is every node on it.
    // 15 are pure reads; `set_focus` is the sixteenth — it is filed under
    // "write — structure" in the registry but its handler only calls
    // figma.viewport.scrollAndZoomIntoView, which no listener observes.
    // The other 5 have no switch case at all — connect / search_components /
    // reindex are server-side and document_changed / ping are protocol
    // frames handled in the UI realm — and are listed only so this test is
    // total over the registry.
    expect([...READ_ONLY_COMMANDS].sort()).toEqual(
      [
        COMMANDS.CONNECT,
        COMMANDS.SET_FOCUS,
        COMMANDS.DOCUMENT_CHANGED,
        COMMANDS.EXPORT,
        COMMANDS.GET_ANNOTATIONS,
        COMMANDS.GET_COMPONENTS,
        COMMANDS.GET_NODE,
        COMMANDS.GET_NODES,
        COMMANDS.GET_PLUGIN_DATA,
        COMMANDS.GET_REACTIONS,
        COMMANDS.GET_SELECTION,
        COMMANDS.GET_STYLES,
        COMMANDS.GET_VARIABLES,
        COMMANDS.INSPECT,
        COMMANDS.LIST_FONTS,
        COMMANDS.LIST_PAGES,
        COMMANDS.PING,
        COMMANDS.REINDEX,
        COMMANDS.SEARCH,
        COMMANDS.SEARCH_COMPONENTS,
        COMMANDS.STATUS,
      ].sort(),
    )
  })

  it.each([
    COMMANDS.GET_NODE,
    COMMANDS.INSPECT,
    COMMANDS.SEARCH,
    COMMANDS.EXPORT,
    COMMANDS.GET_COMPONENTS,
    COMMANDS.LIST_PAGES,
    // NOT the doubt rule — the predicate. set_focus moves the viewport only
    // (figma.viewport.scrollAndZoomIntoView) and changes no selection, so it
    // can cause NO event and has nothing to suppress. Classing it
    // event-causing would fold the focused frame plus its ENTIRE reflow
    // closure into a retained generation, and set_focus is the canonical
    // hand-over command ("here is what I built") — precisely the moment the
    // user starts editing what it points at.
    COMMANDS.SET_FOCUS,
  ])('%s is NOT event-causing', c => {
    expect(isEventCausing(c)).toBe(false)
  })

  it.each([
    // mutate nothing, yet fire currentpagechange / selectionchange —
    // set_current_page load-bearing: its pageId must reach touched() or the
    // agent's own page switch returns as the user's.
    COMMANDS.SET_CURRENT_PAGE,
    COMMANDS.SET_SELECTION,
    // its ops may be, and it is refcounted, so it spends ONE generation
    COMMANDS.BATCH,
    // registers an image, creates no node — doubt rule
    COMMANDS.CREATE_IMAGE,
    // documentchange does not fire for variable edits — doubt rule
    COMMANDS.CREATE_VARIABLES,
  ])('%s IS event-causing', c => {
    expect(isEventCausing(c)).toBe(true)
  })

  it('defaults an UNKNOWN command to event-causing', () => {
    // The conservative direction: a leak is a false nudge, a wrong read is
    // silence.
    expect(isEventCausing('nonexistent_command')).toBe(true)
  })
})
