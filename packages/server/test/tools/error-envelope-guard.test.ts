// error-envelope-guard.test.ts — the typed-error-envelope regression guard.
//
// Scans the real server source tree for a bare-text failure path — a
// textResult(...) call opening with one of the legacy free-text prefixes the
// envelope replaced (overview.md, "Error envelope"). An empty offender list
// is the PASS value, so this file carries its own liveness assertions: a
// scanner that silently read zero files must not look identical to a clean
// tree (the "0 is the pass value and a quiet harness looks identical" trap —
// project_change_feed_spec.md made the same point about count assertions).

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '../../src')

const walk = (dir: string): string[] =>
  // eslint-disable-next-line n/no-sync -- test-only tree scan
  readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = join(dir, e.name)
    return e.isDirectory()
      ? walk(full)
      : e.name.endsWith('.ts')
        ? [full]
        : []
  })

const BARE =
  /textResult\(\s*[`'"](?:Error:|Failed |Unexpected response|Node not found|Not connected)/

const files = walk(SRC)

describe('no bare-text failure paths', () => {
  it('actually scans the tree (liveness)', () => {
    expect(files.length).toBeGreaterThan(20)
  })
  it('flags a bare failure when it sees one (liveness)', () => {
    expect(
      BARE.test(
        'return textResult(`Error: ${errorMessage(err)}`)',
      ),
    ).toBe(true)
  })
  it('finds none under packages/server/src', () => {
    expect(
      files
        .filter(f =>
          // eslint-disable-next-line n/no-sync -- test-only source read
          BARE.test(readFileSync(f, 'utf8')),
        )
        .map(f => f.slice(SRC.length + 1)),
    ).toEqual([])
  })
})
