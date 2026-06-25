import type {
  BroadcastMessage,
  ChannelMessage,
  CommandMessage,
  JoinMessage,
  RegisterMessage,
  SystemMessage,
} from '@figma-agent-bridge/shared/types'
import cardFixture from '../fixtures/card-node-raw.json'

const MOCK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="red" width="100" height="100"/></svg>'

const MOCK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

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
}

type MockPlugin = {
  start: () => Promise<void>
  stop: () => void
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
  } = options

  let ws: WebSocket | null = null

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

      case 'get_document_info':
        result = {
          name: documentName,
          currentPage: {
            id: 'page:1',
            name: pageName,
          },
        }
        break

      case 'get_selection':
        result = [
          { id: '1:42', name: 'Card', type: 'FRAME' },
        ]
        break

      // set_selection: echo {selectedCount} = the number of ids passed.
      case 'set_selection': {
        const ids = (cmd.params?.nodeIds as string[]) ?? []
        result = { selectedCount: ids.length }
        break
      }

      case 'get_node':
        result = cardFixture
        break

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
          result = cardFixture
        }
        break
      }

      case 'get_nodes':
        result = [cardFixture]
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

      // get_components: the NEW richer shape — key + variantAxes +
      // propertyDefinitions + defaults per local entry, key + library +
      // instancesCount per remote entry.
      case 'get_components':
        result = {
          local: [
            {
              id: '1:10',
              name: 'Button',
              key: 'btn-key',
              type: 'COMPONENT_SET',
              page: 'Main',
              propertyDefinitions: [
                {
                  name: 'Variant',
                  type: 'VARIANT',
                  defaultValue: 'Primary',
                  variantOptions: ['Primary', 'Secondary'],
                },
                {
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
            },
          ],
          remote: [
            {
              key: 'remote-key',
              name: 'Icon',
              library: 'Lib',
              instancesCount: 3,
            },
          ],
        }
        break

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

      // get_plugin_data: pluginData always; sharedPluginData only with a namespace.
      case 'get_plugin_data':
        result = {
          nodeId: cmd.params?.nodeId as string,
          pluginData: { foo: 'bar' },
          sharedPluginData: cmd.params?.namespace
            ? { baz: 'qux' }
            : undefined,
        }
        break

      // get_annotations: happy path (Rule A). The degrade path is covered by the
      // metadata unit test with a stub client.
      case 'get_annotations':
        result = {
          results: [
            { label: 'Check spacing', categoryId: 'cat:1' },
          ],
          truncated: false,
        }
        break

      // search (Rule A): the plugin returns RAW candidate nodes; the SERVER
      // applies match + fields + limit + cursor. We echo a small mixed-type
      // candidate set so e2e can exercise the server-side match (incl. type
      // array) and pagination.
      case 'search':
        result = {
          results: [
            {
              id: '1:42',
              name: 'Card',
              type: 'FRAME',
              size: [320, 200],
            },
            {
              id: '1:43',
              name: 'Title',
              type: 'TEXT',
              size: [288, 24],
            },
            {
              id: '1:44',
              name: 'Body',
              type: 'TEXT',
              size: [288, 48],
            },
            {
              id: '1:45',
              name: 'Action Button',
              type: 'INSTANCE',
              size: [100, 40],
            },
          ],
        }
        break

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
        const spec = (cmd.params?.spec ?? {}) as Record<
          string,
          unknown
        >
        result = {
          id: cmd.params?.nodeId as string,
          name: (spec.name as string) ?? 'Card',
          type: 'FRAME',
          warnings: [],
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
      case 'bind_variable': {
        const variableId = cmd.params?.variableId as string
        if (variableId.startsWith('err:')) {
          error = `Variable not found: ${variableId}`
        } else if (variableId.startsWith('degrade:')) {
          result = {
            id: cmd.params?.nodeId as string,
            warnings: [
              'setBoundVariable unavailable in this Figma version; binding skipped',
            ],
          }
        } else {
          result = {
            id: cmd.params?.nodeId as string,
            warnings: [],
          }
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
      case 'create_node': {
        const nodeSpec = (cmd.params?.spec ??
          cmd.params?.node) as
          | Record<string, unknown>
          | undefined
        const parentId = cmd.params?.parentId as
          | string
          | undefined
        const nodeType = nodeSpec?.type as string
        const echo: Record<string, unknown> = {
          ...(nodeSpec ?? {}),
        }
        delete echo.children
        result = {
          ...echo,
          id: `created:${Math.random().toString(36).slice(2, 8)}`,
          name: (nodeSpec?.name as string) ?? nodeType,
          type: nodeType,
          parentId,
          warnings: [],
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
      case 'create_tree': {
        const treeSpec = cmd.params?.tree as
          | Record<string, unknown>
          | undefined
        const treeParentId = cmd.params?.parentId as
          | string
          | undefined
        const treeRefs = cmd.params?.refs as
          | Record<string, Record<string, unknown>>
          | undefined
        const countNodes = (
          node: Record<string, unknown>,
        ): number => {
          // { ref }: rebuild refs[key] FRESH each reuse.
          if (
            node.ref !== undefined &&
            node.type === undefined
          ) {
            const refSpec = treeRefs?.[node.ref as string]
            return refSpec ? countNodes(refSpec) : 1
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
              count += countNodes(child)
            }
          }
          return count
        }
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
        break
      }

      // clone_node: echo one {id,name,type} per requested clone (count, default
      // 1) so the count + index/parent forwarding is assertable.
      case 'clone_node': {
        const cloneCount =
          (cmd.params?.count as number) ?? 1
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
      // (T7) and never errors; `order` echoes the requested ids that match.
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
          order: requested.filter(id => actualSet.has(id)),
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

      // create_component: the M3-B rebuild promotes nodeId OR builds-from-spec
      // then componentizes, echoing {id,key,name,type} + the converted spec so
      // the e2e can assert the spec atoms were parsed server-side. (The legacy
      // {combineAsVariants,nodeIds} / {slots} branches were retired in M3-E
      // alongside the old tools/create-component.ts handler.)
      case 'create_component': {
        const ccSpec = cmd.params?.spec as
          | Record<string, unknown>
          | undefined
        const ccNodeId = cmd.params?.nodeId as
          | string
          | undefined
        const ccName = cmd.params?.name as
          | string
          | undefined
        result = {
          id: `comp:${Math.random().toString(36).slice(2, 8)}`,
          key: `key:${Math.random().toString(36).slice(2, 8)}`,
          name:
            ccName ??
            (ccSpec?.name as string) ??
            'Component',
          type: 'COMPONENT',
          // echo the converted spec / source so tests can assert conversion + routing
          spec: ccSpec,
          sourceNodeId: ccNodeId,
        }
        break
      }

      // update_component: echo {id, propertyDefinitions, added, warnings}. An
      // `expose` list degrades (warn, never error) — exposeNestedInstances is
      // gated. addComponentProperty returns a CANONICAL id (`<name>#<suffix>`)
      // that agents need for later setProperties, so the mock mirrors the real
      // plugin by keying defs on that id and surfacing `added: [{name,id}]`.
      case 'update_component': {
        const ucId = cmd.params?.componentId as string
        const ucAdd = cmd.params?.add as
          | {
              name: string
              type: string
              defaultValue: string | boolean
            }[]
          | undefined
        const ucExpose = cmd.params?.expose as
          | string[]
          | undefined
        const ucWarnings: string[] = []
        const defs: Record<string, unknown> = {}
        const added: { name: string; id: string }[] = []
        if (ucAdd) {
          for (const p of ucAdd) {
            const propId = `${p.name}#1:0`
            defs[propId] = {
              type: p.type,
              defaultValue: p.defaultValue,
            }
            added.push({ name: p.name, id: propId })
          }
        }
        if (ucExpose && ucExpose.length > 0) {
          ucWarnings.push(
            'exposeNestedInstances unavailable in this Figma version; expose skipped',
          )
        }
        result = {
          id: ucId,
          propertyDefinitions: defs,
          added,
          warnings: ucWarnings,
        }
        break
      }

      // combine_variants: ids that aren't valid COMPONENTs are DROPPED with a
      // warning (honest partial success — never silently swallowed), mirroring
      // the real plugin. ≥2 SURVIVORS → a COMPONENT_SET; <2 → error (guarded
      // server-side too). The mock treats `bad:`-prefixed ids as not-a-component.
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
          name:
            (cmd.params?.name as string) ?? 'VariantSet',
          type: 'COMPONENT_SET',
          variantAxes: { Variant: { values: ['Default'] } },
          warnings: cvWarnings,
        }
        break
      }

      // swap_component: echo {id, mainComponent, warnings}. instanceId
      // `degrade:` → swap warns (T7), success not error. On a FAILED swap the
      // real plugin re-reads getMainComponentAsync() → the ORIGINAL main (the
      // swap never took), so the mock echoes the original main here too, NOT the
      // requested target. We derive the original id from the instance id
      // (`degrade:i9` → `orig:i9`) so it is deterministic and assertable.
      case 'swap_component': {
        const scId = cmd.params?.instanceId as string
        const scMain = cmd.params?.mainComponentId as string
        const scWarnings: string[] = []
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
            : scMain,
          warnings: scWarnings,
        }
        break
      }

      // set_instance: echo {id, componentProperties, warnings}. overrides → warn
      // (not applied); properties echoed back as componentProperties.
      case 'set_instance': {
        const siId = cmd.params?.instanceId as string
        const siProps = cmd.params?.properties as
          | Record<string, string | boolean>
          | undefined
        const siOverrides = cmd.params?.overrides as
          | unknown[]
          | undefined
        const siWarnings: string[] = []
        if (siOverrides && siOverrides.length > 0) {
          siWarnings.push(
            'Per-node overrides are not yet applied; ' +
              siOverrides.length +
              ' override(s) skipped',
          )
        }
        result = {
          id: siId,
          componentProperties: siProps ?? {},
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

      // delete_node: echo the deleted {id,name,type} (captured before removal).
      case 'delete_node':
        result = {
          id: cmd.params?.nodeId as string,
          name: 'Card',
          type: 'FRAME',
        }
        break

      // set_focus: CANVAS only — echo a viewport snapshot.
      case 'set_focus':
        result = {
          viewport: { center: { x: 0, y: 0 }, zoom: 1 },
        }
        break

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
      // (warnings, NO hash, NO error → success-with-warning); else a hash.
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
          imgUrl !== undefined ||
          imgBytes !== undefined
        ) {
          result = { hash: 'img:abc123' }
        } else {
          error = 'create_image requires url or bytes'
        }
        break
      }

      // set_plugin_data: echo {id}.
      case 'set_plugin_data':
        result = { id: cmd.params?.nodeId as string }
        break

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
      // (as `echo`) so the e2e can assert the parse reached the plugin, and
      // mirror the real reply { collectionId, modes, variables:[{id,name}] }.
      // T7: a collection name prefixed `err:` models the collection-level
      // factory THROWING — a genuine failure (nothing to return) → {error}, not
      // a degrade. A variable name prefixed `degrade:` models a per-variable
      // create / setValueForMode failure — it degrades to a warning and the rest
      // of the batch continues (never a throw, never {error}).
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
              }[]
            | undefined) ?? []
        const reqModes =
          (cmd.params?.modes as string[] | undefined) ?? []
        // The default mode is renamed to reqModes[0] when given, else 'Mode 1'.
        const modeNames =
          reqModes.length > 0 ? reqModes : ['Mode 1']
        const warnings: string[] = []
        const created: { id: string; name: string }[] = []
        inVars.forEach((v, i) => {
          if (v.name.startsWith('degrade:')) {
            warnings.push(
              `setValueForMode failed for variable "${v.name}"; value not set`,
            )
            return
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

      // create_styles: the server has CONVERTED the value atom (paint→Paint,
      // text→FontName, effect→Effect, grid→LayoutGrid). Echo it back + mirror
      // the real reply { id, key, name, type }.
      case 'create_styles': {
        result = {
          id: 'S:new',
          key: 'style-key',
          name: cmd.params?.name as string,
          type: cmd.params?.type as string,
          echo: cmd.params?.value,
        }
        break
      }

      // update_styles: a styleId starting with `err:` → {error}; `degrade:` →
      // success-with-warning. Else echo {id,warnings:[]} + the converted value.
      case 'update_styles': {
        const sId = cmd.params?.styleId as string
        if (sId.startsWith('err:')) {
          error = `Style not found: ${sId}`
        } else if (sId.startsWith('degrade:')) {
          result = {
            id: sId,
            warnings: [
              'value looks like a paint atom but the style is text; value not applied',
            ],
          }
        } else {
          result = {
            id: sId,
            warnings: [],
            echo: cmd.params?.value,
            valueType: cmd.params?.valueType,
          }
        }
        break
      }

      // apply_style: a nodeId starting with `err:` → {error}; `degrade:` →
      // success-with-warning ({id,warnings}, NEVER {error}); else {id,[]}.
      case 'apply_style': {
        const apNodeId = cmd.params?.nodeId as string
        if (apNodeId.startsWith('err:')) {
          error = `Node not found: ${apNodeId}`
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
    const { result, error } = runCommand(
      cmd.command,
      cmd.params,
    )

    // The real Figma plugin replies with { id, result|error } and NO command
    // (see figma-plugin/src/hooks/useRelay.ts). Mirror that here so the mock
    // exercises the real response shape through the relay's frame validation.
    const resolved: CommandMessage =
      error !== undefined
        ? { id: cmd.id, error }
        : { id: cmd.id, result }

    const reply: ChannelMessage = {
      type: 'message',
      channel,
      message: resolved,
    }

    socket.send(JSON.stringify(reply))
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
              fileName: documentName ?? null,
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

  return { start, stop }
}
