// scripts/poc-drive.ts — the change-feed POC's agent-side driver (Task 1f,
// Phase 0). THROWAWAY: deleted with the rest of the probe harness in Task 7.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Measurement A asks "how long AFTER a command exits do its documentchange
// events keep dribbling in". A row's `dt` is `tEvent - tExit`, and `tExit` is
// stamped by the LAST dispatch to finish. So if two commands overlap, a slow
// command's late events are measured against a LATER command's exit — `dt`
// comes out too small, the tail is truncated, SETTLE_MS is set too low, and the
// filter ships FAIL-OPEN. That is the exact outcome the POC exists to prevent.
//
// This is not hypothetical: a `verify-live` smoke run over the probe produced
// 273 rows of which 108 (39%) carried `inFlight: true`, because
// `figma.ui.onmessage` is async and useRelay posts each execute-command
// immediately. So the battery needs a driver that runs ONE command at a time
// and proves it did.
//
// ── WHY IT DRIVES THE SERVER HANDLERS, NOT THE PLUGIN ──────────────────────
// The plugin's wire params are NOT the tool's params — the server converts
// (e.g. create_node takes `{spec, parentId}` and sends the plugin something
// else entirely). Hand-rolling plugin frames sends malformed params; verified
// by two failed attempts before this file existed. So every shape below goes
// through the real handler, exactly as an agent's call would.

import {
  createFigmaClient,
  discoverChannels,
  type ScopedFigmaClient,
} from '../packages/server/src/figma-client'
import { handleCreateNode } from '../packages/server/src/tools/create-node'
import { handleUpdateNode } from '../packages/server/src/tools/update'
import { handleGetNode } from '../packages/server/src/tools/read'
import { handleSetSelection } from '../packages/server/src/tools/selection'
import {
  handleDeleteNode,
  handleSetFocus,
} from '../packages/server/src/tools/structure'
import { handleCreateTree } from '../packages/server/src/tools/create-tree'
import { handleCreateStyles } from '../packages/server/src/tools/design-system-authoring'
import { handleBatch } from '../packages/server/src/tools/batch'
import { handleCreateImage } from '../packages/server/src/tools/create-image'
import type { ToolResult } from '../packages/server/src/tools/shared'

type Shape = {
  id: string
  name: string
  run: (
    c: ScopedFigmaClient,
    ctx: Ctx,
  ) => Promise<ToolResult>
}

type Ctx = {
  created: string[]
  /** children of a HUG auto-layout frame — A5 and A8 reflow through them. */
  autoChildren: string[]
  /** deepest leaf of a three-level hug chain — A9's reflow propagates up all three. */
  hugLeaf: string
}

const idOf = (r: ToolResult): string | null => {
  const text = r.content?.[0]?.text ?? ''
  const m = /"id"\s*:\s*"([^"]+)"/.exec(text)
  return m?.[1] ?? null
}

/** Measurement-A shapes, each ONE command. Param shapes are taken verbatim
 *  from packages/server/src/verify-checks.ts, which passes 22/22 against the
 *  REAL plugin — inventing them failed four times before this. */
const SHAPES: Shape[] = [
  {
    id: 'A1',
    name: 'synchronous single-property write',
    run: async (c, ctx) =>
      handleUpdateNode(
        {
          nodeId: ctx.created[0],
          patch: {
            name: `poc-A1-${Date.now()}`,
            opacity: 0.5,
          },
        },
        c,
      ),
  },
  {
    id: 'A2',
    name: 'write behind a font load',
    run: async c =>
      handleCreateNode(
        {
          spec: {
            type: 'TEXT',
            name: 'poc-A2',
            size: [240, 32],
            text: {
              content: 'poc font load',
              font: 'font(Inter,Bold,24)',
              color: '#111111',
            },
          },
        },
        c,
      ),
  },
  {
    id: 'A3',
    name: 'write behind a network fetch (create_image)',
    run: async c =>
      handleCreateImage(
        {
          url: 'https://raw.githubusercontent.com/figma/plugin-samples/master/icon-drag-and-drop/icon.png',
        },
        c,
      ),
  },
  {
    id: 'A4',
    name: '100-node create_tree',
    run: async c =>
      handleCreateTree(
        {
          tree: {
            type: 'FRAME',
            name: 'poc-A4',
            size: [400, 400],
            layout: {
              mode: 'H',
              gap: 2,
              pad: [2, 2, 2, 2],
            },
            fills: ['#FFFFFF'],
            children: Array.from(
              { length: 100 },
              (_, i) => ({
                type: 'RECTANGLE',
                name: `r${i}`,
                size: [20, 20],
                fills: ['#3366FF'],
              }),
            ),
          },
        },
        c,
      ),
  },
  {
    id: 'A5',
    name: 'batch of 50 update_node ops',
    run: async (c, ctx) =>
      handleBatch(
        {
          op: 'update_node',
          ops: Array.from({ length: 50 }, (_, i) => ({
            nodeId:
              ctx.autoChildren[i % ctx.autoChildren.length],
            patch: { opacity: 0.5 + (i % 5) / 10 },
          })),
        },
        c,
      ),
  },
  {
    id: 'A8',
    name: 'single-level auto-layout reflow',
    run: async (c, ctx) =>
      handleUpdateNode(
        {
          nodeId: ctx.autoChildren[0],
          patch: {
            size: [60 + Math.floor(Math.random() * 40), 40],
          },
        },
        c,
      ),
  },
  {
    id: 'A9',
    name: 'nested hug chain three levels deep',
    run: async (c, ctx) =>
      handleUpdateNode(
        {
          nodeId: ctx.hugLeaf,
          patch: {
            size: [50 + Math.floor(Math.random() * 60), 30],
          },
        },
        c,
      ),
  },
  {
    id: 'A6',
    name: 'delete_node on a subtree',
    run: async (c, ctx) =>
      handleDeleteNode({ nodeId: ctx.created.pop()! }, c),
  },
  {
    id: 'A7',
    name: 'style write (create_styles)',
    run: async c =>
      handleCreateStyles(
        {
          styles: [
            {
              type: 'paint',
              name: `poc/A7-${Date.now()}`,
              value: '#3366FF',
            },
          ],
        },
        c,
      ),
  },
]

const main = async (): Promise<number> => {
  const port = process.env.PORT ?? '18081'
  const wsUrl =
    process.env.RELAY_URL ?? `ws://localhost:${port}`
  const httpUrl = wsUrl.replace(/^ws/, 'http')
  const only = process.argv[2]

  const found = await discoverChannels(httpUrl)
  if (found.length !== 1) {
    console.error(
      `Expected exactly 1 connected plugin on ${httpUrl}, found ${found.length}. ` +
        `Case 11's must-be-zero is unanswerable with more than one.`,
    )
    return 2
  }
  const { channel } = found[0]
  const fileKey = found[0].fileKey ?? channel

  const client = createFigmaClient(wsUrl)
  await client.joinChannel(channel, fileKey)
  const scoped = client.forFile(fileKey)
  console.log(
    `[poc-drive] ${channel} (fileKey ${fileKey}) on ${wsUrl}`,
  )

  // A seed node so shapes that need an existing target have one. Created
  // BEFORE the measured run so its own events are not in the population.
  const seed = await handleCreateNode(
    {
      spec: {
        type: 'FRAME',
        name: 'poc-seed',
        size: [120, 120],
        fills: ['#FFFFFF'],
      },
    },
    scoped,
  )
  const seedId = idOf(seed)
  if (seedId === null) {
    console.error(
      '[poc-drive] seed create failed:',
      JSON.stringify(seed).slice(0, 300),
    )
    client.disconnect()
    return 2
  }
  console.log(`[poc-drive] seed ${seedId}`)

  // Fixtures for the reflow shapes. A8/A5 need a HUG auto-layout frame whose
  // children move when one resizes; A9 needs three nested hug levels so a leaf
  // resize propagates all the way up. Built BEFORE the measured window so their
  // own creation events are not in the population.
  const autoFrame = await handleCreateTree(
    {
      tree: {
        type: 'FRAME',
        name: 'poc-auto',
        layout: { mode: 'V', gap: 4, pad: [4, 4, 4, 4] },
        sizing: ['HUG', 'HUG'],
        fills: ['#EEEEEE'],
        children: Array.from({ length: 10 }, (_, i) => ({
          type: 'RECTANGLE',
          name: `a${i}`,
          size: [80, 40],
          fills: ['#3366FF'],
        })),
      },
    },
    scoped,
  )
  const hugTree = await handleCreateTree(
    {
      tree: {
        type: 'FRAME',
        name: 'poc-hug-L1',
        layout: { mode: 'V', gap: 4, pad: [4, 4, 4, 4] },
        sizing: ['HUG', 'HUG'],
        fills: ['#FFEEEE'],
        children: [
          {
            type: 'FRAME',
            name: 'poc-hug-L2',
            layout: {
              mode: 'H',
              gap: 4,
              pad: [4, 4, 4, 4],
            },
            sizing: ['HUG', 'HUG'],
            fills: ['#EEFFEE'],
            children: [
              {
                type: 'FRAME',
                name: 'poc-hug-L3',
                layout: {
                  mode: 'H',
                  gap: 4,
                  pad: [4, 4, 4, 4],
                },
                sizing: ['HUG', 'HUG'],
                fills: ['#EEEEFF'],
                children: [
                  {
                    type: 'RECTANGLE',
                    name: 'poc-hug-leaf',
                    size: [60, 30],
                    fills: ['#FF3366'],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    scoped,
  )

  // create_tree returns ONLY its root — the very fact the self-write filter's
  // explicit claim() exists for. So read the children back rather than
  // harvesting them from the result.
  const idsUnder = async (
    r: ToolResult,
  ): Promise<string[]> => {
    const rootId = idOf(r)
    if (rootId === null) {
      return []
    }
    const tree = await handleGetNode(
      { nodeId: rootId, depth: 4 },
      scoped,
    )
    // Reads render YAML (`id: 1:136`), creates render JSON (`"id": "1:118"`).
    return [
      ...(tree.content?.[0]?.text ?? '').matchAll(
        /^\s*id:\s*([0-9]+:[0-9]+)\s*$/gm,
      ),
    ].map(m => m[1])
  }

  const autoKids = (await idsUnder(autoFrame)).slice(1)
  const hugIds = await idsUnder(hugTree)
  if (autoKids.length === 0 || hugIds.length === 0) {
    console.error(
      '[poc-drive] fixture build failed — no child ids recovered',
    )
    console.error(
      '  auto:',
      (autoFrame.content?.[0]?.text ?? '').slice(0, 200),
    )
    console.error(
      '  hug: ',
      (hugTree.content?.[0]?.text ?? '').slice(0, 200),
    )
    client.disconnect()
    return 2
  }
  console.log(
    `[poc-drive] fixtures: auto-layout ${autoKids.length} children, hug chain leaf ${hugIds[hugIds.length - 1]}`,
  )

  const ctx: Ctx = {
    created: [seedId],
    autoChildren: autoKids,
    hugLeaf: hugIds[hugIds.length - 1],
  }

  // Let the seed's own events drain before the measured window opens.
  await new Promise(r => setTimeout(r, 2000))

  // ── The agent-only cases (6, 7, 8, 9, 12, 13, 14) ───────────────────────
  // Each runs alone into its own file so its verdict counts are unpolluted.
  if (only?.startsWith('case') && only !== 'case11') {
    const n = only.slice(4)
    const drain = (ms = 4000) =>
      new Promise(r => setTimeout(r, ms))
    if (n === '6') {
      // Agent writes at depth 3 of a hug chain; reflowed cousins must NOT
      // surface as user edits.
      await handleUpdateNode(
        { nodeId: ctx.hugLeaf, patch: { size: [90, 55] } },
        scoped,
      )
      await drain()
    } else if (n === '8') {
      // A 100-node build must produce ZERO user-edit records. This is what the
      // creation-claim instrumentation exists for; a generic harvester fails it.
      await handleCreateTree(
        {
          tree: {
            type: 'FRAME',
            name: 'case8',
            layout: {
              mode: 'H',
              gap: 1,
              pad: [1, 1, 1, 1],
            },
            sizing: ['HUG', 'HUG'],
            fills: ['#FFFFFF'],
            children: Array.from(
              { length: 100 },
              (_, i) => ({
                type: 'RECTANGLE',
                name: `c8-${i}`,
                size: [12, 12],
                fills: ['#884422'],
              }),
            ),
          },
        },
        scoped,
      )
      await drain(6000)
    } else if (n === '9') {
      // A fetch-backed write landing seconds after dispatch must be DROPPED.
      // An entry-clocked TTL fails this; the exit-anchored window passes.
      await handleCreateImage(
        {
          url: 'https://raw.githubusercontent.com/figma/plugin-samples/master/icon-drag-and-drop/icon.png',
        },
        scoped,
      )
      await drain()
    } else if (n === '12') {
      // 30-op batch: the window must never close between op 1 and op 30 and
      // the touched set must accumulate across all of them.
      await handleBatch(
        {
          op: 'update_node',
          ops: Array.from({ length: 30 }, (_, i) => ({
            nodeId:
              ctx.autoChildren[i % ctx.autoChildren.length],
            patch: { opacity: 0.2 + (i % 8) / 10 },
          })),
        },
        scoped,
      )
      await drain()
    } else if (n === '13') {
      // The AGENT's own navigation must produce no context records.
      await handleSetSelection(
        { nodeIds: [ctx.autoChildren[0]] },
        scoped,
      )
      await new Promise(r => setTimeout(r, 400))
      await handleSetFocus(
        { nodeIds: [ctx.autoChildren[1]] },
        scoped,
      )
      await new Promise(r => setTimeout(r, 400))
      await handleSetSelection({ nodeIds: [] }, scoped)
      await drain()
    } else if (n === '14') {
      // Delete an auto-layout child; the sibling reflow records must be
      // dropped — proving the closure was captured BEFORE the delete.
      await handleDeleteNode(
        { nodeId: ctx.autoChildren[3] },
        scoped,
      )
      await drain()
    } else {
      console.error(`[poc-drive] unknown case ${n}`)
      client.disconnect()
      return 2
    }
    console.log(`[poc-drive] case ${n} done`)
    client.disconnect()
    return 0
  }

  // Case 11 — the headline gate: 20 mixed agent writes, user idle, the POC
  // pending count must reach EXACTLY 0. A residual floor means fail-open.
  if (only === 'case11') {
    const mix: {
      n: string
      go: () => Promise<ToolResult>
    }[] = []
    for (let i = 0; i < 20; i++) {
      const k = i % 6
      if (k === 0) {
        mix.push({
          n: 'create_node',
          go: () =>
            handleCreateNode(
              {
                spec: {
                  type: 'RECTANGLE',
                  name: `c11-${i}`,
                  size: [40, 40],
                  fills: ['#22AA88'],
                },
              },
              scoped,
            ),
        })
      } else if (k === 1) {
        mix.push({
          n: 'update_node',
          go: () =>
            handleUpdateNode(
              {
                nodeId: ctx.created[0],
                patch: { opacity: 0.4 + i / 100 },
              },
              scoped,
            ),
        })
      } else if (k === 2) {
        mix.push({
          n: 'auto-layout reflow',
          go: () =>
            handleUpdateNode(
              {
                nodeId:
                  ctx.autoChildren[
                    i % ctx.autoChildren.length
                  ],
                patch: { size: [60 + i, 40] },
              },
              scoped,
            ),
        })
      } else if (k === 3) {
        mix.push({
          n: 'hug-chain reflow',
          go: () =>
            handleUpdateNode(
              {
                nodeId: ctx.hugLeaf,
                patch: { size: [50 + i, 30] },
              },
              scoped,
            ),
        })
      } else if (k === 4) {
        // F1 regression guard: an agent-created STYLE must not surface as a
        // user edit. Its id differs between the command result and the event.
        mix.push({
          n: 'create_styles',
          go: () =>
            handleCreateStyles(
              {
                styles: [
                  {
                    type: 'paint',
                    name: `c11/s-${i}-${Date.now()}`,
                    value: '#22AA88',
                  },
                ],
              },
              scoped,
            ),
        })
      } else {
        mix.push({
          n: 'batch x5',
          go: () =>
            handleBatch(
              {
                op: 'update_node',
                ops: ctx.autoChildren
                  .slice(0, 5)
                  .map(id => ({
                    nodeId: id,
                    patch: { opacity: 0.3 + (i % 7) / 10 },
                  })),
              },
              scoped,
            ),
        })
      }
    }
    for (const [i, m] of mix.entries()) {
      const res = await m.go()
      const t = res.content?.[0]?.text ?? ''
      if (/^Error|"error"/.test(t)) {
        console.log(
          `[poc-drive] c11#${i} ${m.n} ERROR ${t.slice(0, 120)}`,
        )
      }
      const nid = idOf(res)
      if (nid !== null) {
        ctx.created.push(nid)
      }
      await new Promise(r => setTimeout(r, 250))
    }
    console.log(
      `[poc-drive] case11: 20 writes done; draining`,
    )
    await new Promise(r => setTimeout(r, 4000))
    client.disconnect()
    return 0
  }

  const shapes = only
    ? SHAPES.filter(s => s.id === only)
    : SHAPES
  for (const shape of shapes) {
    const t0 = Date.now()
    // ONE IN FLIGHT: awaited to completion before the next is dispatched.
    const res = await shape.run(scoped, ctx)
    const ms = Date.now() - t0
    const newId = idOf(res)
    if (newId !== null) {
      ctx.created.push(newId)
    }
    const text = res.content?.[0]?.text ?? ''
    const failed = /^Error|"error"/.test(text)
    console.log(
      `[poc-drive] ${shape.id} ${failed ? 'ERROR' : 'ok'} ${ms}ms — ${shape.name}` +
        (failed ? `\n    ${text.slice(0, 200)}` : ''),
    )
    // Drain this shape's tail before the next command exits, or the next
    // command's exit would re-stamp tExit for these events.
    await new Promise(r => setTimeout(r, 3000))
  }

  client.disconnect()
  return 0
}

if (import.meta.main) {
  main()
    // throwaway POC harness: the exit code IS the run's result and there is
    // no caller to throw to.
    .then(code =>
      // eslint-disable-next-line n/no-process-exit
      process.exit(code),
    )
    .catch((err: unknown) => {
      console.error('[poc-drive] FATAL', err)
      // eslint-disable-next-line n/no-process-exit -- see above
      process.exit(1)
    })
}
