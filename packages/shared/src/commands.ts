// commands.ts — the FROZEN server↔plugin command registry.
//
// One command string per `figma.*` capability (no convenience aliases).
// The plugin handler dispatches on the string; the server emits it inside
// the immutable WS envelope ({ id, command, params }). Renaming or
// dropping an entry fails commands.test.ts (the "never drop API items"
// guard) — the 51-tool catalogue in docs/specs/tool-surface.md
// is the source of truth.
//
// Count = 51:
//   Session 2 · Read-nodes 4 · Read-query 3 · Read-DS 4 · Read-meta 2 ·
//   Write-nodes 5 · Write-structure 10 · Write-pages 3 ·
//   Write-components 5 · Write-DS 8 · Write-meta 2 · Handoff 2 · Batch 1

export const COMMANDS = {
  // --- session (2) — transport is KEPT; only payloads change ---
  CONNECT: 'connect',
  STATUS: 'status',

  // --- read — nodes (4) ---
  INSPECT: 'inspect',
  GET_NODE: 'get_node',
  GET_NODES: 'get_nodes',
  EXPORT: 'export',

  // --- read — query & document (3) ---
  SEARCH: 'search',
  LIST_PAGES: 'list_pages',
  GET_SELECTION: 'get_selection',

  // --- read — design system (4) ---
  GET_STYLES: 'get_styles',
  GET_VARIABLES: 'get_variables',
  GET_COMPONENTS: 'get_components',
  LIST_FONTS: 'list_fonts',
  SEARCH_COMPONENTS: 'search_components',
  REINDEX: 'reindex',
  DOCUMENT_CHANGED: 'document_changed',
  PING: 'ping',

  // --- read — node metadata & prototype (2) ---
  GET_PLUGIN_DATA: 'get_plugin_data',
  GET_REACTIONS: 'get_reactions',

  // --- write — nodes (5) ---
  CREATE_NODE: 'create_node',
  CREATE_TREE: 'create_tree',
  CREATE_FROM_SVG: 'create_from_svg',
  CREATE_IMAGE: 'create_image',
  UPDATE_NODE: 'update_node',

  // --- write — structure (10) ---
  CLONE_NODE: 'clone_node',
  DELETE_NODE: 'delete_node',
  REPARENT_NODE: 'reparent_node',
  REORDER_CHILDREN: 'reorder_children',
  SET_SELECTION: 'set_selection',
  SET_FOCUS: 'set_focus',
  BOOLEAN_OP: 'boolean_op',
  FLATTEN: 'flatten',
  GROUP_NODES: 'group_nodes',
  TRANSFORM_GROUP: 'transform_group',

  // --- write — pages (3) ---
  CREATE_PAGE: 'create_page',
  SET_CURRENT_PAGE: 'set_current_page',
  DUPLICATE_PAGE: 'duplicate_page',

  // --- write — components & instances (5) ---
  CREATE_COMPONENT: 'create_component',
  UPDATE_COMPONENT: 'update_component',
  COMBINE_VARIANTS: 'combine_variants',
  SWAP_COMPONENT: 'swap_component',
  SET_INSTANCE: 'set_instance',

  // --- write — design system (8) ---
  CREATE_STYLES: 'create_styles',
  UPDATE_STYLES: 'update_styles',
  DELETE_STYLES: 'delete_styles',
  APPLY_STYLE: 'apply_style',
  CREATE_VARIABLES: 'create_variables',
  UPDATE_VARIABLES: 'update_variables',
  DELETE_VARIABLES: 'delete_variables',
  BIND_VARIABLE: 'bind_variable',

  // --- write — node metadata & prototype (2) ---
  SET_PLUGIN_DATA: 'set_plugin_data',
  SET_REACTIONS: 'set_reactions',

  // --- handoff (2) ---
  GET_ANNOTATIONS: 'get_annotations',
  SET_ANNOTATIONS: 'set_annotations',

  // --- batch (1) — server-side fan-out over the above ---
  BATCH: 'batch',
} as const

export type Command =
  (typeof COMMANDS)[keyof typeof COMMANDS]

/**
 * Commands that can cause NO `documentchange`, `currentpagechange` or
 * `selectionchange` — the change-feed's self-write scope opens no generation
 * for one and harvests neither its params nor its return
 * (docs/specs/change-feed.md, "Only a dispatch that can cause an event is
 * harvested").
 *
 * Enumerating the READS rather than the writers is deliberate. Retention
 * outlives the command by design, and a read's reach is large — `search`
 * returns hundreds of ids, `inspect({pageId})` names a page whose closure is
 * every node on it — so harvesting reads would put most of the document into
 * the touched set for minutes and the filter would drop the user's real edits
 * wholesale. That is silence, the direction the design refuses.
 *
 * `set_focus` is read-only by the PREDICATE, not by the doubt rule: its handler
 * only calls `figma.viewport.scrollAndZoomIntoView` and changes no selection,
 * so it can cause NO event and has nothing to suppress. It is filed under
 * "write — structure" in the registry above, which is why it looks doubtful and
 * is not. Classing it event-causing would fold the focused frame plus its
 * ENTIRE reflow closure into a retained generation — and set_focus is the
 * canonical hand-over command ("here is what I built"), so its reach would land
 * exactly on the subtree the user is about to start editing.
 *
 * Doubtful entries are classed EVENT-CAUSING, which costs only reach:
 *   - `create_image` registers an image and creates no node;
 *   - `create_variables` / `update_variables` / `delete_variables` —
 *     `documentchange` does not fire for variable edits (a known Figma gap);
 *   - `set_current_page` / `set_selection` mutate nothing yet DO fire the
 *     context events, and `set_current_page` is load-bearing: its `pageId`
 *     must reach the touched set or the agent's own page switch comes back
 *     as the user's;
 *   - `batch` is always event-causing because its ops may be.
 *
 * `connect`, `search_components` and `reindex` are answered server-side, and
 * `document_changed` / `ping` are protocol frames handled in the plugin's UI
 * realm: none reaches the sandbox dispatcher. They are listed only so the
 * classification is total over the registry.
 */
export const READ_ONLY_COMMANDS: ReadonlySet<string> =
  new Set<string>([
    COMMANDS.STATUS,
    COMMANDS.GET_SELECTION,
    COMMANDS.GET_NODE,
    COMMANDS.GET_NODES,
    COMMANDS.INSPECT,
    COMMANDS.EXPORT,
    COMMANDS.LIST_PAGES,
    COMMANDS.SEARCH,
    COMMANDS.GET_STYLES,
    COMMANDS.GET_VARIABLES,
    COMMANDS.GET_COMPONENTS,
    COMMANDS.LIST_FONTS,
    COMMANDS.GET_PLUGIN_DATA,
    COMMANDS.GET_REACTIONS,
    COMMANDS.GET_ANNOTATIONS,
    // not a read, but it mutates nothing and fires no event: viewport only
    COMMANDS.SET_FOCUS,
    // never reach the sandbox dispatcher
    COMMANDS.CONNECT,
    COMMANDS.SEARCH_COMPONENTS,
    COMMANDS.REINDEX,
    COMMANDS.DOCUMENT_CHANGED,
    COMMANDS.PING,
  ])

/** Doubt defaults to event-causing: a command wrongly classed read-only
 *  leaks its own writes back as user edits, which is the fail-open
 *  direction. */
export const isEventCausing = (command: string): boolean =>
  !READ_ONLY_COMMANDS.has(command)
