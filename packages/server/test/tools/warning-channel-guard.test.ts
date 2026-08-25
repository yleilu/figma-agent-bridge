// warning-channel-guard.test.ts — a degrade is DATA, never prose (B61).
//
// The defect this guards against does not look like a bug in review. Two
// handlers built their reply as `${json}\n\nWarning: …`, which reads perfectly
// well to a human and is invisible to anything parsing the reply — and the
// reply is what an agent parses. `create_tree` was the worst place for it: it
// builds whole screens, so every T7 degrade at any depth of a subtree comes
// home on that one envelope. B61's live gate found a stated size hugged away,
// the plugin reporting it exactly as designed, and a JSON body that said
// nothing at all.
//
// `update_node` states the rule in its own source — merge into the reply's
// structured `warnings[]`, "one concept, one surface … rather than appending
// loose text after the JSON". This makes that a property of the tree rather
// than a habit two handlers happened to keep.
//
// WHY A SOURCE SCAN. The per-handler tests below it are the real assertions,
// and they only cover the handlers someone thought to write them for. Every
// unit test in the B61 batch asserted a warning reached a `string[]` SINK; not
// one asserted it reached the CALLER, which is exactly how a fix that was
// green everywhere failed live. A new write tool can be added tomorrow with
// the same second channel and nothing else here would notice.
//
// An empty offender list is the PASS value, so this file carries its own
// liveness assertions rather than looking identical to a scanner that read
// nothing.

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

/** Source with comments removed — a scan must not trip over its own prose. */
const codeOf = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

/**
 * Building a `Warning:` line to concatenate onto a reply.
 *
 * The word alone is not the offence — a warning's own TEXT may say "warning",
 * and the comments explaining this rule certainly do. What is scanned for is
 * the prefix being MINTED as output.
 */
const PROSE_CHANNEL = /[`'"]Warning:\s*(?:\$\{|['"`+])/

const files = walk(SRC)

describe('a degrade rides in warnings[], not in prose', () => {
  it('actually scans the tree (liveness)', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('flags the prose channel when it sees one (liveness)', () => {
    expect(
      PROSE_CHANNEL.test(
        'const t = warnings.map(w => `Warning: ${w}`).join("\\n")',
      ),
    ).toBe(true)
    expect(
      PROSE_CHANNEL.test(
        "warnings.map(w => 'Warning: ' + w)",
      ),
    ).toBe(true)
  })

  it('does not flag a warning that merely mentions the word (liveness)', () => {
    expect(
      PROSE_CHANNEL.test(
        "warnings.push('this is a warning about sizing')",
      ),
    ).toBe(false)
  })

  it('finds none under packages/server/src', () => {
    expect(
      files
        .filter(f =>
          PROSE_CHANNEL.test(
            // eslint-disable-next-line n/no-sync -- test-only source read
            codeOf(readFileSync(f, 'utf8')),
          ),
        )
        .map(f => f.slice(SRC.length + 1)),
    ).toEqual([])
  })
})

// The other half of the same rule: a handler that COLLECTS warnings has to put
// them somewhere the caller can read. A scan cannot prove that in general, but
// it can hold the three write faces that share one contract to the one shape,
// which is the drift that actually happened — create_node and create_tree fell
// away from update_node one at a time.
describe('the three write faces answer the same shape', () => {
  const read = (name: string): string =>
    codeOf(
      // eslint-disable-next-line n/no-sync -- test-only source read
      readFileSync(join(SRC, 'tools', name), 'utf8'),
    )

  const faces = [
    'update.ts',
    'create-node.ts',
    'create-tree.ts',
  ]

  it('actually found them (liveness)', () => {
    for (const face of faces) {
      expect(read(face).length).toBeGreaterThan(500)
    }
  })

  it('each reads the plugin’s warnings and answers as DATA', () => {
    for (const face of faces) {
      const src = read(face)
      // A handler that never reads `result.warnings` cannot merge them, and
      // create_tree's own shapeReply deletes the key on the way past — so
      // "does it look at them at all" is the load-bearing question.
      expect(src).toContain('result?.warnings')
      // …and the merged list leaves as a JSON body, not as a trailing line.
      expect(src).toContain('JSON.stringify(')
    }
  })
})
