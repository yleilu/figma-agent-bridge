// commands.ts — the FROZEN server↔plugin command registry.
//
// One command string per `figma.*` capability (no convenience aliases).
// The plugin handler dispatches on the string; the server emits it inside
// the immutable WS envelope ({ id, command, params }). Renaming or
// dropping an entry fails commands.test.ts (the "never drop API items"
// guard) — the 48-tool catalogue in docs/specs/tool-surface.md
// is the source of truth.
//
// Count = 48:
//   Session 2 · Read-nodes 4 · Read-query 3 · Read-DS 4 · Read-meta 2 ·
//   Write-nodes 5 · Write-structure 8 · Write-pages 3 ·
//   Write-components 5 · Write-DS 7 · Write-meta 2 · Handoff 2 · Batch 1

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

  // --- write — structure (8) ---
  CLONE_NODE: 'clone_node',
  DELETE_NODE: 'delete_node',
  REPARENT_NODE: 'reparent_node',
  REORDER_CHILDREN: 'reorder_children',
  SET_SELECTION: 'set_selection',
  SET_FOCUS: 'set_focus',
  BOOLEAN_OP: 'boolean_op',
  FLATTEN: 'flatten',

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

  // --- write — design system (7) ---
  CREATE_STYLES: 'create_styles',
  UPDATE_STYLES: 'update_styles',
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
