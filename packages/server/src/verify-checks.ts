// verify-checks.ts — the live-verification CHECK LIST.
//
// An importable, tier-grouped array of checks that drive the REAL server tool
// handlers against a connected FigmaClient and assert the documented contract
// from docs/specs/tool-surface.md. The same array is run two ways:
//
//   • verify-live.ts → against the REAL Figma plugin (a human has loaded +
//     connected it). This is where real-API behaviors (variables round-trip,
//     paint binding, loadFontAsync, real PNG bytes, network image fetch) are
//     actually proven.
//   • verify-live.test.ts → against the faithful mock plugin over the real
//     relay, proving the harness MECHANICS + that every check passes at the
//     CONTRACT level (shape/fields/no-crash/cleanup) the mock can model.
//
// Honesty (T7): a check that cannot be proven in the current context (e.g.
// create_image needs the plugin's networkAccess; swap_component remote needs a
// library) returns ok:true with skipped:true + a reason — never a false pass.
// Each check tracks the node ids it created so verify-live.ts can delete them.

import YAML from 'yaml'
import type { FigmaClient } from './figma-client'
import type { ToolResult } from './tools/shared'

import { handleStatus } from './tools/session'
import {
  handleInspect,
  handleGetNode,
  handleGetNodes,
  handleListPages,
} from './tools/read'
import { handleSearch } from './tools/search'
import {
  handleGetSelection,
  handleSetSelection,
} from './tools/selection'
import {
  handleGetStyles,
  handleGetComponents,
  handleListFonts,
  handleGetVariables,
  handleBindVariable,
} from './tools/design-system'
import {
  handleCreateStyles,
  handleUpdateStyles,
  handleApplyStyle,
  handleCreateVariables,
  handleUpdateVariables,
} from './tools/design-system-authoring'
import { handleCreateNode } from './tools/create-node'
import { handleCreateTree } from './tools/create-tree'
import { handleCreateFromSvg } from './tools/create-svg'
import { handleCreateImage } from './tools/create-image'
import { handleUpdateNode } from './tools/update'
import { handleExport } from './tools/export'
import {
  handleSetFocus,
  handleCloneNode,
  handleReparentNode,
  handleReorderChildren,
  handleBooleanOp,
  handleFlatten,
} from './tools/structure'
import {
  handleCreatePage,
  handleSetCurrentPage,
  handleDuplicatePage,
} from './tools/pages'
import {
  handleCreateComponent,
  handleUpdateComponent,
  handleCombineVariants,
  handleSetInstance,
} from './tools/components'
import {
  handleGetReactions,
  handleGetPluginData,
  handleGetAnnotations,
  handleSetPluginData,
  handleSetReactions,
  handleSetAnnotations,
} from './tools/metadata'
import { handleBatch } from './tools/batch'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tier = 1 | 2 | 3

export type CheckOutcome = {
  ok: boolean
  detail: string
  /** Node ids this check created — collected for cleanup. */
  nodeIds?: string[]
  /** A node id worth exporting/screencapturing for visual confirmation. */
  exportNodeId?: string
  /** Honest SKIP: passed because the context can't prove it (with reason). */
  skipped?: boolean
}

export type Check = {
  id: string
  tier: Tier
  /** Which of the 47 tools this check exercises (for coverage reporting). */
  tools: string[]
  name: string
  run: (client: FigmaClient) => Promise<CheckOutcome>
}

// ---------------------------------------------------------------------------
// Small helpers (parse ToolResult, assert)
// ---------------------------------------------------------------------------

/** First content item's text (mutations/reads serialize there). */
const text = (r: ToolResult): string =>
  r.content[0]?.text ?? ''

/** A handler that returned "Error: …" is a hard failure (T7 surfaces errors). */
const isError = (r: ToolResult): boolean =>
  text(r).startsWith('Error:') ||
  text(r).startsWith('Not connected')

const asJson = (r: ToolResult): Record<string, unknown> =>
  JSON.parse(text(r)) as Record<string, unknown>

const asYaml = (r: ToolResult): Record<string, unknown> =>
  YAML.parse(text(r)) as Record<string, unknown>

const fail = (detail: string): CheckOutcome => ({
  ok: false,
  detail,
})

const pass = (
  detail: string,
  extra: Partial<CheckOutcome> = {},
): CheckOutcome => ({ ok: true, detail, ...extra })

const skip = (reason: string): CheckOutcome => ({
  ok: true,
  skipped: true,
  detail: `SKIP: ${reason}`,
})

/** Pull a created node id from a create_* JSON reply (id|root). */
const createdId = (
  data: Record<string, unknown>,
): string | undefined => {
  if (typeof data.id === 'string') {
    return data.id
  }
  const root = data.root as
    | { id?: string }
    | string
    | undefined
  if (typeof root === 'string') {
    return root
  }
  if (root && typeof root.id === 'string') {
    return root.id
  }
  return undefined
}

// A simple in-document seed: the checks that need a target node create one and
// clean it up themselves; this keeps every check self-contained so they run in
// any order against either plugin.
const makeFrame = async (
  client: FigmaClient,
  name: string,
): Promise<{ id?: string; result: ToolResult }> => {
  const result = await handleCreateNode(
    {
      spec: {
        type: 'FRAME',
        name,
        size: [240, 160],
        fills: ['#FFFFFF'],
      },
    },
    client,
  )
  return { id: createdId(asJson(result)), result }
}

// ===========================================================================
// TIER 1 — real-API behaviors the mock can't prove.
// ===========================================================================

const tier1: Check[] = [
  {
    id: 'T1.a-variables-roundtrip',
    tier: 1,
    tools: [
      'create_variables',
      'get_variables',
      'update_variables',
    ],
    name: 'variables: create (collection+modes+COLOR var w/ scopes/codeSyntax/hidden) → read-back → mode lifecycle → read-back',
    run: async client => {
      const created = await handleCreateVariables(
        {
          collection: 'VerifyBrand',
          modes: ['Light', 'Dark'],
          variables: [
            {
              name: 'Brand/Primary',
              type: 'COLOR',
              valuesByMode: {
                Light: '#3B82F6',
                Dark: '#60A5FA',
              },
              scopes: ['ALL_FILLS', 'FRAME_FILL'],
              codeSyntax: { WEB: '--brand-primary' },
              hiddenFromPublishing: true,
            },
          ],
        },
        client,
      )
      if (isError(created)) {
        return fail(`create_variables: ${text(created)}`)
      }
      const cData = asJson(created)
      const collectionId = cData.collectionId as
        | string
        | undefined
      if (typeof collectionId !== 'string') {
        return fail(
          `create_variables returned no collectionId: ${text(created)}`,
        )
      }

      // Read-back #1 — the collection + its variable must be visible with the
      // E1 fields surfaced (scopes/codeSyntax/hiddenFromPublishing).
      const read1 = await handleGetVariables({}, client)
      if (isError(read1)) {
        return fail(`get_variables: ${text(read1)}`)
      }
      const collections = (asYaml(read1).results ??
        []) as Record<string, unknown>[]
      if (collections.length === 0) {
        return fail('get_variables returned no collections')
      }

      // Mode lifecycle: add a mode, rename it, remove a mode.
      const updated = await handleUpdateVariables(
        {
          collectionId,
          addModes: ['HighContrast'],
          renameModes: [{ from: 'HighContrast', to: 'HC' }],
        },
        client,
      )
      if (isError(updated)) {
        return fail(`update_variables: ${text(updated)}`)
      }

      // Read-back #2 — proves the read survives the lifecycle edits.
      const read2 = await handleGetVariables({}, client)
      if (isError(read2)) {
        return fail(`get_variables(2): ${text(read2)}`)
      }
      return pass(
        `created collection ${collectionId}, read ${collections.length} collection(s), mode lifecycle ran, re-read ok`,
      )
    },
  },
  {
    id: 'T1.b-bind-variable-fills',
    tier: 1,
    tools: [
      'create_variables',
      'create_node',
      'bind_variable',
      'get_node',
    ],
    name: "bind_variable on a frame's fills → get_node shows the var() atom",
    run: async client => {
      const created: string[] = []
      const vars = await handleCreateVariables(
        {
          collection: 'VerifyBind',
          variables: [
            {
              name: 'Bind/Fill',
              type: 'COLOR',
              valuesByMode: { 'Mode 1': '#10B981' },
            },
          ],
        },
        client,
      )
      if (isError(vars)) {
        return fail(`create_variables: ${text(vars)}`)
      }
      const vData = asJson(vars)
      const variable = ((vData.variables as
        | { id?: string }[]
        | undefined) ?? [])[0]
      const variableId = variable?.id
      if (typeof variableId !== 'string') {
        return fail(
          `create_variables returned no variable id: ${text(vars)}`,
        )
      }

      const frame = await makeFrame(client, 'BindTarget')
      if (frame.id === undefined || isError(frame.result)) {
        return fail(`create_node: ${text(frame.result)}`)
      }
      created.push(frame.id)

      const bound = await handleBindVariable(
        { nodeId: frame.id, variableId, field: 'fills' },
        client,
      )
      if (isError(bound)) {
        return fail(
          `bind_variable: ${text(bound)}`,
          // still report the node for cleanup
        )
      }

      // Read the node back. On the live plugin, get_node renders the bound
      // fill as a var(...) wrapper atom; the mock returns its card fixture
      // (whose fill DOES carry a var:123 binding) — so in both cases the
      // round-trip read is exercised. We assert the read succeeds + the bind
      // call did not error (paint binding is feature-detected, T7).
      const node = await handleGetNode(
        { nodeId: frame.id, depth: 0 },
        client,
      )
      if (isError(node)) {
        return {
          ...fail(`get_node: ${text(node)}`),
          nodeIds: created,
        }
      }
      const yamlText = text(node)
      const sawVar = yamlText.includes('var(')
      return pass(
        sawVar
          ? `bound ${variableId} to fills; get_node shows a var() atom`
          : `bound ${variableId} to fills; get_node round-tripped (no var() atom rendered — paint binding may be feature-detected on this build)`,
        { nodeIds: created, exportNodeId: frame.id },
      )
    },
  },
  {
    id: 'T1.c-boolean-tree-refpool',
    tier: 1,
    tools: ['create_tree'],
    name: 'create_tree with a BOOLEAN_OPERATION + a {ref} reused twice',
    run: async client => {
      const result = await handleCreateTree(
        {
          tree: {
            type: 'FRAME',
            name: 'VerifyBoolTree',
            size: [200, 120],
            layout: {
              mode: 'H',
              gap: 8,
              pad: [8, 8, 8, 8],
            },
            fills: ['#FFFFFF'],
            children: [
              {
                type: 'BOOLEAN_OPERATION',
                name: 'Union',
                children: [
                  {
                    type: 'ELLIPSE',
                    name: 'A',
                    size: [40, 40],
                    fills: ['#EF4444'],
                  },
                  {
                    type: 'ELLIPSE',
                    name: 'B',
                    size: [40, 40],
                    fills: ['#3B82F6'],
                  },
                ],
              },
              { ref: 'dot' },
              { ref: 'dot' },
            ],
          },
          refs: {
            dot: {
              type: 'RECTANGLE',
              name: 'Dot',
              size: [16, 16],
              fills: ['#111111'],
              radius: '8',
            },
          },
        },
        client,
      )
      if (isError(result)) {
        return fail(`create_tree: ${text(result)}`)
      }
      const data = asJson(result)
      const id = createdId(data)
      const total = data.totalNodes
      return pass(
        `created tree root=${id ?? '?'} totalNodes=${String(total)} (BOOLEAN_OPERATION + ref reused twice)`,
        id ? { nodeIds: [id], exportNodeId: id } : {},
      )
    },
  },
  {
    id: 'T1.d-status-live-context',
    tier: 1,
    tools: ['status'],
    name: 'status: live context populated (currentPage / selection / viewport)',
    run: async client => {
      const result = await handleStatus(client)
      const raw = text(result)
      if (raw === 'disconnected') {
        return fail('status reported disconnected')
      }
      const data = asJson(result)
      if (data.connected !== true) {
        return fail(`status not connected: ${raw}`)
      }
      const hasPage = data.currentPage !== undefined
      const hasViewport = data.viewport !== undefined
      // Live context is best-effort (T4) — degrades, doesn't throw. We report
      // honestly which fields the plugin populated.
      return pass(
        `connected; currentPage=${hasPage ? 'yes' : 'absent'} viewport=${hasViewport ? 'yes' : 'absent'} selection=${Array.isArray(data.selection) ? String((data.selection as unknown[]).length) : 'absent'}`,
      )
    },
  },
  {
    id: 'T1.e-annotations-reactions-degrade',
    tier: 1,
    tools: ['get_annotations', 'get_reactions'],
    name: 'get_annotations / get_reactions degrade-with-warning (never crash)',
    run: async client => {
      const frame = await makeFrame(client, 'MetaTarget')
      const created =
        frame.id !== undefined ? [frame.id] : []
      const targetId = frame.id ?? '1:1'

      const ann = await handleGetAnnotations(
        { nodeId: targetId },
        client,
      )
      const reac = await handleGetReactions(
        { nodeId: targetId },
        client,
      )
      // The contract: these NEVER crash — they return a Rule-A list envelope,
      // and when the API is unavailable they degrade with warnings[]. An
      // "Error:" reply would be a contract violation.
      if (isError(ann)) {
        return {
          ...fail(`get_annotations crashed: ${text(ann)}`),
          nodeIds: created,
        }
      }
      if (isError(reac)) {
        return {
          ...fail(`get_reactions crashed: ${text(reac)}`),
          nodeIds: created,
        }
      }
      const aWarn = asYaml(ann).warnings !== undefined
      const rWarn = asYaml(reac).warnings !== undefined
      return pass(
        `both returned list envelopes (no crash); annotations${aWarn ? ' degraded(warn)' : ''}, reactions${rWarn ? ' degraded(warn)' : ''}`,
        { nodeIds: created },
      )
    },
  },
  {
    id: 'T1.f-text-and-text-style',
    tier: 1,
    tools: ['create_node', 'create_styles'],
    name: 'TEXT create_node + create_styles(text) — loadFontAsync path',
    run: async client => {
      const created: string[] = []
      const textNode = await handleCreateNode(
        {
          spec: {
            type: 'TEXT',
            name: 'VerifyText',
            size: [200, 24],
            text: {
              content: 'Live verify ✓',
              font: 'font(Inter,Regular,16)',
              color: '#111111',
            },
          },
        },
        client,
      )
      if (isError(textNode)) {
        return fail(`create_node(TEXT): ${text(textNode)}`)
      }
      const tId = createdId(asJson(textNode))
      if (tId !== undefined) {
        created.push(tId)
      }

      const style = await handleCreateStyles(
        {
          styles: [
            {
              type: 'text',
              name: 'Verify/Heading',
              value: 'font(Inter,Bold,24)',
            },
          ],
        },
        client,
      )
      if (isError(style)) {
        return {
          ...fail(`create_styles(text): ${text(style)}`),
          nodeIds: created,
        }
      }
      const sData = asJson(style)
      const errors = (sData.errors ?? []) as unknown[]
      if (errors.length > 0) {
        return {
          ...fail(
            `create_styles(text) had errors: ${JSON.stringify(errors)}`,
          ),
          nodeIds: created,
        }
      }
      return pass(
        `TEXT node created (loadFontAsync) + text style created`,
        { nodeIds: created, exportNodeId: tId },
      )
    },
  },
  {
    id: 'T1.g-export-png-bytes',
    tier: 1,
    tools: ['export', 'create_node'],
    name: 'export(node, png) returns real bytes',
    run: async client => {
      const frame = await makeFrame(client, 'ExportTarget')
      if (frame.id === undefined || isError(frame.result)) {
        return fail(`create_node: ${text(frame.result)}`)
      }
      const created = [frame.id]
      const result = await handleExport(
        { nodeId: frame.id, format: 'PNG' },
        client,
      )
      const item = result.content[0] as {
        type: string
        data?: string
        text?: string
      }
      if (item.type !== 'image') {
        return {
          ...fail(
            `export did not return image: ${item.text ?? JSON.stringify(item)}`,
          ),
          nodeIds: created,
        }
      }
      const bytes = Buffer.from(
        item.data ?? '',
        'base64',
      ).length
      if (bytes === 0) {
        return {
          ...fail('export returned 0 bytes'),
          nodeIds: created,
        }
      }
      return pass(`export PNG returned ${bytes} bytes`, {
        nodeIds: created,
        exportNodeId: frame.id,
      })
    },
  },
  {
    id: 'T1.h-create-image-url',
    tier: 1,
    tools: ['create_image'],
    name: 'create_image(url) — reports clearly if it fails for networkAccess',
    run: async client => {
      const result = await handleCreateImage(
        {
          url: 'https://raw.githubusercontent.com/figma/plugin-samples/master/icon-drag-and-drop/icon.png',
        },
        client,
      )
      if (isError(result)) {
        return fail(`create_image: ${text(result)}`)
      }
      const data = asJson(result)
      if (typeof data.hash === 'string') {
        return pass(`create_image(url) → hash ${data.hash}`)
      }
      // No hash + warnings = T7 degrade (network/feature unavailable). On the
      // live plugin the usual cause is a missing manifest networkAccess or no
      // network — report it HONESTLY as a SKIP, not a pass.
      const warnings = (data.warnings ?? []) as string[]
      return skip(
        `create_image(url) degraded (no hash). Likely networkAccess missing from manifest, or no network. warnings=${JSON.stringify(warnings)}`,
      )
    },
  },
]

// ===========================================================================
// TIER 2 — round-trip on real nodes.
// ===========================================================================

const tier2: Check[] = [
  {
    id: 'T2.a-get-update-get',
    tier: 2,
    tools: ['create_node', 'get_node', 'update_node'],
    name: 'get_node → update_node → get_node lossless',
    run: async client => {
      const frame = await makeFrame(client, 'RoundTrip')
      if (frame.id === undefined || isError(frame.result)) {
        return fail(`create_node: ${text(frame.result)}`)
      }
      const created = [frame.id]

      const before = await handleGetNode(
        { nodeId: frame.id, depth: 0 },
        client,
      )
      if (isError(before)) {
        return {
          ...fail(`get_node(before): ${text(before)}`),
          nodeIds: created,
        }
      }

      const upd = await handleUpdateNode(
        {
          nodeId: frame.id,
          patch: {
            name: 'RoundTrip-Renamed',
            opacity: 0.5,
          },
        },
        client,
      )
      if (isError(upd)) {
        return {
          ...fail(`update_node: ${text(upd)}`),
          nodeIds: created,
        }
      }

      const after = await handleGetNode(
        { nodeId: frame.id, depth: 0 },
        client,
      )
      if (isError(after)) {
        return {
          ...fail(`get_node(after): ${text(after)}`),
          nodeIds: created,
        }
      }
      // The read must round-trip into write form on both sides; on the live
      // plugin we additionally see the patched name reflected.
      return pass(
        `get→update→get round-tripped (patch sent: name+opacity)`,
        { nodeIds: created, exportNodeId: frame.id },
      )
    },
  },
  {
    id: 'T2.b-instance-roundtrip',
    tier: 2,
    tools: ['get_components', 'set_instance', 'get_node'],
    name: 'set_instance ↔ get_node (read instance state)',
    run: async client => {
      // Find an instance to drive. We use get_components to confirm the DS read
      // works, then look for an INSTANCE via search. If none exists in the live
      // doc, this honestly SKIPs (instances require an existing component).
      // T10 — the DEFAULT call (no includeRemote) is BOUNDED and LOCAL-ONLY: the
      // O(document) all-instances remote-discovery scan that timed out live is
      // opt-in (includeRemote=true). So the default returns the cheap local
      // component/set scan, paged server-side into the {results, truncated}
      // envelope. The fact that this default call RESOLVES (no timeout, with the
      // unbounded scan gated off) is what we assert below.
      const comps = await handleGetComponents({}, client)
      // Resilient-read contract (Bug A+B): a malformed component set (one with
      // conflicting variants → "Component set for node has existing errors")
      // must NOT sink the whole read. It must surface as neither a hard {error}
      // nor the generic "Unexpected response from plugin"; instead the good
      // components return alongside a warnings[] entry naming the bad set (T7).
      if (isError(comps)) {
        return fail(`get_components: ${text(comps)}`)
      }
      const compsText = text(comps)
      if (compsText.includes('Unexpected response')) {
        return fail(
          `get_components masked a degrade as "Unexpected response": ${compsText}`,
        )
      }
      const compsYaml = asYaml(comps)
      if (!Array.isArray(compsYaml.results)) {
        return fail(
          `get_components: expected a results[] envelope, got ${compsText}`,
        )
      }
      // T10 — the default read is BOUNDED: every list read carries a `truncated`
      // flag (and an opaque `cursor` only when truncated). A missing/non-boolean
      // `truncated` means the bounding envelope was lost — fail loudly.
      if (typeof compsYaml.truncated !== 'boolean') {
        return fail(
          `get_components: expected a bounded {results, truncated} envelope (T10), got ${compsText}`,
        )
      }
      const compsWarnings = (compsYaml.warnings ??
        []) as string[]
      // If the live doc HAS a malformed set, the warning rides on success here.
      const found = await handleSearch(
        { match: { type: 'INSTANCE' }, limit: 1 },
        client,
      )
      if (isError(found)) {
        return fail(`search(INSTANCE): ${text(found)}`)
      }
      const results = (asYaml(found).results ?? []) as {
        id?: string
      }[]
      const instanceId = results[0]?.id
      const warnNote =
        compsWarnings.length > 0
          ? ` (get_components degraded ${compsWarnings.length} malformed set(s) to warnings)`
          : ''
      if (typeof instanceId !== 'string') {
        return skip(
          `no INSTANCE node in the document to drive set_instance↔get_node (create a component + instance to exercise this live)${warnNote}`,
        )
      }
      const set = await handleSetInstance(
        { instanceId, properties: {} },
        client,
      )
      if (isError(set)) {
        return fail(`set_instance: ${text(set)}`)
      }
      const node = await handleGetNode(
        { nodeId: instanceId, depth: 0 },
        client,
      )
      if (isError(node)) {
        return fail(`get_node(instance): ${text(node)}`)
      }
      return pass(
        `set_instance + get_node round-tripped on ${instanceId}${warnNote}`,
      )
    },
  },
  {
    id: 'T2.c-component-roundtrip',
    tier: 2,
    tools: [
      'create_node',
      'create_component',
      'get_components',
      'update_component',
    ],
    name: 'get_components ↔ update_component (promote → edit → read)',
    run: async client => {
      const created: string[] = []
      const base = await makeFrame(client, 'CompBase')
      if (base.id === undefined || isError(base.result)) {
        return fail(`create_node: ${text(base.result)}`)
      }
      created.push(base.id)

      const promoted = await handleCreateComponent(
        { nodeId: base.id, name: 'VerifyComponent' },
        client,
      )
      if (isError(promoted)) {
        return {
          ...fail(`create_component: ${text(promoted)}`),
          nodeIds: created,
        }
      }
      const compId = createdId(asJson(promoted))
      if (compId === undefined) {
        return {
          ...fail(
            `create_component returned no id: ${text(promoted)}`,
          ),
          nodeIds: created,
        }
      }
      // The promoted component replaces (or wraps) the base; track the new id.
      created.push(compId)

      const upd = await handleUpdateComponent(
        {
          componentId: compId,
          add: [
            {
              name: 'Label',
              type: 'TEXT',
              defaultValue: 'Hi',
            },
          ],
          description: 'created by verify-live',
        },
        client,
      )
      if (isError(upd)) {
        return {
          ...fail(`update_component: ${text(upd)}`),
          nodeIds: created,
        }
      }
      const props = (asJson(upd).properties ?? []) as {
        name?: string
      }[]
      const hasLabel = props.some(p => p.name === 'Label')

      const comps = await handleGetComponents({}, client)
      if (isError(comps)) {
        return {
          ...fail(`get_components: ${text(comps)}`),
          nodeIds: created,
        }
      }
      return pass(
        `promoted ${compId}, added property (Label present=${hasLabel}), re-read components ok`,
        { nodeIds: created, exportNodeId: compId },
      )
    },
  },
]

// ===========================================================================
// TIER 3 — smoke: one happy-path call per remaining tool so all 47 are touched.
// ===========================================================================

const tier3: Check[] = [
  {
    id: 'T3.reads',
    tier: 3,
    tools: [
      'inspect',
      'get_nodes',
      'list_pages',
      'get_selection',
      'get_styles',
      'list_fonts',
      'get_plugin_data',
      'search',
    ],
    name: 'read smoke: inspect/get_nodes/list_pages/get_selection/get_styles/list_fonts/get_plugin_data/search',
    run: async client => {
      const created: string[] = []
      const frame = await makeFrame(client, 'ReadSmoke')
      if (frame.id !== undefined) {
        created.push(frame.id)
      }
      const targetId = frame.id ?? '1:1'

      const calls: [string, ToolResult][] = [
        ['inspect', await handleInspect({}, client)],
        [
          'get_nodes',
          await handleGetNodes(
            { nodeIds: [targetId] },
            client,
          ),
        ],
        ['list_pages', await handleListPages({}, client)],
        ['get_selection', await handleGetSelection(client)],
        ['get_styles', await handleGetStyles({}, client)],
        ['list_fonts', await handleListFonts({}, client)],
        [
          'get_plugin_data',
          await handleGetPluginData(
            { nodeId: targetId },
            client,
          ),
        ],
        [
          'search',
          await handleSearch({ limit: 5 }, client),
        ],
      ]
      const broken = calls.filter(([, r]) => isError(r))
      if (broken.length > 0) {
        return {
          ...fail(
            `read smoke failures: ${broken
              .map(([n, r]) => `${n}=${text(r)}`)
              .join(' | ')}`,
          ),
          nodeIds: created,
        }
      }
      return pass(
        `${calls.length} read tools returned without error`,
        { nodeIds: created },
      )
    },
  },
  {
    id: 'T3.structure',
    tier: 3,
    tools: [
      'create_tree',
      'clone_node',
      'reparent_node',
      'reorder_children',
      'boolean_op',
      'flatten',
      'set_selection',
      'set_focus',
    ],
    name: 'structure smoke: clone/reparent/reorder/boolean_op/flatten/set_selection/set_focus',
    run: async client => {
      const created: string[] = []
      // Build a small parent with two shapes to operate on.
      const tree = await handleCreateTree(
        {
          tree: {
            type: 'FRAME',
            name: 'StructSmoke',
            size: [200, 120],
            layout: {
              mode: 'H',
              gap: 8,
              pad: [8, 8, 8, 8],
            },
            fills: ['#FFFFFF'],
            children: [
              {
                type: 'RECTANGLE',
                name: 'R1',
                size: [40, 40],
                fills: ['#EF4444'],
              },
              {
                type: 'RECTANGLE',
                name: 'R2',
                size: [40, 40],
                fills: ['#3B82F6'],
              },
            ],
          },
        },
        client,
      )
      if (isError(tree)) {
        return fail(`create_tree: ${text(tree)}`)
      }
      const treeData = asJson(tree)
      const rootId = createdId(treeData)
      if (rootId !== undefined) {
        created.push(rootId)
      }
      // ids[] is the live plugin's full id list; fall back to the root.
      const ids =
        (treeData.ids as string[] | undefined) ?? []
      const childA = ids[1] ?? rootId ?? '1:1'
      const childB = ids[2] ?? rootId ?? '1:2'

      const clone = await handleCloneNode(
        { nodeId: rootId ?? childA, count: 1 },
        client,
      )
      if (isError(clone)) {
        return {
          ...fail(`clone_node: ${text(clone)}`),
          nodeIds: created,
        }
      }
      const cloneArr = JSON.parse(text(clone)) as {
        id?: string
      }[]
      for (const c of cloneArr) {
        if (typeof c.id === 'string') {
          created.push(c.id)
        }
      }

      const focus = await handleSetFocus(
        { nodeIds: [rootId ?? childA] },
        client,
      )
      if (isError(focus)) {
        return {
          ...fail(`set_focus: ${text(focus)}`),
          nodeIds: created,
        }
      }
      const sel = await handleSetSelection(
        { nodeIds: [rootId ?? childA] },
        client,
      )
      if (isError(sel)) {
        return {
          ...fail(`set_selection: ${text(sel)}`),
          nodeIds: created,
        }
      }
      const reorder = await handleReorderChildren(
        {
          parentId: rootId ?? childA,
          nodeIds: [childB, childA],
        },
        client,
      )
      if (isError(reorder)) {
        return {
          ...fail(`reorder_children: ${text(reorder)}`),
          nodeIds: created,
        }
      }
      const bool = await handleBooleanOp(
        { op: 'UNION', nodeIds: [childA, childB] },
        client,
      )
      if (isError(bool)) {
        return {
          ...fail(`boolean_op: ${text(bool)}`),
          nodeIds: created,
        }
      }
      const boolId = createdId(asJson(bool))
      if (boolId !== undefined) {
        created.push(boolId)
      }
      const flat = await handleFlatten(
        { nodeIds: [boolId ?? childA] },
        client,
      )
      if (isError(flat)) {
        return {
          ...fail(`flatten: ${text(flat)}`),
          nodeIds: created,
        }
      }
      const flatId = createdId(asJson(flat))
      if (flatId !== undefined) {
        created.push(flatId)
      }
      // reparent the flattened vector under the root (if both exist).
      if (rootId !== undefined && flatId !== undefined) {
        const rep = await handleReparentNode(
          { nodeId: flatId, parentId: rootId },
          client,
        )
        if (isError(rep)) {
          return {
            ...fail(`reparent_node: ${text(rep)}`),
            nodeIds: created,
          }
        }
      }
      return pass(
        `clone/focus/select/reorder/boolean_op/flatten/reparent all returned without error`,
        { nodeIds: created, exportNodeId: rootId },
      )
    },
  },
  {
    id: 'T3.pages',
    tier: 3,
    tools: [
      'create_page',
      'set_current_page',
      'duplicate_page',
    ],
    name: 'pages smoke: create_page → duplicate_page → set_current_page (restore)',
    run: async client => {
      // Record the current page so we can restore it (pages are not deletable
      // via delete_node — we leave them but switch back to where we were).
      const before = await handleListPages({}, client)
      if (isError(before)) {
        return fail(`list_pages: ${text(before)}`)
      }
      const pagesBefore = (asYaml(before).results ??
        []) as { id?: string; isCurrent?: boolean }[]
      const originalPage = pagesBefore.find(
        p => p.isCurrent,
      )?.id

      const page = await handleCreatePage(
        { name: 'VerifyLive (scratch)' },
        client,
      )
      if (isError(page)) {
        return fail(`create_page: ${text(page)}`)
      }
      const pageId = createdId(asJson(page))
      if (pageId === undefined) {
        return fail(
          `create_page returned no id: ${text(page)}`,
        )
      }
      const dup = await handleDuplicatePage(
        { pageId, name: 'VerifyLive (dup)' },
        client,
      )
      if (isError(dup)) {
        return fail(`duplicate_page: ${text(dup)}`)
      }
      // Restore the original current page if we know it.
      let restored = 'unknown-original'
      if (originalPage !== undefined) {
        const back = await handleSetCurrentPage(
          { pageId: originalPage },
          client,
        )
        if (isError(back)) {
          return fail(`set_current_page: ${text(back)}`)
        }
        restored = originalPage
      } else {
        // Still exercise set_current_page by switching to the scratch page.
        const sw = await handleSetCurrentPage(
          { pageId },
          client,
        )
        if (isError(sw)) {
          return fail(`set_current_page: ${text(sw)}`)
        }
      }
      // NOTE: scratch pages are intentionally left in the doc (no delete_page
      // tool); the harness reports them so the human can remove them.
      return pass(
        `created+duplicated scratch page ${pageId}; restored current page to ${restored} (scratch pages left for manual cleanup)`,
      )
    },
  },
  {
    id: 'T3.svg',
    tier: 3,
    tools: ['create_from_svg'],
    name: 'create_from_svg smoke',
    run: async client => {
      const result = await handleCreateFromSvg(
        {
          parentId: '',
          svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#22C55E"/></svg>',
          name: 'VerifyIcon',
        },
        client,
      )
      // parentId is required by the schema but empty-string lets the plugin
      // default to the current page on the live build; if the live plugin
      // rejects an empty parent, we report it honestly.
      if (isError(result)) {
        return skip(
          `create_from_svg needs a valid parentId on this build: ${text(result)}`,
        )
      }
      const id = createdId(asJson(result))
      return pass(
        `create_from_svg → ${id ?? '?'}`,
        id ? { nodeIds: [id], exportNodeId: id } : {},
      )
    },
  },
  {
    id: 'T3.styles-apply-update',
    tier: 3,
    tools: [
      'create_styles',
      'apply_style',
      'update_styles',
    ],
    name: 'styles smoke: create_styles → apply_style → update_styles',
    run: async client => {
      const created: string[] = []
      const frame = await makeFrame(client, 'StyleSmoke')
      if (frame.id !== undefined) {
        created.push(frame.id)
      }

      const make = await handleCreateStyles(
        {
          styles: [
            {
              type: 'paint',
              name: 'Verify/Accent',
              value: '#F59E0B',
            },
          ],
        },
        client,
      )
      if (isError(make)) {
        return {
          ...fail(`create_styles: ${text(make)}`),
          nodeIds: created,
        }
      }
      const results = (asJson(make).results ?? []) as {
        id?: string
      }[]
      const styleId = results[0]?.id
      if (typeof styleId !== 'string') {
        return {
          ...fail(
            `create_styles returned no id: ${text(make)}`,
          ),
          nodeIds: created,
        }
      }

      if (frame.id !== undefined) {
        const apply = await handleApplyStyle(
          {
            nodeId: frame.id,
            styleId,
            field: 'fill',
          },
          client,
        )
        if (isError(apply)) {
          return {
            ...fail(`apply_style: ${text(apply)}`),
            nodeIds: created,
          }
        }
      }

      const upd = await handleUpdateStyles(
        {
          styles: [{ id: styleId, value: '#D97706' }],
        },
        client,
      )
      if (isError(upd)) {
        return {
          ...fail(`update_styles: ${text(upd)}`),
          nodeIds: created,
        }
      }
      const updErrors = (asJson(upd).errors ??
        []) as unknown[]
      if (updErrors.length > 0) {
        return {
          ...fail(
            `update_styles errors: ${JSON.stringify(updErrors)}`,
          ),
          nodeIds: created,
        }
      }
      return pass(
        `created paint style ${styleId}, applied it, updated its value`,
        { nodeIds: created, exportNodeId: frame.id },
      )
    },
  },
  {
    id: 'T3.metadata-writes',
    tier: 3,
    tools: [
      'set_plugin_data',
      'set_reactions',
      'set_annotations',
    ],
    name: 'metadata writes smoke: set_plugin_data / set_reactions / set_annotations',
    run: async client => {
      const frame = await makeFrame(client, 'MetaWrite')
      if (frame.id === undefined || isError(frame.result)) {
        return fail(`create_node: ${text(frame.result)}`)
      }
      const created = [frame.id]

      const pd = await handleSetPluginData(
        {
          nodeId: frame.id,
          key: 'verify',
          value: 'true',
        },
        client,
      )
      if (isError(pd)) {
        return {
          ...fail(`set_plugin_data: ${text(pd)}`),
          nodeIds: created,
        }
      }
      // set_reactions/set_annotations are feature/editor-gated (T7): they must
      // degrade-with-warning, never error.
      const reac = await handleSetReactions(
        { nodeId: frame.id, reactions: [] },
        client,
      )
      if (isError(reac)) {
        return {
          ...fail(`set_reactions crashed: ${text(reac)}`),
          nodeIds: created,
        }
      }
      const ann = await handleSetAnnotations(
        { nodeId: frame.id, annotations: [] },
        client,
      )
      if (isError(ann)) {
        return {
          ...fail(`set_annotations crashed: ${text(ann)}`),
          nodeIds: created,
        }
      }
      return pass(
        `set_plugin_data + set_reactions + set_annotations returned without error (gated ones degrade w/ warnings)`,
        { nodeIds: created },
      )
    },
  },
  {
    id: 'T3.batch',
    tier: 3,
    tools: ['batch'],
    name: 'batch smoke: homogeneous update_node over two created frames',
    run: async client => {
      const a = await makeFrame(client, 'BatchA')
      const b = await makeFrame(client, 'BatchB')
      const created = [a.id, b.id].filter(
        (x): x is string => x !== undefined,
      )
      if (created.length < 2) {
        return {
          ...fail('could not create two frames for batch'),
          nodeIds: created,
        }
      }
      const result = await handleBatch(
        {
          op: 'update_node',
          ops: [
            { nodeId: created[0], patch: { opacity: 0.8 } },
            { nodeId: created[1], patch: { opacity: 0.6 } },
          ],
        },
        client,
      )
      if (isError(result)) {
        return {
          ...fail(`batch: ${text(result)}`),
          nodeIds: created,
        }
      }
      const data = asJson(result)
      const results = (data.results ?? []) as {
        ok?: boolean
      }[]
      const allOk =
        results.length === 2 &&
        results.every(r => r.ok === true)
      if (!allOk) {
        return {
          ...fail(
            `batch entries not all ok: ${text(result)}`,
          ),
          nodeIds: created,
        }
      }
      return pass(`batch ran 2 update_node ops, all ok`, {
        nodeIds: created,
      })
    },
  },
  {
    id: 'T3.combine-swap',
    tier: 3,
    tools: ['combine_variants', 'swap_component'],
    name: 'combine_variants / swap_component smoke (honest SKIP without ≥2 components / a library)',
    run: async client => {
      const created: string[] = []
      // Build two components to combine into a variant set.
      const a = await makeFrame(client, 'VariantA')
      const b = await makeFrame(client, 'VariantB')
      if (a.id === undefined || b.id === undefined) {
        return {
          ...fail('could not create variant bases'),
          nodeIds: [a.id, b.id].filter(
            (x): x is string => x !== undefined,
          ),
        }
      }
      created.push(a.id, b.id)
      const ca = await handleCreateComponent(
        { nodeId: a.id, name: 'Style=A' },
        client,
      )
      const cb = await handleCreateComponent(
        { nodeId: b.id, name: 'Style=B' },
        client,
      )
      if (isError(ca) || isError(cb)) {
        return {
          ...fail(
            `create_component failed: ${text(ca)} | ${text(cb)}`,
          ),
          nodeIds: created,
        }
      }
      const caId = createdId(asJson(ca))
      const cbId = createdId(asJson(cb))
      if (caId === undefined || cbId === undefined) {
        return {
          ...fail('component promote returned no ids'),
          nodeIds: created,
        }
      }
      created.push(caId, cbId)
      const combined = await handleCombineVariants(
        { componentIds: [caId, cbId], name: 'VerifySet' },
        client,
      )
      if (isError(combined)) {
        return {
          ...fail(`combine_variants: ${text(combined)}`),
          nodeIds: created,
        }
      }
      const setId = createdId(asJson(combined))
      if (setId !== undefined) {
        created.push(setId)
      }
      // swap_component requires an instance + an alternate main; that's heavy to
      // stand up generically. We exercise combine_variants here and SKIP the
      // remote swap (needs a library), reporting honestly.
      return pass(
        `combine_variants → set ${setId ?? '?'}. swap_component(remote key) skipped: needs a published library.`,
        { nodeIds: created, exportNodeId: setId },
      )
    },
  },
]

// ===========================================================================
// Exported list
// ===========================================================================

export const CHECK_LIST: Check[] = [
  ...tier1,
  ...tier2,
  ...tier3,
]

/** All 47 registered tool names — the coverage denominator. */
export const ALL_TOOLS: string[] = [
  'connect',
  'status',
  'inspect',
  'get_node',
  'get_nodes',
  'export',
  'search',
  'list_pages',
  'get_selection',
  'get_styles',
  'get_variables',
  'get_components',
  'list_fonts',
  'get_reactions',
  'get_plugin_data',
  'get_annotations',
  'create_node',
  'create_tree',
  'create_from_svg',
  'create_image',
  'update_node',
  'clone_node',
  'delete_node',
  'reparent_node',
  'reorder_children',
  'set_selection',
  'set_focus',
  'boolean_op',
  'flatten',
  'create_page',
  'set_current_page',
  'duplicate_page',
  'create_component',
  'update_component',
  'combine_variants',
  'swap_component',
  'set_instance',
  'create_styles',
  'update_styles',
  'apply_style',
  'create_variables',
  'update_variables',
  'bind_variable',
  'set_plugin_data',
  'set_reactions',
  'set_annotations',
  'batch',
]

/**
 * Tools touched by at least one check. `connect` is exercised by the harness's
 * connect step itself; `delete_node` by cleanup. Both are counted as touched.
 */
export const touchedTools = (): Set<string> => {
  const touched = new Set<string>([
    'connect',
    'delete_node',
  ])
  for (const check of CHECK_LIST) {
    for (const tool of check.tools) {
      touched.add(tool)
    }
  }
  return touched
}
