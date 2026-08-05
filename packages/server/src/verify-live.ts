// verify-live.ts — the LIVE twin of the headless e2e suite.
//
// The whole test suite is mock-plugin-over-real-relay (headless). This harness
// is the LIVE counterpart: it drives the REAL Figma plugin (once a human has
// loaded it via Plugins → Development → Import from manifest and clicked
// Connect) through the SAME server tool handlers, asserts the documented
// contract from docs/specs/tool-surface.md, and lets an agent visually confirm
// the result via exported PNGs.
//
// Usage:
//   bun run verify:live -- --channel <id>      (or auto-discover one plugin)
//   bun run verify:live -- --channel <id> --out verify-output --keep
//   bun run verify:live -- --channel <id> --screencapture   (macOS canvas grab)
//
// Flags:
//   --channel <id>   join this channel (else auto-discover; fail if 0 or >1)
//   --out <dir>      where to write PNGs + report (default: verify-output)
//   --keep           do NOT delete created nodes at the end
//   --screencapture  macOS: after set_focus, shell `screencapture -x` per node
//
// Exit code is non-zero if any Tier-1 or Tier-2 check FAILS (a SKIP is not a
// fail). The check definitions live in verify-checks.ts so the self-test
// (test/verify-live.test.ts) can run the exact same array against the mock.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_PORT } from '@figma-agent-bridge/shared'
import {
  createFigmaClient,
  discoverChannels,
  toHttpUrl,
} from './figma-client'
import type {
  FigmaClient,
  ScopedFigmaClient,
} from './figma-client'
import { handleExport } from './tools/export'
import { handleSetFocus } from './tools/structure'
import { handleDeleteNode } from './tools/structure'
import { isErrorResult } from './tools/shared'
import {
  CHECK_LIST,
  ALL_TOOLS,
  touchedTools,
  type Check,
  type CheckOutcome,
  type Tier,
} from './verify-checks'

// ---------------------------------------------------------------------------
// Output helper (a small CLI logger; harness must print its report)
// ---------------------------------------------------------------------------

const log = (line = ''): void => {
  process.stdout.write(`${line}\n`)
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

type Args = {
  channel?: string
  out: string
  keep: boolean
  screencapture: boolean
}

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    out: 'verify-output',
    keep: false,
    screencapture: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--channel') {
      args.channel = argv[++i]
    } else if (a === '--out') {
      args.out = argv[++i] ?? args.out
    } else if (a === '--keep') {
      args.keep = true
    } else if (a === '--screencapture') {
      args.screencapture = true
    }
  }
  return args
}

// ---------------------------------------------------------------------------
// Connect (reuse the connect tool's discovery semantics, fail fast)
// ---------------------------------------------------------------------------

const resolveRelay = (): {
  wsUrl: string
  httpUrl: string
} => {
  const port =
    process.env.PORT !== undefined
      ? Number(process.env.PORT)
      : DEFAULT_PORT
  const wsUrl =
    process.env.RELAY_URL ?? `ws://localhost:${port}`
  const httpUrl = toHttpUrl(wsUrl)
  return { wsUrl, httpUrl }
}

const connect = async (
  client: FigmaClient,
  channelArg: string | undefined,
  httpUrl: string,
): Promise<{ channel: string; fileKey: string }> => {
  // Always discover so we can resolve the channel's fileKey (B3): a joined file
  // is now addressed by its fileKey, synthesized from the channel for an
  // unsaved (null-fileKey) file.
  const found = await discoverChannels(httpUrl)
  let channel = channelArg
  let fileKey: string | undefined
  if (channel === undefined) {
    if (found.length === 0) {
      throw new Error(
        `No Figma plugins connected on ${httpUrl}. Open a Figma file, run the Agent Bridge plugin, click Connect, then re-run with --channel <id> (or with exactly one plugin connected for auto-discovery).`,
      )
    }
    if (found.length > 1) {
      const list = found
        .map(
          c =>
            `  - ${c.channel}${c.fileName !== null ? ` (${c.fileName})` : ''}`,
        )
        .join('\n')
      throw new Error(
        `Multiple Figma plugins connected — pass --channel <id>:\n${list}`,
      )
    }
    channel = found[0].channel
    fileKey = found[0].fileKey ?? found[0].channel
    log(
      `Auto-discovered the only connected channel: ${channel} (fileKey: ${fileKey})`,
    )
  } else {
    // Explicit --channel: use its registered fileKey if known, else address it
    // by the channel itself (synthetic key — same rule as an unsaved file).
    const info = found.find(c => c.channel === channel)
    fileKey = info?.fileKey ?? channel
  }
  await client.joinChannel(channel, fileKey)
  if (!client.isConnected()) {
    throw new Error(
      `Joined channel ${channel} but the client is not reporting connected — is the plugin still running?`,
    )
  }
  return { channel, fileKey }
}

// ---------------------------------------------------------------------------
// Visual capture
// ---------------------------------------------------------------------------

/** Export the node as a PNG and write it to <out>/<id>.png. */
const capturePng = async (
  client: ScopedFigmaClient,
  nodeId: string,
  outDir: string,
): Promise<string | null> => {
  const result = await handleExport(
    { nodeId, format: 'PNG' },
    client,
  )
  const item = result.content[0] as {
    type: string
    data?: string
  }
  if (item.type !== 'image' || item.data === undefined) {
    return null
  }
  const safe = nodeId.replace(/[^a-zA-Z0-9._-]/g, '_')
  const file = join(outDir, `${safe}.png`)
  await writeFile(file, Buffer.from(item.data, 'base64'))
  return file
}

/**
 * macOS fallback: focus the node on the canvas, then shell `screencapture -x`
 * so the screenshot shows the canvas with the node in view (useful when the
 * plugin export is not enough — e.g. seeing surrounding context).
 */
const screencapture = async (
  client: ScopedFigmaClient,
  nodeId: string,
  outDir: string,
): Promise<string | null> => {
  if (process.platform !== 'darwin') {
    return null
  }
  await handleSetFocus({ nodeIds: [nodeId] }, client)
  // Give Figma a beat to scroll/zoom before grabbing the screen.
  await Bun.sleep(600)
  const safe = nodeId.replace(/[^a-zA-Z0-9._-]/g, '_')
  const file = join(outDir, `screen-${safe}.png`)
  const proc = Bun.spawn(['screencapture', '-x', file], {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const code = await proc.exited
  return code === 0 ? file : null
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

type CheckRecord = {
  id: string
  tier: Tier
  name: string
  tools: string[]
  status: 'PASS' | 'FAIL' | 'SKIP'
  detail: string
  capture?: string
  durationMs: number
}

const runCheck = async (
  client: ScopedFigmaClient,
  fullClient: FigmaClient,
  check: Check,
): Promise<{
  record: CheckRecord
  outcome: CheckOutcome
}> => {
  const started = Date.now()
  let outcome: CheckOutcome
  try {
    outcome = await check.run(client, fullClient)
  } catch (err) {
    outcome = {
      ok: false,
      detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const status: CheckRecord['status'] = !outcome.ok
    ? 'FAIL'
    : outcome.skipped
      ? 'SKIP'
      : 'PASS'
  return {
    outcome,
    record: {
      id: check.id,
      tier: check.tier,
      name: check.name,
      tools: check.tools,
      status,
      detail: outcome.detail,
      durationMs: Date.now() - started,
    },
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const printTable = (records: CheckRecord[]): void => {
  for (const tier of [1, 2, 3] as Tier[]) {
    const rows = records.filter(r => r.tier === tier)
    if (rows.length === 0) {
      continue
    }
    log(`\n── Tier ${tier} ─────────────────────────────`)
    for (const r of rows) {
      const mark =
        r.status === 'PASS'
          ? '✓'
          : r.status === 'SKIP'
            ? '○'
            : '✗'
      log(`${mark} [${r.status}] ${r.id} — ${r.name}`)
      log(`    ${r.detail}`)
      if (r.capture !== undefined) {
        log(`    capture: ${r.capture}`)
      }
    }
  }
}

const buildMarkdown = (
  channel: string,
  records: CheckRecord[],
  coverage: { touched: number; total: number },
): string => {
  const counts = {
    pass: records.filter(r => r.status === 'PASS').length,
    fail: records.filter(r => r.status === 'FAIL').length,
    skip: records.filter(r => r.status === 'SKIP').length,
  }
  const lines: string[] = []
  lines.push('# Live Verification Report')
  lines.push('')
  lines.push(`- Channel: \`${channel}\``)
  lines.push(`- Generated: ${new Date().toISOString()}`)
  lines.push(
    `- Result: ${counts.pass} PASS · ${counts.fail} FAIL · ${counts.skip} SKIP`,
  )
  lines.push(
    `- Tool coverage: ${coverage.touched}/${coverage.total} of the registry touched by checks`,
  )
  lines.push('')
  for (const tier of [1, 2, 3] as Tier[]) {
    const rows = records.filter(r => r.tier === tier)
    if (rows.length === 0) {
      continue
    }
    lines.push(`## Tier ${tier}`)
    lines.push('')
    lines.push('| Status | Check | Detail |')
    lines.push('| --- | --- | --- |')
    for (const r of rows) {
      const detail = r.detail.replace(/\|/g, '\\|')
      lines.push(
        `| ${r.status} | ${r.id} — ${r.name.replace(/\|/g, '\\|')} | ${detail} |`,
      )
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2))
  const { wsUrl, httpUrl } = resolveRelay()
  await mkdir(args.out, { recursive: true })

  log('figma-agent-bridge — live verification')
  log(`Relay: ${wsUrl}`)

  const client = createFigmaClient(wsUrl)
  let channel: string
  let fileKey: string
  try {
    ;({ channel, fileKey } = await connect(
      client,
      args.channel,
      httpUrl,
    ))
  } catch (err) {
    log('')
    log(
      `FATAL: ${err instanceof Error ? err.message : String(err)}`,
    )
    client.disconnect()
    return 2
  }
  log(
    `Connected to channel: ${channel} (fileKey: ${fileKey})`,
  )
  // Every file-addressed handler runs through this scoped view (fileKey
  // captured); the unscoped `client` is still passed to session tools (status).
  const scoped = client.forFile(fileKey)

  const records: CheckRecord[] = []
  const createdNodes = new Set<string>()

  for (const check of CHECK_LIST) {
    log(`\n▶ ${check.id} — ${check.name}`)
    const { record, outcome } = await runCheck(
      scoped,
      client,
      check,
    )
    // Track every created node for cleanup.
    for (const id of outcome.nodeIds ?? []) {
      createdNodes.add(id)
    }
    // Visual capture for checks that named an export target (only on PASS).
    if (
      record.status === 'PASS' &&
      outcome.exportNodeId !== undefined
    ) {
      try {
        const png = await capturePng(
          scoped,
          outcome.exportNodeId,
          args.out,
        )
        if (png !== null) {
          record.capture = png
        }
        if (args.screencapture) {
          const shot = await screencapture(
            scoped,
            outcome.exportNodeId,
            args.out,
          )
          if (shot !== null) {
            record.capture =
              record.capture !== undefined
                ? `${record.capture}, ${shot}`
                : shot
          }
        }
      } catch {
        // Capture is best-effort; never fail a check over a missing PNG.
      }
    }
    records.push(record)
  }

  // Cleanup — delete every created node (best-effort) unless --keep.
  let deleted = 0
  if (!args.keep) {
    log('\n── Cleanup ─────────────────────────────')
    for (const id of createdNodes) {
      try {
        const r = await handleDeleteNode(
          { nodeId: id },
          scoped,
        )
        const failed = isErrorResult(r)
        if (!failed) {
          deleted++
        }
      } catch {
        // best-effort
      }
    }
    log(
      `Deleted ${deleted}/${createdNodes.size} created node(s).`,
    )
  } else {
    log(
      `\n--keep set: leaving ${createdNodes.size} created node(s) in the document.`,
    )
  }

  // Report.
  const touched = touchedTools()
  const coverage = {
    touched: touched.size,
    total: ALL_TOOLS.length,
  }
  printTable(records)

  const counts = {
    pass: records.filter(r => r.status === 'PASS').length,
    fail: records.filter(r => r.status === 'FAIL').length,
    skip: records.filter(r => r.status === 'SKIP').length,
  }
  log('\n════════════════════════════════════════')
  log(
    `RESULT: ${counts.pass} PASS · ${counts.fail} FAIL · ${counts.skip} SKIP`,
  )
  log(
    `Tool coverage: ${coverage.touched}/${coverage.total} of the registry touched`,
  )
  const untouched = ALL_TOOLS.filter(t => !touched.has(t))
  if (untouched.length > 0) {
    log(`Untouched tools: ${untouched.join(', ')}`)
  }

  // Write artifacts.
  const reportJson = {
    channel,
    generatedAt: new Date().toISOString(),
    counts,
    coverage: {
      ...coverage,
      untouched,
    },
    cleanup: {
      created: createdNodes.size,
      deleted: args.keep ? 0 : deleted,
      kept: args.keep,
    },
    checks: records,
  }
  await writeFile(
    join(args.out, 'report.json'),
    JSON.stringify(reportJson, null, 2),
  )
  await writeFile(
    join(args.out, 'report.md'),
    buildMarkdown(channel, records, coverage),
  )
  log(`\nWrote ${join(args.out, 'report.json')}`)
  log(`Wrote ${join(args.out, 'report.md')}`)

  client.disconnect()

  // Non-zero exit if any Tier-1/2 check FAILED.
  const blocking = records.filter(
    r =>
      (r.tier === 1 || r.tier === 2) && r.status === 'FAIL',
  )
  return blocking.length > 0 ? 1 : 0
}

// Set the process exit code from the run result (non-zero on a Tier-1/2 FAIL).
// We set process.exitCode rather than calling process.exit() so buffered stdout
// (the report) flushes before the process ends.
process.exitCode = await main()
