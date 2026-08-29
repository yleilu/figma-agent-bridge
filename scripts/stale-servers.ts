// stale-servers.ts — which live MCP servers are OLDER than the bundle just
// built (the install guard).
//
// `install:local` writes a fresh bundle and a fresh fig-plugin. It does not
// restart anything. A server process started before the write keeps serving the
// code it loaded, and nothing in the protocol shows that: under the CI-only
// versioning rule both sides stamp the same version, so the handshake stays
// quiet. Three incidents in two days came out of exactly this, including one
// that flipped a QA category verdict.
//
// The build fingerprint (I62) closes the half where a BUNDLE is stale — both
// bundles carry the build that made them and `status()` compares them. It
// cannot see this half: a server run from the working tree
// (`bun run packages/server/src/index.ts`) passed through no build, so it
// honestly reports `'source'` and the comparison stays silent for it by design.
// A stale tree-runner is therefore invisible to the fingerprint and visible
// only here — which is why both families are listed:
//
//   bundle  — a `bin/server.js` the package installed
//   source  — a `bun run packages/server/…` tree-runner
//
// This only REPORTS. It never kills a process and never fails the install: the
// operator may be running a second server on purpose, and a build script that
// killed processes it did not start would be worse than the trap it prevents.

import { stat } from 'node:fs/promises'

/** One live process, as much of one as the guard reads. */
export type ProcessRow = {
  pid: number
  /** Seconds since the process started (`ps` etime). */
  elapsedSeconds: number
  command: string
}

/** A process this guard has something to say about. */
export type StaleServer = ProcessRow & {
  family: 'bundle' | 'source'
  startedAt: Date
}

/**
 * Seconds from a `ps` elapsed time, or `undefined` when it is not one.
 *
 * POSIX `etime` is `[[dd-]hh:]mm:ss`. It is used in place of `lstart` because
 * `lstart`'s format differs between BSD and GNU `ps` and needs a locale-aware
 * parse; elapsed seconds subtract from "now" identically everywhere.
 */
export const parseElapsed = (
  etime: string,
): number | undefined => {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(
    etime.trim(),
  )
  if (match === null) {
    return undefined
  }
  const [, dd, hh, mm, ss] = match
  return (
    Number(dd ?? 0) * 86400 +
    Number(hh ?? 0) * 3600 +
    Number(mm) * 60 +
    Number(ss)
  )
}

/**
 * Which family a command line belongs to, or `undefined` for anything else.
 *
 * Both patterns are deliberately narrow. This runs on a developer's machine
 * against every process on it, and a guard that over-matched would name
 * unrelated work as a stale bridge — which trains the reader to skip the whole
 * block, and then it protects nothing.
 */
export const familyOf = (
  command: string,
): 'bundle' | 'source' | undefined => {
  if (/\bbin\/server\.js\b/.test(command)) {
    return 'bundle'
  }
  if (
    /packages\/server\/src\/index\.ts\b/.test(command) ||
    /--filter [^ ]*server[^ ]* start\b/.test(command)
  ) {
    return 'source'
  }
  return undefined
}

/**
 * The servers that started BEFORE `bundleMtimeMs`.
 *
 * `selfPid` is excluded: this guard runs under `bun`, and its own command line
 * carries the repo path. A process started in the same second as the write is
 * treated as FRESH — a boundary case can only be one of the two, and calling a
 * just-started server stale would cry wolf on the common path.
 */
export const staleServers = (
  rows: readonly ProcessRow[],
  bundleMtimeMs: number,
  nowMs: number,
  selfPid: number,
): StaleServer[] => {
  const out: StaleServer[] = []
  for (const row of rows) {
    if (row.pid === selfPid) {
      continue
    }
    const family = familyOf(row.command)
    if (family === undefined) {
      continue
    }
    const startedMs = nowMs - row.elapsedSeconds * 1000
    if (startedMs >= bundleMtimeMs) {
      continue
    }
    out.push({
      ...row,
      family,
      startedAt: new Date(startedMs),
    })
  }
  return out.sort((a, b) => a.pid - b.pid)
}

/** Parse `ps -Ao pid=,etime=,command=` output into rows. */
export const parsePs = (output: string): ProcessRow[] => {
  const rows: ProcessRow[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (match === null) {
      continue
    }
    const elapsedSeconds = parseElapsed(match[2])
    if (elapsedSeconds === undefined) {
      continue
    }
    rows.push({
      pid: Number(match[1]),
      elapsedSeconds,
      command: match[3],
    })
  }
  return rows
}

/** The block printed when something is stale, or '' when nothing is. */
export const report = (
  stale: readonly StaleServer[],
): string => {
  if (stale.length === 0) {
    return ''
  }
  const lines = [
    '',
    `=== ${stale.length} live MCP server process(es) are OLDER than the bundle just written ===`,
    'Each one still serves the code it loaded. Nothing in the protocol will say so:',
    'every dev build stamps the same version, so the handshake stays quiet.',
    '',
  ]
  for (const s of stale) {
    lines.push(
      `  pid ${s.pid}  started ${s.startedAt.toLocaleString()}  [${s.family}]`,
    )
    lines.push(`      ${s.command}`)
  }
  lines.push('')
  lines.push(
    `  Remedy:  kill ${stale.map(s => s.pid).join(' ')}   # then reconnect the MCP server (/mcp)`,
  )
  lines.push('')
  return lines.join('\n')
}

const main = async (bundle: string): Promise<void> => {
  try {
    const { mtimeMs } = await stat(bundle)
    const ps = Bun.spawn([
      'ps',
      '-Ao',
      'pid=,etime=,command=',
    ])
    const stale = staleServers(
      parsePs(await new Response(ps.stdout).text()),
      mtimeMs,
      Date.now(),
      process.pid,
    )
    const text = report(stale)
    process.stdout.write(
      text === ''
        ? 'no live MCP server process is older than the bundle just written\n'
        : text,
    )
  } catch (err) {
    // A guard that cannot look is a guard that says so — never one that fails
    // the install it was appended to.
    process.stdout.write(
      `stale-server check skipped: ${(err as Error).message}\n`,
    )
  }
}

if (import.meta.main) {
  await main(process.argv[2] ?? 'plugin/bin/server.js')
}
