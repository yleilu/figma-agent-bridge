import type {
  BroadcastMessage,
  ChannelMessage,
  CommandMessage,
  JoinMessage,
  RegisterMessage,
  SystemMessage,
} from '@figma-agent-bridge/shared/types'
import {
  APP_VERSION,
  COMMANDS,
  isTargetMismatch,
  targetGuardError,
} from '@figma-agent-bridge/shared'
import cardFixture from '../fixtures/card-node-raw.json'

const MOCK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="red" width="100" height="100"/></svg>'

const MOCK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// FAITHFUL mirror of the figma-plugin resolveInstanceProps helper (#11): the
// real plugin resolves friendly component-property NAMES to the EXACT keys
// setProperties requires (TEXT/BOOLEAN/INSTANCE_SWAP → "<name>#<id>"; VARIANT →
// bare name) against the instance's current keys, warning + skipping ambiguous
// or unknown names. The mock inlines the same logic (it cannot import across
// packages) keeping the wording byte-faithful so behavioral tests assert the
// real plugin contract. Default current-keys for a modeled instance: VARIANT
// "Size" + BOOLEAN "Disabled" pass through bare/exact as today's tests expect;
// "Label#1:0" lets a friendly "Label" resolve; "Icon#1:0"/"IconColor#2:0"
// exercise the exact name-segment match (Icon != IconColor).
const MOCK_INSTANCE_KEYS = [
  'Size',
  'Disabled',
  'Label#1:0',
  'Icon#1:0',
  'IconColor#2:0',
]

const mockResolveInstanceProps = (
  input: Record<string, string | boolean>,
  currentKeys: string[],
): {
  resolved: Record<string, string | boolean>
  warnings: string[]
} => {
  const resolved: Record<string, string | boolean> = {}
  const warnings: string[] = []
  const nameSegment = (key: string): string => {
    const i = key.indexOf('#')
    return i >= 0 ? key.slice(0, i) : key
  }
  for (const inputKey of Object.keys(input)) {
    if (currentKeys.includes(inputKey)) {
      resolved[inputKey] = input[inputKey]
      continue
    }
    const matches = currentKeys.filter(
      key => nameSegment(key) === inputKey,
    )
    if (matches.length === 1) {
      resolved[matches[0]] = input[inputKey]
    } else if (matches.length > 1) {
      warnings.push(
        "ambiguous property name '" +
          inputKey +
          "' — matches " +
          matches.join(', ') +
          '; pass the exact key',
      )
    } else {
      warnings.push(
        "no component property named '" + inputKey + "'",
      )
    }
  }
  return { resolved, warnings }
}

type MockPluginOptions = {
  relayUrl: string
  channel: string
  documentName?: string
  pageName?: string
  /**
   * Raw exports of the current selection. INSPECT with no nodeId/pageId honors
   * this the way the real plugin does: >1 entry → return the ARRAY (forest);
   * exactly 1 → return that single export; empty/undefined → fall back to the
   * default single-node export (representing the current page).
   */
  selection?: Record<string, unknown>[]
  /**
   * When true, get_components models a document containing a ComponentSet with
   * conflicting variants. The real plugin THROWS ("Component set for node has
   * existing errors") while projecting that set's variant axes; the fixed
   * plugin guards each set individually so the bad set degrades to a warnings[]
   * entry and the good components still return. Byte-faithful to the real
   * plugin's degraded reply shape + message (Bug A).
   */
  componentSetError?: boolean
  /** defaults to APP_VERSION; set to a different value to test mismatch */
  version?: string
  /**
   * The plugin's stable figma.fileKey. Real plugin reads figma.fileKey (with
   * enablePrivatePluginApi) → a real key for a saved file, null/undefined for a
   * never-saved file. Default null = the never-saved-file case (registers null,
   * and the identity guard can't verify — see handleBroadcast).
   */
  fileKey?: string | null
}

type MockPlugin = {
  start: () => Promise<void>
  stop: () => void
  // Timing knobs (L5 — for the L6 watchdog tests only): DEFAULT is unchanged
  // synchronous auto-answer, so every pre-existing mock-based test is
  // unaffected unless a test opts in below.
  //
  // setSilent(true): withhold EVERY reply, including ping — models a fully
  // dead plugin/socket (the watchdog should eventually declare it dead).
  setSilent: (silent: boolean) => void
  // delayCommand(command, ms): defer that command's reply by `ms` via
  // setTimeout, WITHOUT delaying ping — models a slow-but-alive plugin (busy
  // main thread, but the UI iframe's ping-answering event loop stays free),
  // faithful to the real plugin's ping bypass in useRelay.ts.
  delayCommand: (command: string, delayMs: number) => void
  // pings(): count of liveness pings this plugin has RECEIVED (incremented on
  // receipt, before the silent gate). Lets the L6 watchdog tests assert the
  // fast path never armed the watchdog (zero pings).
  pings: () => number
}

export const createMockPlugin = (
  options: MockPluginOptions,
): MockPlugin => {
  const {
    relayUrl,
    channel,
    documentName = 'Mock Document',
    pageName = 'Page 1',
    selection,
    componentSetError = false,
    version = APP_VERSION,
    fileKey = null,
  } = options

  let ws: WebSocket | null = null

  // Stateful shared-pluginData store for the agent `context` field, faithful to
  // the real plugin's set/getSharedPluginData semantics: a write of a non-empty
  // string persists; an empty/whitespace string CLEARS the key (Figma treats ''
  // as delete); an omitted value on update PRESERVES the prior value. Keyed by
  // node id, per-plugin-instance so it resets between tests. The reads
  // (get_node/get_nodes/inspect) attach `context` back onto the fixture only
  // when present, and the get_components/get_styles fixtures below carry a raw
  // `description` (+ optional `context`) so the read surfacing is exercised e2e.
  const sharedContext = new Map<string, string>()

  // L5 timing knobs — TEST INFRASTRUCTURE for the L6 watchdog tests only.
  // `silent` withholds every reply (incl. ping); `delayedCommands` maps a
  // command string to a reply-delay in ms (ping is never delayed). Both
  // default to off, so every pre-existing mock-based test keeps the
  // synchronous auto-answer it was written against.
  let silent = false
  const delayedCommands = new Map<string, number>()
  // Count of liveness pings received (see MockPlugin.pings). Incremented on
  // receipt regardless of the silent gate, so a silent-dead plugin still
  // records the watchdog's probes.
  let pingCount = 0

  // runCommand mirrors the real plugin's handleCommand: dispatch on the command
  // string and return { result?, error? }. Pulled out of handleBroadcast so the
  // BATCH case can re-dispatch each op through it (the same way the real plugin's
  // BATCH case loops handleCommand) and so handleBroadcast just wraps the reply
  // in the relay frame.
  const runCommand = (
    command: string,
    params: Record<string, unknown> | undefined,
  ): { result?: unknown; error?: string } => {
    const cmd = { command, params } as CommandMessage
    let result: unknown = undefined
    let error: string | undefined = undefined

    switch (cmd.command) {
      // batch (M3-D): loop the converted ops through runCommand in array order,
      // collecting a per-op {ok,result|error} — partial success, one failure
      // does not abort the rest. Mirrors the real plugin's BATCH case.
      case 'batch': {
        const batchOps =
          (cmd.params?.ops as
            | {
                op: string
                params: Record<string, unknown>
              }[]
            | undefined) ?? []
        const results = batchOps.map(entry => {
          const r = runCommand(entry.op, entry.params)
          return r.error !== undefined
            ? { ok: false, error: r.error }
            : { ok: true, result: r.result }
        })
        result = { results }
        break
      }

      // ping (connection-liveness.md, L5): faithful to the real plugin, which
      // now answers ping (useRelay.ts) — a bare liveness ack, no document
      // state. handleBroadcast special-cases ping ABOVE this switch (bypasses
      // the identity guard + the delay map, mirroring the real plugin's
      // ping-answered-in-the-UI-iframe bypass), but it is still routed through
      // runCommand (incl. via BATCH) so the reply shape stays centralized here.
      case COMMANDS.PING:
        result = { ok: true }
        break

      case 'get_document_info':
        result = {
          name: documentName,
          currentPage: {
            id: 'page:1',
            name: pageName,
          },
        }
        break

      // status (D1): the LIVE context — current page, selection, viewport. The
      // server adds connection state (connected/channel); this returns only the
      // plugin-known live context, faithful to the real plugin's STATUS case.
      case 'status':
        result = {
          currentPage: { id: 'page:1', name: pageName },
          selection: [
            { id: '1:42', name: 'Card', type: 'FRAME' },
          ],
          viewport: {
            center: { x: 100, y: 200 },
            zoom: 1.5,
          },
        }
        break

      // close_plugin: internal lifecycle command (figma.closePlugin in the real
      // plugin). The mock can't close itself; mirror the real ack shape.
      case 'close_plugin':
        result = { closing: true }
        break

      case 'get_selection':
        result = [
          { id: '1:42', name: 'Card', type: 'FRAME' },
        ]
        break

      // set_selection: model the real plugin's resolution + T7 honesty. An id
      // prefixed `missing:` does not resolve (skipped); `xpage:` resolves but
      // lives on another page (cross-page degrade — warned, NOT thrown); the
      // rest select. selectedCount is the count actually selected, and dropped
      // ids ride back in warnings[] so a partial is never silent.
      case 'set_selection': {
        const ids = (cmd.params?.nodeIds as string[]) ?? []
        const ssSkipped = ids.filter(id =>
          id.startsWith('missing:'),
        )
        const ssOffPage = ids.filter(id =>
          id.startsWith('xpage:'),
        )
        const ssSelected =
          ids.length - ssSkipped.length - ssOffPage.length
        const ssWarnings: string[] = []
        if (ssSkipped.length > 0) {
          ssWarnings.push(
            'skipped ' +
              ssSkipped.length +
              ' unresolved id(s): ' +
              ssSkipped.join(', '),
          )
        }
        if (ssOffPage.length > 0) {
          ssWarnings.push(
            'skipped ' +
              ssOffPage.length +
              ' cross-page id(s) not on the current page: ' +
              ssOffPage.join(', '),
          )
        }
        result = {
          selectedCount: ssSelected,
          warnings: ssWarnings,
        }
        break
      }

      case 'get_node': {
        // M14: the sentinel nodeId 'remote-inst:1' serves a remote-INSTANCE
        // raw export (componentId + componentKey + componentRemote:true) so the
        // reader's M14 projection and the e2e round-trip are testable headlessly.
        const gnNodeId = cmd.params?.nodeId as
          | string
          | undefined
        if (gnNodeId === 'remote-inst:1') {
          result = {
            id: 'remote-inst:1',
            name: 'LibraryButton',
            type: 'INSTANCE',
            absoluteBoundingBox: {
              x: 0,
              y: 0,
              width: 120,
              height: 40,
            },
            fills: [],
            children: [],
            componentId: 'C:remote-lib-123',
            componentKey: 'lib-btn-key-456',
            componentRemote: true,
          }
        } else {
          result = {
            ...cardFixture,
            ...(sharedContext.get(cardFixture.id)
              ? {
                  context: sharedContext.get(
                    cardFixture.id,
                  ),
                }
              : {}),
          }
        }
        break
      }

      // inspect serializes the same raw export get_node consumes; the server's
      // read model (truncate-tree + budget) decides what survives. With no
      // nodeId/pageId it targets the current selection the way the real plugin
      // does: >1 selected → an ARRAY of raw exports (the server wraps them in a
      // SELECTION forest); exactly 1 → that single export; empty → the default
      // single-node export (representing the current page).
      case 'inspect': {
        const targeted =
          cmd.params?.nodeId !== undefined ||
          cmd.params?.pageId !== undefined
        if (
          !targeted &&
          selection &&
          selection.length > 1
        ) {
          result = selection
        } else if (
          !targeted &&
          selection &&
          selection.length === 1
        ) {
          ;[result] = selection
        } else {
          result = {
            ...cardFixture,
            ...(sharedContext.get(cardFixture.id)
              ? {
                  context: sharedContext.get(
                    cardFixture.id,
                  ),
                }
              : {}),
          }
        }
        break
      }

      case 'get_nodes':
        result = [
          {
            ...cardFixture,
            ...(sharedContext.get(cardFixture.id)
              ? {
                  context: sharedContext.get(
                    cardFixture.id,
                  ),
                }
              : {}),
          },
        ]
        break

      // list_pages: Rule A document + page enumeration ({docName, results}).
      case 'list_pages':
        result = {
          docName: documentName,
          results: [
            {
              id: 'page:1',
              name: pageName,
              isCurrent: true,
              childCount: 3,
            },
          ],
        }
        break

      // get_styles: the NEW server-expected shape — each entry carries a raw
      // figma VALUE the server renders to a view atom (paint→hex, text→font,
      // effect→head). Real value shapes so the e2e can assert atom rendering.
      case 'get_styles':
        result = {
          paint: [
            {
              id: 'S:1',
              name: 'Brand/Primary',
              // Surface 2: description surfaces read-only on styles (no context).
              description: 'Brand primary blue',
              value: {
                type: 'SOLID',
                color: { r: 0.231, g: 0.51, b: 0.965 },
              },
            },
          ],
          text: [
            {
              id: 'S:2',
              name: 'Heading',
              description: 'Section heading type',
              value: {
                family: 'Inter',
                style: 'Bold',
                size: 32,
                lineHeight: { value: 40, unit: 'PIXELS' },
              },
            },
          ],
          effect: [
            {
              id: 'S:3',
              name: 'Card Shadow',
              value: {
                type: 'DROP_SHADOW',
                color: { r: 0, g: 0, b: 0, a: 0.1 },
                offset: { x: 0, y: 4 },
                radius: 12,
                spread: 0,
              },
            },
          ],
          grid: [
            {
              id: 'S:4',
              name: 'Layout/Columns',
              value: {
                pattern: 'COLUMNS',
                count: 12,
                gutterSize: 16,
                sectionSize: 64,
                alignment: 'STRETCH',
              },
            },
          ],
        }
        break

      // get_components: the NEW richer shape — key + variantAxes + `properties`
      // + defaults per local entry, key + library + instancesCount per remote
      // entry. `properties` is the SAME {id,name,type,defaultValue,
      // variantOptions?} array shape + key update_component emits (read == write,
      // T2): each entry's `id` is the CANONICAL property id and `name` is the
      // part before "#".
      case 'get_components': {
        const goodSet = {
          id: '1:10',
          name: 'Button',
          key: 'btn-key',
          type: 'COMPONENT_SET',
          page: 'Main',
          // Surface 2: description surfaces read-only on every entry; context is
          // local-pluginData (frontmatter → server-sliced contextSummary).
          description: 'Primary action button',
          context:
            '---\npurpose: primary CTA\nrole: button/primary\n---\n## Notes\nUse for the main action only.',
          properties: [
            {
              id: 'Variant',
              name: 'Variant',
              type: 'VARIANT',
              defaultValue: 'Primary',
              variantOptions: ['Primary', 'Secondary'],
            },
            {
              id: 'Disabled#2:0',
              name: 'Disabled',
              type: 'BOOLEAN',
              defaultValue: false,
            },
          ],
          variantAxes: {
            Variant: ['Primary', 'Secondary'],
          },
          defaults: {
            Variant: 'Primary',
            Disabled: false,
          },
        }
        // T10 (the live timeout fix): the remote/library scan walks EVERY
        // instance's mainComponent — O(document) — and the real plugin SKIPS it
        // entirely unless includeRemote is set. Model that faithfully: default
        // (includeRemote falsy) → remote is empty (no scan ran); includeRemote
        // true → the library components are discovered.
        const includeRemote =
          cmd.params?.includeRemote === true
        const remote = includeRemote
          ? [
              {
                key: 'remote-key',
                name: 'Icon',
                library: 'Lib',
                instancesCount: 3,
              },
            ]
          : []
        // Faithful degrade model (Bug A): with componentSetError, the document
        // contains a ComponentSet whose per-set variant projection THROWS in the
        // real plugin ("Component set for node has existing errors"). The fixed
        // plugin guards each set individually → the bad set is included WITHOUT
        // its variant info and a warnings[] entry names the set + reason; the
        // good set still returns intact. Byte-faithful to the real plugin's
        // degraded reply shape + message.
        if (componentSetError) {
          result = {
            local: [
              goodSet,
              {
                id: '3:7',
                name: 'Broken',
                key: 'broken-key',
                type: 'COMPONENT_SET',
                page: 'Main',
              },
            ],
            remote,
            warnings: [
              'component set "Broken" (3:7) skipped variant projection: Error: in get_variantProperties: Component set for node has existing errors',
            ],
          }
          break
        }
        result = {
          local: [goodSet],
          remote,
        }
        break
      }

      // list_fonts: families grouped by the plugin ({ family, styles }).
      case 'list_fonts':
        result = {
          results: [
            {
              family: 'Inter',
              styles: ['Regular', 'Bold'],
            },
            { family: 'Roboto', styles: ['Regular'] },
          ],
        }
        break

      // get_reactions: a single ON_CLICK → NAVIGATE reaction.
      case 'get_reactions':
        result = {
          nodeId: cmd.params?.nodeId as string,
          reactions: [
            {
              trigger: { type: 'ON_CLICK' },
              actions: [
                {
                  type: 'NODE',
                  destinationId: '1:99',
                  navigation: 'NAVIGATE',
                },
              ],
            },
          ],
        }
        break

      // get_plugin_data: pluginData always; sharedPluginData only with a
      // namespace. Faithful to the real plugin: a `degrade:` nodeId models a
      // node-not-found degrade — empty pluginData + a 'Node not found' warning
      // (RESOLVES, never a WS reject), so the warnings-forwarding branch is
      // exercised over the relay (T7).
      case 'get_plugin_data': {
        const pdNodeId = cmd.params?.nodeId as string
        if (pdNodeId?.startsWith('degrade:')) {
          result = {
            nodeId: pdNodeId,
            pluginData: {},
            warnings: ['Node not found: ' + pdNodeId],
          }
        } else {
          result = {
            nodeId: pdNodeId,
            pluginData: { foo: 'bar' },
            sharedPluginData: cmd.params?.namespace
              ? { baz: 'qux' }
              : undefined,
          }
        }
        break
      }

      // get_annotations: happy path (Rule A). Faithful to the real plugin:
      //   • an explicit, unresolvable nodeId (`degrade:` prefix) RESOLVES to a
      //     {results:[], warnings:['Node not found: …']} not-found degrade (T7);
      //   • per-node nodeId TAGGING happens ONLY on a selection-based multi-read
      //     (NO explicit nodeId, 2+ selected nodes) — the plugin tags each
      //     annotation with its source node so the flat result stays
      //     attributable. An EXPLICIT nodeId read returns bare annotations.
      //     (Previously the mock keyed tagging off an explicit `multi:` nodeId,
      //     the OPPOSITE of the real plugin.)
      case 'get_annotations': {
        const annNodeId = cmd.params?.nodeId as
          | string
          | undefined
        if (annNodeId?.startsWith('degrade:')) {
          result = {
            results: [],
            truncated: false,
            warnings: ['Node not found: ' + annNodeId],
          }
        } else if (annNodeId === undefined) {
          // No explicit id → read the current selection. Model a >1-node
          // selection: each annotation is TAGGED with its source nodeId.
          result = {
            results: [
              {
                label: 'Check spacing',
                categoryId: 'cat:1',
                nodeId: '1:42',
              },
              {
                label: 'Align icon',
                categoryId: 'cat:2',
                nodeId: '1:45',
              },
            ],
            truncated: false,
          }
        } else {
          // Explicit single nodeId → bare annotations (no nodeId tag).
          result = {
            results: [
              {
                label: 'Check spacing',
                categoryId: 'cat:1',
              },
            ],
            truncated: false,
          }
        }
        break
      }

      // search (Rule A): the plugin returns RAW candidate nodes; the SERVER
      // applies match + fields + limit + cursor. We echo a small mixed-type
      // candidate set so e2e can exercise the server-side match (incl. type
      // array) and pagination. Faithful to the real plugin: an unresolvable
      // scope=node/page qualifier returns {error} (T7), not a zero-match.
      case 'search': {
        const searchScope =
          (cmd.params?.scope as string) || 'document'
        const knownIds = new Set([
          '1:42',
          '1:43',
          '1:44',
          '1:45',
        ])
        const knownPages = new Set(['0:1'])
        // The real plugin RESOLVES a not-found as a handler {error} (rides in
        // command-result.result, NOT a WS-level reject), so set result.error.
        if (
          searchScope === 'node' &&
          !knownIds.has(cmd.params?.nodeId as string)
        ) {
          result = {
            error: 'Node not found: ' + cmd.params?.nodeId,
          }
          break
        }
        if (
          searchScope === 'page' &&
          !knownPages.has(cmd.params?.pageId as string)
        ) {
          result = {
            error: 'Page not found: ' + cmd.params?.pageId,
          }
          break
        }

        // A tiny fixed tree mirroring the real plugin's scan. Card (1:42) is a
        // direct child of the page (scan level 0); Title/Body/Action Button are
        // its children (level 1). Metadata (characters / componentKey /
        // instancesOf / styleIds / variableIds) is held here but only ATTACHED
        // when the matching collect* hint is set — faithfully mirroring the real
        // plugin's CONDITIONAL collection (B3/B4), so the e2e drives the same
        // contract the live plugin produces.
        type ScanNode = {
          base: Record<string, unknown>
          depth: number
          characters?: string
          componentKey?: string
          instancesOf?: string
          styleIds?: string[]
          variableIds?: string[]
        }
        const tree: ScanNode[] = [
          {
            base: {
              id: '1:42',
              name: 'Card',
              type: 'FRAME',
              size: [320, 200],
            },
            depth: 0,
            styleIds: ['S:card-fill'],
            variableIds: ['V:radius'],
          },
          {
            base: {
              id: '1:43',
              name: 'Title',
              type: 'TEXT',
              size: [288, 24],
            },
            depth: 1,
            characters: 'Welcome back',
            styleIds: ['S:title-text'],
          },
          {
            base: {
              id: '1:44',
              name: 'Body',
              type: 'TEXT',
              size: [288, 48],
            },
            depth: 1,
            characters: 'Sign in to continue',
          },
          {
            base: {
              id: '1:45',
              name: 'Action Button',
              type: 'INSTANCE',
              size: [100, 40],
            },
            depth: 1,
            componentKey: 'btn-key-123',
            instancesOf: 'Button',
            variableIds: ['V:brand'],
          },
        ]

        // B2 — depth bounds the scan SCOPE. undefined/-1 = scan all; N keeps
        // nodes at scan level ≤ N (the level-1 children appear once depth ≥ 1).
        const sDepth = cmd.params?.depth as
          | number
          | undefined
        const inScope = (n: ScanNode): boolean =>
          sDepth === undefined ||
          sDepth < 0 ||
          n.depth <= sDepth

        // B3/B4 — conditional collection hints (set by the server only when the
        // request needs them). Attach metadata only under the matching flag.
        const collectComponentRef =
          cmd.params?.collectComponentRef === true
        const collectStyleId =
          cmd.params?.collectStyleId === true
        const collectVariableId =
          cmd.params?.collectVariableId === true
        const collectCharacters =
          cmd.params?.collectCharacters === true

        result = {
          results: tree.filter(inScope).map(n => {
            const candidate: Record<string, unknown> = {
              ...n.base,
            }
            if (
              collectCharacters &&
              n.characters !== undefined
            ) {
              candidate.characters = n.characters
            }
            if (collectComponentRef) {
              if (n.componentKey !== undefined) {
                candidate.componentKey = n.componentKey
              }
              if (n.instancesOf !== undefined) {
                candidate.instancesOf = n.instancesOf
              }
            }
            if (
              collectStyleId &&
              n.styleIds !== undefined
            ) {
              candidate.styleIds = n.styleIds
            }
            if (
              collectVariableId &&
              n.variableIds !== undefined
            ) {
              candidate.variableIds = n.variableIds
            }
            return candidate
          }),
        }
        break
      }

      case 'export': {
        const fmt = (cmd.params?.format as string) || 'PNG'
        const scale = (cmd.params?.scale as number) || 1
        result = {
          format: fmt,
          scale,
          data: fmt === 'SVG' ? MOCK_SVG : MOCK_PNG_BASE64,
        }
        break
      }

      // update_node: echo the CONVERTED spec (Figma objects, not atom strings)
      // back so e2e/round-trip tests prove the server parsed and the plugin
      // only assigned. Mirrors the real plugin's {id,name,type,warnings} reply.
      case 'update_node': {
        const unId = cmd.params?.nodeId as string
        const spec = (cmd.params?.spec ?? {}) as Record<
          string,
          unknown
        >
        // Faithful set/getSharedPluginData: a non-empty context persists; an
        // empty/whitespace value clears the key; an omitted value preserves.
        if (typeof spec.context === 'string') {
          if (spec.context.trim() === '') {
            sharedContext.delete(unId)
          } else {
            sharedContext.set(unId, spec.context)
          }
        }
        // Mirror the real plugin's warn-on-no-op + degrade behavior on an
        // INCOMPATIBLE target (modeled by an `incompat:` nodeId — a node that
        // lacks layoutMode/fills/etc. capability). 3a: a patched property that
        // the node type doesn't support is reported in warnings[]. 3b: a sizing/
        // layoutPositioning patch warns-and-continues (never throws → {error}).
        // The incompatible target is reported as a SLICE (a node lacking these
        // capabilities); the warnings INTERPOLATE that actual type and the
        // capability list MATCHES the real plugin's (incl. `opacity`) rather
        // than hardcoding "SLICE" / omitting opacity.
        const unWarnings: string[] = []
        const unIncompat = unId.startsWith('incompat:')
        const unIsDoc = unId.startsWith('doc:')
        const unType = unIsDoc
          ? 'DOCUMENT'
          : unIncompat
            ? 'SLICE'
            : 'FRAME'
        // B6 (T7 honesty): DOCUMENT node — name is read-only in the plugin API.
        // Mirror the real plugin guard: warn and skip (do NOT echo spec.name).
        if (unIsDoc && spec.name !== undefined) {
          unWarnings.push(
            'name ignored — the file/document node cannot be renamed via the Figma plugin API',
          )
          delete spec.name
        }
        if (unIncompat) {
          // capability key → spec key, matching the plugin's capabilityChecks.
          const capChecks: [string, string][] = [
            ['layoutMode', 'layout'],
            ['fills', 'fills'],
            ['strokes', 'strokes'],
            ['effects', 'effects'],
            ['opacity', 'opacity'],
            ['cornerRadius', 'radius'],
            ['clipsContent', 'clipsContent'],
          ]
          for (const [, label] of capChecks) {
            if (spec[label] !== undefined) {
              unWarnings.push(
                label +
                  ' ignored — not supported on a ' +
                  unType +
                  ' node',
              )
            }
          }
          // constraints warn-on-no-op: the real plugin guards on
          // `'constraints' in node` and warns with this exact wording when the
          // target lacks ConstraintMixin (mirrored here for a SLICE).
          if (spec.constraints !== undefined) {
            unWarnings.push(
              'constraints ignored — not supported on a ' +
                unType +
                ' node',
            )
          }
          if (spec.sizing !== undefined) {
            unWarnings.push(
              'sizing not applicable on this node (' +
                unType +
                '): incompatible context',
            )
          }
          if (spec.layoutPositioning !== undefined) {
            unWarnings.push(
              'layoutPositioning not applicable on this node (' +
                unType +
                '): incompatible context',
            )
          }
        }
        result = {
          id: unId,
          name: (spec.name as string) ?? 'Card',
          type: unType,
          warnings: unWarnings,
          // Echo the converted spec so the e2e can assert the parsed paint
          // arrived intact.
          spec,
        }
        break
      }

      // bind_variable: deterministic happy / degrade / error paths keyed off
      // the variableId so the e2e can drive each contract. A degrade/unknown
      // reply NEVER returns {error} — it returns {id,warnings} so the server's
      // formatMutationResult reports success-with-warning, not failure.
      //
      // FIELD-AWARE (mirrors the real plugin): paint fields (fills/strokes) bind
      // via setBoundVariableForPaint, scalar fields via setBoundVariable. The two
      // routes degrade with DIFFERENT messages, so the mock must branch on the
      // field the same way the plugin does — not echo a field-agnostic success.
      //
      // M13 — MODE MAP: when params.mode is present, iterate entries and model
      // the plugin's per-entry degrade paths:
      //   - modeName prefixed 'degrade:' → unknown-mode warning (not error)
      //   - clearMode:true → success (mock supports it)
      //   - modeId/modeName without degrade prefix → success (no warning)
      // The mode map is processed independently of variableId/field.
      case 'bind_variable': {
        const bvMode = cmd.params?.mode as
          | Record<
              string,
              {
                modeId?: string
                modeName?: string
                clearMode?: boolean
              }
            >
          | undefined
        const variableId = cmd.params?.variableId as
          | string
          | undefined
        const bvField = cmd.params?.field as
          | string
          | undefined
        const bvWarnings: string[] = []

        // Process mode map (M13): feature-detect + per-entry degrade.
        if (bvMode !== undefined) {
          for (const [
            collectionId,
            entry,
          ] of Object.entries(bvMode)) {
            if (entry.clearMode === true) {
              // clear-mode path: success, no warning
            } else if (
              entry.modeName !== undefined &&
              entry.modeName.startsWith('degrade:')
            ) {
              // unknown-mode degrade: warn (not error), per T7
              bvWarnings.push(
                'unknown mode "' +
                  entry.modeName +
                  '" in collection ' +
                  collectionId +
                  '; mode pin skipped',
              )
            }
            // else: modeId or non-degrade modeName → success, no warning
          }
        }

        // Process field binding (original path).
        if (variableId !== undefined) {
          const isPaintField =
            bvField === 'fills' || bvField === 'strokes'
          if (variableId.startsWith('err:')) {
            error = `Variable not found: ${variableId}`
            break
          } else if (variableId.startsWith('degrade:')) {
            bvWarnings.push(
              isPaintField
                ? 'setBoundVariableForPaint unavailable in this Figma version; paint binding skipped'
                : 'setBoundVariable unavailable in this Figma version; binding skipped',
            )
          }
          // else: happy path, no additional warning
        }

        result = {
          id: cmd.params?.nodeId as string,
          warnings: bvWarnings,
        }
        break
      }

      // get_variables: a card-with-binding fixture so the round-trip can pick a
      // variable id, bind it, and read it back as a var(...) wrapper atom.
      case 'get_variables': {
        result = {
          results: [
            {
              id: 'col:1',
              name: 'Brand',
              modes: [{ modeId: 'm1', name: 'Light' }],
              variables: [
                {
                  id: 'var:123',
                  name: 'Brand/Primary',
                  resolvedType: 'COLOR',
                  valuesByMode: {
                    m1: { r: 1, g: 0, b: 0, a: 1 },
                  },
                  aliases: [],
                  scopes: ['ALL_SCOPES'],
                  codeSyntax: { WEB: '--brand-primary' },
                  hiddenFromPublishing: false,
                },
              ],
            },
          ],
        }
        break
      }

      // create_node: the M2 handler sends {spec, parentId} (CONVERTED
      // FigmaWritePayload — atom leaves parsed, name ?? type applied); the
      // legacy M3-adjacent handler (tools/create.ts) still sends {node,…}.
      // Accept either key so both create paths round-trip, echo the converted
      // spec back for serialization assertions, and mirror the real plugin's
      // {id,name,type,warnings} reply.
      //
      // M2b T7 instance-lock wrap: a parentId prefixed `badparent:` models a
      // non-SLOT instance descendant whose appendChild Figma blocks at runtime.
      // The real plugin wraps that throw in a try/catch and returns the SAME
      // structured error shape (result.error). The mock mirrors that so the e2e
      // can assert the error-shape contract without a live Figma document.
      case 'create_node': {
        const nodeSpec = (cmd.params?.spec ??
          cmd.params?.node) as
          | Record<string, unknown>
          | undefined
        const parentId = cmd.params?.parentId as
          | string
          | undefined
        if (parentId?.startsWith('badparent:')) {
          // Mirror the real plugin's T7 structured error: the type reported is
          // the simulated parent type (INSTANCE for a non-slot descendant).
          result = {
            error:
              'Cannot append into this parent: only a component SLOT accepts children inside an instance (got INSTANCE). To fill a slot, target the slot node.',
          }
          break
        }
        const nodeType = nodeSpec?.type as string
        const echo: Record<string, unknown> = {
          ...(nodeSpec ?? {}),
        }
        delete echo.children
        // Mirror the real plugin's SLOT degrade (T7): a SLOT is created as a
        // FRAME placeholder and a downgrade warning rides back on success.
        const cnWarnings: string[] = []
        let createdType = nodeType
        if (nodeType === 'SLOT') {
          createdType = 'FRAME'
          cnWarnings.push(
            'SLOT requested via create_node was created as a FRAME placeholder; real SLOT promotion happens in create_component via component.createSlot()',
          )
        }
        // Mirror the real plugin's INSTANCE main-component resolution
        // (figma-plugin/src/code.ts): the component ref must carry a local
        // `id` (getNodeByIdAsync → COMPONENT/COMPONENT_SET) or a published
        // `key` (importComponentByKeyAsync). Neither present → clean {error}.
        // An `err:`-prefixed id models a not-found node; a `notcomp:`-prefixed
        // id models a node that is not a COMPONENT/COMPONENT_SET (same prefix
        // convention update_component uses), so the by-id error boundary is
        // assertable without a live Figma document.
        // M14: compRef.remote===true + key → key-first (mirrors real plugin).
        let instanceResolvedBy: 'key' | 'id' | undefined =
          undefined
        if (nodeType === 'INSTANCE') {
          const compRef = nodeSpec?.component as
            | {
                id?: string
                key?: string
                remote?: boolean
                properties?: Record<
                  string,
                  string | boolean
                >
              }
            | undefined
          if (
            compRef?.id === undefined &&
            compRef?.key === undefined
          ) {
            error =
              'INSTANCE requires component.id (local component node) or component.key (published/library component)'
            break
          }
          if (compRef.id?.startsWith('err:')) {
            error =
              'INSTANCE component.id not found: ' +
              compRef.id
            break
          }
          if (compRef.id?.startsWith('notcomp:')) {
            // Mirror the real plugin's "got <found.type>" message. Encode the
            // simulated type as the middle segment (notcomp:<TYPE>:<id>);
            // default to FRAME when omitted (notcomp:<id>).
            const ncParts = compRef.id.split(':')
            const gotType =
              ncParts.length >= 3 ? ncParts[1] : 'FRAME'
            error =
              'INSTANCE component.id must reference a COMPONENT or COMPONENT_SET, got ' +
              gotType +
              ': ' +
              compRef.id
            break
          }
          // M14: mirror the real plugin's remote-first resolution path.
          // remote===true + key present → resolved by key (importComponentByKeyAsync);
          // otherwise resolved by id (getNodeByIdAsync), falling back to key-only.
          if (
            compRef.remote === true &&
            compRef.key !== undefined
          ) {
            instanceResolvedBy = 'key'
          } else if (compRef.id !== undefined) {
            instanceResolvedBy = 'id'
          } else {
            instanceResolvedBy = 'key'
          }
          // Mirror the real plugin's #11 name → exact-key resolution for the
          // create_node INSTANCE path: friendly names that can't be resolved
          // warn (and are skipped) the same way set_instance does.
          if (compRef.properties) {
            const { warnings: cnResolveWarnings } =
              mockResolveInstanceProps(
                compRef.properties,
                MOCK_INSTANCE_KEYS,
              )
            cnWarnings.push(...cnResolveWarnings)
          }
        }
        const createdId = `created:${Math.random().toString(36).slice(2, 8)}`
        // Faithful set/getSharedPluginData on the newly created node (see
        // update_node): non-empty persists, empty/whitespace clears.
        if (typeof nodeSpec?.context === 'string') {
          if (nodeSpec.context.trim() === '') {
            sharedContext.delete(createdId)
          } else {
            sharedContext.set(createdId, nodeSpec.context)
          }
        }
        result = {
          ...echo,
          id: createdId,
          name: (nodeSpec?.name as string) ?? nodeType,
          type: createdType,
          parentId,
          warnings: cnWarnings,
          // M14: echo resolvedBy for the INSTANCE create path so tests can
          // assert key-first (remote) vs id-first (local) behavior.
          ...(instanceResolvedBy !== undefined
            ? { resolvedBy: instanceResolvedBy }
            : {}),
        }
        break
      }

      // create_tree (M3 contract): params = { tree, parentId?, refs? }. The
      // server has already CONVERTED every node to a FigmaWritePayload (atom
      // leaves → Figma objects) and the ref-pool to converted form. The mock
      // counts the realized node total by resolving `{ ref }` against refs and
      // treating `{ id }` clones as a single node, and echoes the converted
      // tree + refs back so e2e/round-trip tests can assert the nested
      // structure (and ref/clone resolution) reached the plugin intact.
      //
      // M2b T7 instance-lock wrap: a parentId prefixed `badparent:` models a
      // non-SLOT instance descendant; mirrors the real plugin's T7 try/catch
      // returning result.error (same shape as create_node).
      case 'create_tree': {
        const treeParentId = cmd.params?.parentId as
          | string
          | undefined
        if (treeParentId?.startsWith('badparent:')) {
          result = {
            error:
              'Cannot append into this parent: only a component SLOT accepts children inside an instance (got INSTANCE). To fill a slot, target the slot node.',
          }
          break
        }
        const treeSpec = cmd.params?.tree as
          | Record<string, unknown>
          | undefined
        const treeRefs = cmd.params?.refs as
          | Record<string, Record<string, unknown>>
          | undefined
        // refStack mirrors the real plugin's cycle guard: a cyclic { ref } pool
        // (a→b→a, or a self-ref) throws 'Cyclic ref in pool: …' instead of
        // recursing forever — so the mock surfaces a clean {error} the same way
        // the plugin does, never hanging the e2e.
        const countNodes = (
          node: Record<string, unknown>,
          refStack: string[] = [],
        ): number => {
          // { ref }: rebuild refs[key] FRESH each reuse.
          if (
            node.ref !== undefined &&
            node.type === undefined
          ) {
            const refKey = node.ref as string
            const refSpec = treeRefs?.[refKey]
            if (!refSpec) {
              return 1
            }
            if (refStack.includes(refKey)) {
              throw new Error(
                'Cyclic ref in pool: ' +
                  [...refStack, refKey].join(' -> '),
              )
            }
            return countNodes(refSpec, [
              ...refStack,
              refKey,
            ])
          }
          // { id } clone: a single realized node.
          if (
            node.id !== undefined &&
            node.type === undefined
          ) {
            return 1
          }
          let count = 1
          const children = node.children as
            | Record<string, unknown>[]
            | undefined
          if (children) {
            for (const child of children) {
              count += countNodes(child, refStack)
            }
          }
          return count
        }
        try {
          const totalNodes = treeSpec
            ? countNodes(treeSpec)
            : 1
          result = {
            ...(treeSpec ?? {}),
            id: `created:${Math.random().toString(36).slice(2, 8)}`,
            name:
              (treeSpec?.name as string) ??
              (treeSpec?.type as string),
            type: treeSpec?.type as string,
            parentId: treeParentId,
            refs: treeRefs,
            totalNodes,
          }
        } catch (e) {
          error = String(e instanceof Error ? e.message : e)
        }
        break
      }

      // clone_node: echo one {id,name,type} per requested clone (count, default
      // 1) so the count + index/parent forwarding is assertable. An out-of-range
      // `index` returns a clean {error} mirroring the real plugin's up-front
      // range guard (parent has a fixed child count of 3), rather than the raw
      // RangeError it used to degrade to.
      case 'clone_node': {
        const cloneCount =
          (cmd.params?.count as number) ?? 1
        const cloneIndex = cmd.params?.index as
          | number
          | undefined
        const cloneParentChildCount = 3
        if (
          cloneIndex !== undefined &&
          (cloneIndex < 0 ||
            cloneIndex > cloneParentChildCount)
        ) {
          error =
            'clone_node index ' +
            cloneIndex +
            ' is out of range for the parent (0..' +
            cloneParentChildCount +
            ')'
          break
        }
        const cloneArr: {
          id: string
          name: string
          type: string
        }[] = []
        for (let i = 0; i < cloneCount; i++) {
          cloneArr.push({
            id: `clone:${i}:${Math.random().toString(36).slice(2, 8)}`,
            name: 'Card',
            type: 'FRAME',
          })
        }
        result = cloneArr
        break
      }

      // reparent_node: echo {id,…,parentId} so the new-parent move is assertable.
      case 'reparent_node':
        result = {
          id: cmd.params?.nodeId as string,
          name: 'Card',
          type: 'FRAME',
          parentId: cmd.params?.parentId as string,
        }
        break

      // reorder_children: set-equality validate the requested ids against the
      // mock parent's fixed child set ['1:1','1:2','1:3']. A mismatch WARNS
      // (T7) and never errors. `order` mirrors the REAL plugin: it returns the
      // FULL post-reorder child list (parent.children.map(c=>c.id)) — i.e. the
      // requested ids that ARE children (in order) followed by the omitted
      // children in their original relative order. (Was: only the matched
      // subset — an infidelity the e2e asserted against.)
      case 'reorder_children': {
        const parentId = cmd.params?.parentId as string
        const requested =
          (cmd.params?.nodeIds as string[]) ?? []
        const actual = ['1:1', '1:2', '1:3']
        const actualSet = new Set(actual)
        const requestedSet = new Set(requested)
        const warnings: string[] = []
        const missing = requested.filter(
          id => !actualSet.has(id),
        )
        const extra = actual.filter(
          id => !requestedSet.has(id),
        )
        if (missing.length > 0 || extra.length > 0) {
          warnings.push(
            'reorder_children id set differs from the parent children: ' +
              'not children=[' +
              missing.join(',') +
              '], omitted=[' +
              extra.join(',') +
              ']. Only matching ids were reordered.',
          )
        }
        result = {
          parentId,
          order: [
            ...requested.filter(id => actualSet.has(id)),
            ...actual.filter(id => !requestedSet.has(id)),
          ],
          warnings,
        }
        break
      }

      // boolean_op: echo a BooleanOperationNode {id,name,type}; <2 nodes errors.
      case 'boolean_op': {
        const ids = (cmd.params?.nodeIds as string[]) ?? []
        if (ids.length < 2) {
          error =
            'boolean_op requires at least 2 resolvable nodes.'
        } else {
          result = {
            id: `bool:${Math.random().toString(36).slice(2, 8)}`,
            name: 'Union',
            type: 'BOOLEAN_OPERATION',
          }
        }
        break
      }

      // flatten: echo a VECTOR {id,name,type}; <1 node errors.
      case 'flatten': {
        const ids = (cmd.params?.nodeIds as string[]) ?? []
        if (ids.length < 1) {
          error =
            'flatten requires at least 1 resolvable node.'
        } else {
          result = {
            id: `vec:${Math.random().toString(36).slice(2, 8)}`,
            name: 'Vector',
            type: 'VECTOR',
          }
        }
        break
      }

      // group_nodes: echo a GROUP {id,name,type}; <1 node errors.
      case 'group_nodes': {
        const ids = (cmd.params?.nodeIds as string[]) ?? []
        if (ids.length < 1) {
          error =
            'group_nodes requires at least 1 resolvable node.'
        } else {
          result = {
            id: `grp:${Math.random().toString(36).slice(2, 8)}`,
            name: 'Group',
            type: 'GROUP',
          }
        }
        break
      }

      // transform_group: echo a TRANSFORM_GROUP {id,name,type}; <1 node errors.
      // NOTE: the mock does NOT model figma.transformGroup runtime availability —
      // the feature-detect lives in the real plugin (code.ts). The mock proves
      // handler MECHANICS and schema routing only. The controller must live-verify
      // that figma.transformGroup actually exists in the Figma runtime.
      case 'transform_group': {
        const tgIds =
          (cmd.params?.nodeIds as string[]) ?? []
        if (tgIds.length < 1) {
          error =
            'transform_group requires at least 1 resolvable node.'
        } else {
          result = {
            id: `tg:${Math.random().toString(36).slice(2, 8)}`,
            name: 'Transform Group',
            type: 'TRANSFORM_GROUP',
          }
        }
        break
      }

      // create_component (PROMOTE-ONLY, un-overloaded per spec): promote the
      // given nodeId, echoing {id,key,name,type} + the source nodeId so the e2e
      // can assert routing. The build-from-spec overload was removed.
      case 'create_component': {
        const ccNodeId = cmd.params?.nodeId as
          | string
          | undefined
        const ccName = cmd.params?.name as
          | string
          | undefined
        result = {
          id: `comp:${Math.random().toString(36).slice(2, 8)}`,
          key: `key:${Math.random().toString(36).slice(2, 8)}`,
          name: ccName ?? 'Component',
          type: 'COMPONENT',
          // echo the source so tests can assert routing
          sourceNodeId: ccNodeId,
        }
        break
      }

      // update_component: echo {id, properties, slotsCreated, slotsSkipped,
      // warnings}. `properties` is the catalogue ARRAY of
      // {id,name,type,defaultValue,variantOptions?}. An `expose` list degrades
      // (warn, never error) — exposeNestedInstances is gated. A `slots` list
      // also degrades (createSlot is runtime-only; mock echoes slotsSkipped).
      // addComponentProperty returns a CANONICAL id (`<name>#<suffix>`)
      // that agents need for later setProperties, so the mock mirrors the real
      // plugin by carrying it inside each `properties` entry's `id` field.
      // Genuine {error} boundaries (mirroring the real plugin):
      //  - componentId `err:` → {error:'Component not found: …'} (not-found).
      //  - componentId `notcomp:` → {error:'Node is not a component …'} (the
      //    node resolves but is the wrong type).
      case 'update_component': {
        const ucId = cmd.params?.componentId as string
        if (ucId.startsWith('err:')) {
          error = `Component not found: ${ucId}`
          break
        }
        if (ucId.startsWith('notcomp:')) {
          error = `Node is not a component or component set: ${ucId}`
          break
        }
        const ucAdd = cmd.params?.add as
          | {
              name: string
              type: string
              defaultValue: string | boolean
              targetNodeId?: string
              field?:
                | 'characters'
                | 'visible'
                | 'mainComponent'
            }[]
          | undefined
        const ucExpose = cmd.params?.expose as
          | string[]
          | undefined
        const ucSlots = cmd.params?.slots as
          | string[]
          | undefined
        const ucWarnings: string[] = []
        const properties: {
          id: string
          name: string
          type: string
          defaultValue: string | boolean
        }[] = []
        if (ucAdd) {
          for (const p of ucAdd) {
            properties.push({
              id: `${p.name}#1:0`,
              name: p.name,
              type: p.type,
              defaultValue: p.defaultValue,
            })
            // B3: if no targetNodeId, the property is unbound — emit the honest
            // warning that matches the real plugin's T7 contract.
            if (!p.targetNodeId) {
              ucWarnings.push(
                'property "' +
                  p.name +
                  '" added but no targetNodeId given — it is unbound and set_instance will be inert',
              )
            }
            // When targetNodeId IS present, the real plugin would set
            // componentPropertyReferences on the child. The mock cannot do that
            // (no live Figma node tree), so it simply skips — headless fidelity
            // boundary documented in comments.
          }
        }
        if (ucExpose && ucExpose.length > 0) {
          ucWarnings.push(
            'exposeNestedInstances unavailable in this Figma version; expose skipped',
          )
        }
        // slots: mock degrades (T7) — createSlot is runtime-only and unavailable
        // in the headless mock. Echo slotsCreated:[] / slotsSkipped:[...names] with
        // the degrade warning, matching the real plugin's T7 degrade path.
        const slotsCreated: string[] = []
        const slotsSkipped: string[] = []
        if (ucSlots && ucSlots.length > 0) {
          for (const name of ucSlots) {
            slotsSkipped.push(name)
          }
          ucWarnings.push(
            'createSlot unavailable in this Figma version; slot(s) not created',
          )
        }
        result = {
          id: ucId,
          properties,
          slotsCreated,
          slotsSkipped,
          warnings: ucWarnings,
        }
        break
      }

      // combine_variants: ids that aren't valid COMPONENTs are DROPPED with a
      // warning (honest partial success — never silently swallowed), mirroring
      // the real plugin. ≥2 SURVIVORS → a COMPONENT_SET; <2 → error (guarded
      // server-side too). The mock treats `bad:`-prefixed ids as not-a-component.
      // The set's `key` is returned (read/write symmetry). A `noaxis:`-prefixed
      // KEPT id models a component whose name lacks the "Property=Value" axis
      // convention → the MULTI-AXIS warning (T7/T9), faithful to the real plugin
      // checking the source names.
      case 'combine_variants': {
        const cvIds =
          (cmd.params?.componentIds as string[]) ?? []
        const cvWarnings: string[] = []
        const cvDropped = cvIds.filter(id =>
          id.startsWith('bad:'),
        )
        const cvKept = cvIds.filter(
          id => !id.startsWith('bad:'),
        )
        if (cvDropped.length > 0) {
          cvWarnings.push(
            'combine_variants ignored ' +
              cvDropped.length +
              ' id(s) that are not a COMPONENT: ' +
              cvDropped.join(', '),
          )
        }
        if (cvKept.length < 2) {
          error =
            'Need at least 2 components for combine_variants'
          break
        }
        // Multi-axis nudge: KEPT ids prefixed `noaxis:` model component names
        // lacking the "Property=Value" axis convention.
        const cvUnaxised = cvKept.filter(id =>
          id.startsWith('noaxis:'),
        )
        if (cvUnaxised.length > 0) {
          cvWarnings.push(
            'combine_variants: ' +
              cvUnaxised.length +
              ' component name(s) do not use the "Property=Value" axis convention (' +
              cvUnaxised.join(', ') +
              '); the variant set will not form a clean axis set. Name each variant one property per axis (e.g. "Style=Primary, Size=Large").',
          )
        }
        // A `nogood:` parent can't bear children → fall back to the first
        // component's parent, but REPORT it (no silent fallback), mirroring the
        // real plugin.
        const cvParentId = cmd.params?.parentId as
          | string
          | undefined
        if (cvParentId?.startsWith('nogood:')) {
          cvWarnings.push(
            'Requested parent "' +
              cvParentId +
              '" cannot contain the variant set; used the first component\'s parent instead.',
          )
        }
        result = {
          id: `cs:${Math.random().toString(36).slice(2, 8)}`,
          key: `cskey:${Math.random().toString(36).slice(2, 8)}`,
          name:
            (cmd.params?.name as string) ?? 'VariantSet',
          type: 'COMPONENT_SET',
          variantAxes: { Variant: { values: ['Default'] } },
          warnings: cvWarnings,
        }
        break
      }

      // swap_component: echo {id, mainComponent, warnings}. Remote-capable,
      // faithful to the real plugin:
      //  - LOCAL mainComponentId WINS if both it and `key` are given.
      //  - REMOTE `key` (no mainComponentId) is resolved via
      //    importComponentByKeyAsync. A key prefixed `importfail:` models a
      //    FAILED import → degrade ({mainComponent:null, warning}), NEVER {error};
      //    else the imported main id is derived (`key` → `imported:<key>`).
      //  - instanceId `degrade:` models a FAILED swap (T7): the real plugin
      //    re-reads getMainComponentAsync() → the ORIGINAL main (swap never took),
      //    so the mock echoes `orig:<id>`, NOT the requested target.
      case 'swap_component': {
        const scId = cmd.params?.instanceId as string
        const scMainId = cmd.params?.mainComponentId as
          | string
          | undefined
        const scKey = cmd.params?.key as string | undefined
        const scWarnings: string[] = []
        // Resolve the target main: LOCAL wins; else import by key.
        let target: string | null
        if (scMainId !== undefined) {
          target = scMainId
        } else if (scKey !== undefined) {
          if (scKey.startsWith('importfail:')) {
            result = {
              id: scId,
              mainComponent: null,
              warnings: [
                'importComponentByKeyAsync failed for key "' +
                  scKey +
                  '": import error; remote swap skipped',
              ],
            }
            break
          }
          target = 'imported:' + scKey
        } else {
          error =
            'swap_component requires mainComponentId (local) or key (remote)'
          break
        }
        const degraded = scId?.startsWith('degrade:')
        if (degraded) {
          scWarnings.push(
            'swapComponent failed: feature unavailable',
          )
        }
        result = {
          id: scId,
          mainComponent: degraded
            ? 'orig:' + scId.slice('degrade:'.length)
            : target,
          warnings: scWarnings,
        }
        break
      }

      // set_instance: echo {id, componentProperties, warnings}. overrides → warn
      // (not applied). The real plugin returns the RAW Figma
      // inst2.componentProperties — a NESTED map { [name]: { value, type } }
      // (VARIANT and non-VARIANT props mixed, value wrapped) — NOT the flat
      // input. The mock stays FAITHFUL to that raw plugin shape; the SERVER now
      // splits it into the read-twin { variantProperties?, componentProperties? }
      // shape (C3 — flatten-to-read-twin landed). Infer type from the value
      // kind: boolean → BOOLEAN, string → VARIANT (the common case in tests).
      case 'set_instance': {
        const siId = cmd.params?.instanceId as string
        const siProps = cmd.params?.properties as
          | Record<string, string | boolean>
          | undefined
        const siOverrides = cmd.params?.overrides as
          | unknown[]
          | undefined
        const siWarnings: string[] = []
        // Mirror the real plugin's T7 no-op warning: a call with neither
        // properties nor overrides mutates nothing and must warn.
        if (
          (!siProps || Object.keys(siProps).length === 0) &&
          (!siOverrides || siOverrides.length === 0)
        ) {
          siWarnings.push(
            'no properties or overrides supplied; nothing changed',
          )
        }
        if (siOverrides && siOverrides.length > 0) {
          siWarnings.push(
            'Per-node overrides are not yet applied; ' +
              siOverrides.length +
              ' override(s) skipped',
          )
        }
        // Mirror the real plugin's #11 name → exact-key resolution: friendly
        // names resolve to "#id" keys (or warn + skip), and only the resolved
        // keys are echoed back in componentProperties.
        const {
          resolved: siResolved,
          warnings: siResolveWarnings,
        } = mockResolveInstanceProps(
          siProps ?? {},
          MOCK_INSTANCE_KEYS,
        )
        siWarnings.push(...siResolveWarnings)
        const siNested: Record<
          string,
          { value: string | boolean; type: string }
        > = {}
        for (const [k, v] of Object.entries(siResolved)) {
          siNested[k] = {
            value: v,
            type:
              typeof v === 'boolean'
                ? 'BOOLEAN'
                : 'VARIANT',
          }
        }
        result = {
          id: siId,
          componentProperties: siNested,
          warnings: siWarnings,
        }
        break
      }

      case 'create_from_svg': {
        const svgName =
          (cmd.params?.name as string) ?? 'SVG'
        result = {
          id: `svg:${Math.random().toString(36).slice(2, 8)}`,
          name: svgName,
          type: 'FRAME',
          childCount: 3,
        }
        break
      }

      // delete_node: echo {id,name,type} (captured before removal).
      // PAGE branch — backed by a small in-mock page array:
      //   page:only   → last-page {error} (T7)
      //   page:current → switch-then-remove; returns currentPageId
      //   page:noncurrent → remove non-current page; returns currentPageId
      //   page:noapi   → setCurrentPageAsync absent degrade (warns, skips remove)
      //   anything else → ordinary FRAME reply (default mock node)
      case 'delete_node': {
        const dnNodeId = cmd.params?.nodeId as string
        // Mock page registry: two pages, page:current is active.
        const mockPages = [
          { id: 'page:current', name: 'Page 1' },
          { id: 'page:other', name: 'Page 2' },
        ]
        if (dnNodeId === 'page:only') {
          result = {
            error:
              'Cannot delete the last remaining page: ' +
              dnNodeId,
          }
          break
        }
        if (dnNodeId === 'page:noapi') {
          result = {
            id: 'page:noapi',
            name: 'Page 1',
            type: 'PAGE',
            warnings: [
              'setCurrentPageAsync unavailable; current page not switched — remove skipped',
            ],
          }
          break
        }
        if (
          dnNodeId === 'page:current' ||
          dnNodeId === 'page:noncurrent'
        ) {
          const deletedPage = mockPages.find(
            p => p.id === dnNodeId,
          )
          // After removing page:current, current switches to page:other.
          // After removing page:noncurrent (page:other), current stays page:current.
          const newCurrentId =
            dnNodeId === 'page:current'
              ? 'page:other'
              : 'page:current'
          result = {
            id: dnNodeId,
            name: deletedPage?.name ?? 'Page',
            type: 'PAGE',
            currentPageId: newCurrentId,
          }
          break
        }
        result = {
          id: dnNodeId,
          name: 'Card',
          type: 'FRAME',
        }
        break
      }

      // set_focus: CANVAS only — echo a viewport snapshot. Models the real
      // plugin's resolution + T7 honesty: an id that does not resolve to a scene
      // node (mirrored here by a `missing:` prefix) is reported in warnings[]
      // rather than silently dropped, and requested/focused expose the counts.
      case 'set_focus': {
        const sfIds =
          (cmd.params?.nodeIds as string[]) ?? []
        const sfMissing = sfIds.filter(id =>
          id.startsWith('missing:'),
        )
        const sfFocused = sfIds.length - sfMissing.length
        result = {
          viewport: { center: { x: 0, y: 0 }, zoom: 1 },
          requested: sfIds.length,
          focused: sfFocused,
          warnings:
            sfMissing.length > 0
              ? [
                  'set_focus: ' +
                    sfMissing.join(', ') +
                    ' did not resolve to a scene node and were skipped',
                ]
              : [],
        }
        break
      }

      // create_page: echo the new page id + the requested name.
      case 'create_page':
        result = {
          id: 'page:new',
          name: cmd.params?.name as string,
        }
        break

      // set_current_page: echo the switched-to page.
      case 'set_current_page':
        result = {
          currentPage: {
            id: cmd.params?.pageId as string,
            name: 'Switched',
          },
        }
        break

      // duplicate_page: echo the clone id + the (optional) rename.
      case 'duplicate_page':
        result = {
          id: 'page:dup',
          name: (cmd.params?.name as string) ?? 'Copy',
        }
        break

      // create_image: a url starting with `degrade:` exercises the T7 degrade
      // (warnings, NO hash, NO error → success-with-warning); an empty `bytes`
      // array models the bytes-path degrade (invalid bytes/feature unavailable)
      // faithfully to the real plugin's own bytes try/catch; else a hash.
      case 'create_image': {
        const imgUrl = cmd.params?.url as string | undefined
        const imgBytes = cmd.params?.bytes as
          | number[]
          | undefined
        if (imgUrl?.startsWith('degrade:')) {
          result = {
            warnings: [
              'createImageAsync failed (network/feature unavailable): degrade requested',
            ],
          }
        } else if (
          imgBytes !== undefined &&
          imgBytes.length === 0
        ) {
          // Mirror the real plugin's bytes-path degrade, which appends the
          // underlying reason (`: ` + String(e)) — keep the suffix so the mock
          // is byte-faithful to the plugin's actual message shape.
          result = {
            warnings: [
              'createImage failed (invalid bytes/feature unavailable): empty byte array',
            ],
          }
        } else if (
          imgUrl !== undefined ||
          imgBytes !== undefined
        ) {
          result = { hash: 'img:abc123' }
        } else {
          error = 'create_image requires url or bytes'
        }
        break
      }

      // set_plugin_data: echo {id}. The figmabridge/context escape hatch writes
      // straight to the shared store with NO cap (the cap is server-side only,
      // so this proves over-cap values are read-only). value === '' clears.
      case 'set_plugin_data': {
        const spNodeId = cmd.params?.nodeId as string
        if (
          cmd.params?.namespace === 'figmabridge' &&
          cmd.params?.key === 'context'
        ) {
          const spValue = cmd.params?.value as string
          if (spValue === '') {
            sharedContext.delete(spNodeId)
          } else {
            sharedContext.set(spNodeId, spValue)
          }
        }
        result = { id: spNodeId }
        break
      }

      // set_reactions: a nodeId starting with `degrade:` exercises the T7
      // unavailable-API degrade ({id,warnings}, NEVER {error}); else {id,[]}.
      case 'set_reactions': {
        const rNodeId = cmd.params?.nodeId as string
        result = rNodeId.startsWith('degrade:')
          ? {
              id: rNodeId,
              warnings: [
                'setReactionsAsync unavailable in this Figma version; reactions not set',
              ],
            }
          : { id: rNodeId, warnings: [] }
        break
      }

      // set_annotations: a nodeId starting with `degrade:` exercises the T7
      // editor-gated degrade ({id,warnings}, NEVER {error}); else {id,[]}.
      case 'set_annotations': {
        const aNodeId = cmd.params?.nodeId as string
        result = aNodeId.startsWith('degrade:')
          ? {
              id: aNodeId,
              warnings: [
                'Annotations API unavailable in this editor; annotations not set',
              ],
            }
          : { id: aNodeId, warnings: [] }
        break
      }

      // create_variables: the server has CONVERTED COLOR values to {r,g,b,a}
      // (FLOAT/STRING/BOOLEAN pass through). Echo the converted variables back
      // (as `echo`) so the e2e can assert the parse + the E1 fields (aliases /
      // scopes / codeSyntax / hiddenFromPublishing) reached the plugin, and
      // mirror the real reply { collectionId, modes, variables:[{id,name}] }.
      // T7: a collection name prefixed `err:` models the collection-level
      // factory THROWING — a genuine failure (nothing to return) → {error}, not
      // a degrade. A variable name prefixed `degrade:` models a per-variable
      // create / setValueForMode failure — it degrades to a warning and the rest
      // of the batch continues (never a throw, never {error}). E1: an `aliases`
      // target id prefixed `missing:` models alias-target-not-found (the SHARED
      // per-variable apply path's T7 degrade — warned, never thrown).
      case 'create_variables': {
        const collectionName = cmd.params
          ?.collection as string
        if (collectionName.startsWith('err:')) {
          error = `createVariableCollection failed for "${collectionName}"`
          break
        }
        const inVars =
          (cmd.params?.variables as
            | {
                name: string
                type: string
                valuesByMode: Record<string, unknown>
                aliases?: Record<string, string>
                scopes?: string[]
                codeSyntax?: Record<string, string>
                hiddenFromPublishing?: boolean
              }[]
            | undefined) ?? []
        const reqModes =
          (cmd.params?.modes as string[] | undefined) ?? []
        // The default mode is renamed to reqModes[0] when given, else 'Mode 1'.
        const modeNames =
          reqModes.length > 0 ? reqModes : ['Mode 1']
        const warnings: string[] = []
        // Mirror the real plugin's T7 renameMode-unavailable warning: a
        // collection name prefixed `norename:` models renameMode being absent,
        // so the default mode keeps its name and a warning rides back.
        if (
          collectionName.startsWith('norename:') &&
          reqModes.length > 0
        ) {
          warnings.push(
            `renameMode unavailable in this Figma version; default mode not renamed to "${reqModes[0]}"`,
          )
        }
        const created: { id: string; name: string }[] = []
        inVars.forEach((v, i) => {
          if (v.name.startsWith('degrade:')) {
            warnings.push(
              `setValueForMode failed for variable "${v.name}"; value not set`,
            )
            return
          }
          // E1: model the shared per-variable apply path's alias-target-not-found
          // degrade (an aliases target id prefixed `missing:`).
          for (const [modeName, targetId] of Object.entries(
            v.aliases ?? {},
          )) {
            if (targetId.startsWith('missing:')) {
              warnings.push(
                `alias target not found: ${targetId} for variable "${v.name}"`,
              )
            } else {
              void modeName
            }
          }
          created.push({ id: `var:${i + 1}`, name: v.name })
        })
        result = {
          collectionId: 'col:new',
          modes: modeNames.map((name, i) => ({
            modeId: `m${i + 1}`,
            name,
          })),
          variables: created,
          warnings,
          echo: inVars,
        }
        break
      }

      // update_variables: a collectionId starting with `err:` → {error};
      // `degrade:` → success-with-warning. Else echo the (converted) edits +
      // mode lifecycle back so the e2e can assert the parse + forwarding. T7: a
      // VARIABLE id prefixed `degrade:` models a setValueForMode REJECTION (e.g.
      // a type-incompatible value reaching a COLOR variable) — it degrades to a
      // warning-on-success, never a throw, never {error}.
      case 'update_variables': {
        const colId = cmd.params?.collectionId as string
        if (colId.startsWith('err:')) {
          error = `Collection not found: ${colId}`
        } else if (colId.startsWith('degrade:')) {
          result = {
            collectionId: colId,
            modes: [],
            warnings: [
              'addMode unavailable in this Figma version; mode not added',
            ],
          }
        } else {
          const editVars =
            (cmd.params?.variables as
              | { id: string }[]
              | undefined) ?? []
          const warnings: string[] = []
          // Mirror the real plugin's T7 renameMode-failure degrade: a
          // renameModes entry whose `from` is prefixed `degrade:` models a
          // duplicate/invalid rename throwing — warned, never {error}.
          const renameModes =
            (cmd.params?.renameModes as
              | { from: string; to: string }[]
              | undefined) ?? []
          for (const rename of renameModes) {
            if (rename.from.startsWith('degrade:')) {
              warnings.push(
                `renameMode failed for "${rename.from}" → "${rename.to}": duplicate mode name`,
              )
            }
          }
          for (const edit of editVars) {
            if (edit.id.startsWith('degrade:')) {
              warnings.push(
                `setValueForMode failed for variable ${edit.id}; value not set`,
              )
            }
          }
          result = {
            collectionId: colId,
            modes: [{ modeId: 'm1', name: 'Default' }],
            warnings,
            echo: {
              addModes: cmd.params?.addModes,
              removeModes: cmd.params?.removeModes,
              renameModes: cmd.params?.renameModes,
              variables: cmd.params?.variables,
            },
          }
        }
        break
      }

      // delete_variables: PARTIAL SUCCESS over variable ids and collection ids.
      // Collections first (real cascade order). An id prefixed `err:` models
      // not-found (per-id error, never aborts the rest). An id prefixed
      // `nofn:` models the T7 feature-detect path (remove() absent → per-id
      // error). All others → success result with kind='variable'|'collection'.
      // Returns { results:[{id, kind}], errors:[{id, error}] }.
      case 'delete_variables': {
        const dvResults: { id: string; kind: string }[] = []
        const dvErrors: { id: string; error: string }[] = []
        for (const colId of (cmd.params?.collections as
          | string[]
          | undefined) ?? []) {
          if (colId.startsWith('err:')) {
            dvErrors.push({
              id: colId,
              error: `Collection not found: ${colId}`,
            })
          } else if (colId.startsWith('nofn:')) {
            dvErrors.push({
              id: colId,
              error: `remove() unavailable on collection ${colId}`,
            })
          } else {
            dvResults.push({
              id: colId,
              kind: 'collection',
            })
          }
        }
        for (const varId of (cmd.params?.variables as
          | string[]
          | undefined) ?? []) {
          if (varId.startsWith('err:')) {
            dvErrors.push({
              id: varId,
              error: `Variable not found: ${varId}`,
            })
          } else if (varId.startsWith('nofn:')) {
            dvErrors.push({
              id: varId,
              error: `remove() unavailable on variable ${varId}`,
            })
          } else {
            dvResults.push({ id: varId, kind: 'variable' })
          }
        }
        result = { results: dvResults, errors: dvErrors }
        break
      }

      // create_styles: array-create with PARTIAL SUCCESS. The server has
      // CONVERTED each entry's value atom (paint→Paint, text→FontName,
      // effect→Effect, grid→LayoutGrid). Loop, mirroring the real plugin's
      // { results:[{id,key,name,type,index}], errors:[{index,error}] }. A style
      // `name` prefixed `err:` models a per-entry create failure (degrade, not
      // abort). Each result carries the entry's `value` as `echo` so conversion
      // assertions still round-trip.
      case 'create_styles': {
        const csEntries =
          (cmd.params?.styles as
            | {
                index: number
                type: string
                name: string
                value: unknown
                description?: string
              }[]
            | undefined) ?? []
        const csResults: unknown[] = []
        const csErrors: { index: number; error: string }[] =
          []
        for (const e of csEntries) {
          if (e.name.startsWith('err:')) {
            csErrors.push({
              index: e.index,
              error: `create${e.type}Style unavailable`,
            })
            continue
          }
          csResults.push({
            id: `S:${e.index}`,
            key: 'style-key',
            name: e.name,
            type: e.type,
            index: e.index,
            echo: e.value,
          })
        }
        result = { results: csResults, errors: csErrors }
        break
      }

      // update_styles: array-edit with PARTIAL SUCCESS. Each entry is keyed by
      // its `id` (mirrors the real plugin's lookup). Per-entry models:
      //  - id `err:` → {index,error} not-found (does NOT abort the rest).
      //  - id `degrade:` → {index,error} category mismatch (value not applied;
      //    newName/description were).
      //  - id `fontfail:` → {index,error} partial write (newName/description
      //    committed, the TEXT value branch's loadFontAsync threw).
      //  - else → {id,index} success.
      case 'update_styles': {
        const usEntries =
          (cmd.params?.styles as
            | {
                index: number
                id?: string
                name?: string
                value?: { family?: string; style?: string }
              }[]
            | undefined) ?? []
        const usResults: { id: string; index: number }[] =
          []
        const usErrors: {
          index: number
          error: string
        }[] = []
        for (const e of usEntries) {
          const sId = e.id ?? e.name ?? ''
          if (sId.startsWith('err:')) {
            usErrors.push({
              index: e.index,
              error: `Style not found: ${sId}`,
            })
          } else if (sId.startsWith('degrade:')) {
            usErrors.push({
              index: e.index,
              error:
                'value looks like a paint atom but the style is text; value not applied (newName/description were updated)',
            })
          } else if (sId.startsWith('fontfail:')) {
            usErrors.push({
              index: e.index,
              error: `font "${e.value?.family} ${e.value?.style}" unavailable; value not applied (newName/description were updated)`,
            })
          } else {
            usResults.push({ id: sId, index: e.index })
          }
        }
        result = { results: usResults, errors: usErrors }
        break
      }

      // delete_styles: PARTIAL SUCCESS over style entries. Each entry is addressed
      // by `id` (or `name`+`type` via the mock's sId = e.id ?? e.name). Per-entry
      // models:
      //  - id (or name) prefixed `err:` → {index,error} not-found (does NOT abort
      //    the rest).
      //  - id (or name) prefixed `nofn:` → {index,error} T7 remove()-unavailable.
      //  - else → {id,index} success.
      // Returns { results:[{id,index}], errors:[{index,error}] }.
      case 'delete_styles': {
        const dsEntries =
          (cmd.params?.styles as
            | {
                index: number
                id?: string
                name?: string
                type?: string
              }[]
            | undefined) ?? []
        const dsResults: { id: string; index: number }[] =
          []
        const dsErrors: { index: number; error: string }[] =
          []
        for (const e of dsEntries) {
          const sId = e.id ?? e.name ?? ''
          if (sId.startsWith('err:')) {
            dsErrors.push({
              index: e.index,
              error: `Style not found: ${sId}`,
            })
          } else if (sId.startsWith('nofn:')) {
            dsErrors.push({
              index: e.index,
              error: `remove() unavailable on style ${sId}`,
            })
          } else {
            dsResults.push({ id: sId, index: e.index })
          }
        }
        result = { results: dsResults, errors: dsErrors }
        break
      }

      // apply_style boundary (mirrors the real plugin):
      //  - nodeId `err:` → {error} node-not-found.
      //  - styleId `missing:` → {error} style-not-found (a GENUINE invalid, not
      //    a degrade).
      //  - styleId `wrongcat:` → {error} category mismatch (genuine invalid).
      //  - nodeId `degrade:` → success-with-warning (setter unavailable on the
      //    node type — a true degrade), NEVER {error}.
      //  - else {id,[]} happy.
      case 'apply_style': {
        const apNodeId = cmd.params?.nodeId as string
        const apStyleId = cmd.params?.styleId as string
        const apField = cmd.params?.field as string
        if (apNodeId.startsWith('err:')) {
          error = `Node not found: ${apNodeId}`
        } else if (apStyleId.startsWith('missing:')) {
          error = `Style not found: ${apStyleId}`
        } else if (apStyleId.startsWith('wrongcat:')) {
          error = `Style category mismatch: field "${apField}" expects a TEXT style but ${apStyleId} is a PAINT style`
        } else if (apNodeId.startsWith('degrade:')) {
          result = {
            id: apNodeId,
            warnings: [
              'setTextStyleIdAsync unavailable on FRAME; style not applied',
            ],
          }
        } else {
          result = { id: apNodeId, warnings: [] }
        }
        break
      }

      default:
        error = 'Unknown command'
        break
    }

    return { result, error }
  }

  const handleBroadcast = (
    socket: WebSocket,
    cmd: CommandMessage,
  ): void => {
    const requestId = cmd.meta?.requestId
    const isPing = cmd.command === COMMANDS.PING
    if (isPing) {
      pingCount += 1
    }

    // L5 silent mode: withhold EVERY reply, incl. ping — models a fully dead
    // plugin/socket for the L6 watchdog tests. Nothing is sent, ever.
    if (silent) {
      return
    }

    // Liveness ping bypasses the identity guard below AND the delay map,
    // faithful to the real plugin: useRelay.ts answers ping unconditionally in
    // the UI iframe layer, above both the target-guard check and the
    // main-thread command dispatch — so a busy-but-alive plugin still pongs.
    if (isPing) {
      const { result, error } = runCommand(
        cmd.command!,
        cmd.params,
      )
      const resolved: CommandMessage =
        error !== undefined
          ? { meta: { requestId }, error }
          : { meta: { requestId }, result }
      socket.send(
        JSON.stringify({
          type: 'message',
          channel,
          message: resolved,
        } satisfies ChannelMessage),
      )
      return
    }

    // B3 identity guard (mirrors the real plugin's code.ts, via the same
    // shared isTargetMismatch/targetGuardError): a command whose meta.fileKey ≠
    // this plugin's fileKey is refused with a byte-identical typed error and NOT
    // executed. Only fires when this plugin knows its own fileKey AND the
    // command carries a target — when either is null the guard can't verify and
    // degrades honestly (executes), faithful to the undefined-figma.fileKey path.
    if (isTargetMismatch(fileKey, cmd.meta?.fileKey)) {
      const refusal: ChannelMessage = {
        type: 'message',
        channel,
        message: {
          meta: { requestId },
          result: {
            error: targetGuardError(
              String(cmd.meta?.fileKey),
              String(fileKey),
            ),
          },
        },
      }
      socket.send(JSON.stringify(refusal))
      return
    }

    const sendReply = (): void => {
      const { result, error } = runCommand(
        cmd.command!,
        cmd.params,
      )

      // The real Figma plugin replies with { meta:{requestId}, result|error }
      // and NO command (see figma-plugin/src/hooks/useRelay.ts). Mirror that
      // here so the mock exercises the real response shape through the
      // relay's validation.
      const resolved: CommandMessage =
        error !== undefined
          ? { meta: { requestId }, error }
          : { meta: { requestId }, result }

      const reply: ChannelMessage = {
        type: 'message',
        channel,
        message: resolved,
      }

      socket.send(JSON.stringify(reply))
    }

    // L5 delay knob: a command present in `delayedCommands` has its reply
    // deferred by the mapped ms (models a slow-but-alive plugin). Absent (the
    // default) → immediate synchronous reply, unchanged from before L5.
    const delayMs = delayedCommands.get(cmd.command!)
    if (delayMs !== undefined) {
      setTimeout(sendReply, delayMs)
    } else {
      sendReply()
    }
  }

  const start = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(relayUrl)
      let joined = false

      socket.onerror = () => {
        reject(new Error('Mock plugin connection failed'))
      }

      socket.onopen = () => {
        ws = socket

        socket.onmessage = event => {
          let raw: SystemMessage | BroadcastMessage

          try {
            raw = JSON.parse(event.data as string) as
              | SystemMessage
              | BroadcastMessage
          } catch {
            return
          }

          if (raw.type === 'system' && !joined) {
            joined = true

            const registerMsg: RegisterMessage = {
              type: 'register',
              channel,
              fileKey,
              fileName: documentName ?? null,
              version,
            }
            socket.send(JSON.stringify(registerMsg))

            resolve()

            return
          }

          if (raw.type === 'broadcast') {
            handleBroadcast(socket, raw.message)
          }
        }

        const joinMsg: JoinMessage = {
          type: 'join',
          channel,
        }

        socket.send(JSON.stringify(joinMsg))
      }
    })

  const stop = (): void => {
    if (ws !== null) {
      ws.close()
      ws = null
    }
  }

  const setSilent = (value: boolean): void => {
    silent = value
  }

  const delayCommand = (
    command: string,
    delayMs: number,
  ): void => {
    delayedCommands.set(command, delayMs)
  }

  const pings = (): number => pingCount

  return { start, stop, setSilent, delayCommand, pings }
}
