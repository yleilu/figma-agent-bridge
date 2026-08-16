// write-gate.test.ts — a converted spec leaves by ONE door.
//
// A styled field is a reference, so a write that names a style emits NO
// literals for that field: the whole content is the style. Rules 3 and 4 —
// wrong type for the slot, and no such style — are what stop such a write
// before it reaches the document. Skip them and the payload that lands is a
// field with nothing in it plus a binding that cannot be made: nothing written,
// reported as success, which is exactly the failure the contract forbids
// (expression-formats.md).
//
// `resolveStyleReferences` used to be five per-handler calls, so a sixth write
// path would have skipped the gate silently and no test would have noticed.
// `sendConvertedWrite` makes the gate structural — it IS the send — and this
// file is what keeps it that way: a module that converts a spec must import the
// door, and must not carry a `client.sendCommand` for a spec-carrying command.
//
// A source scan, in the shape of the plugin's apply-wiring guard: an empty
// offender list is the PASS value, so this file carries its own liveness
// assertions rather than looking identical to a scanner that read nothing.

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const TOOLS = join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'tools',
)

const read = (name: string): string =>
  // eslint-disable-next-line n/no-sync -- test-only source scan
  readFileSync(join(TOOLS, name), 'utf8')

const files =
  // eslint-disable-next-line n/no-sync -- test-only source scan
  readdirSync(TOOLS).filter(
    f => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  )

const sources = new Map(files.map(f => [f, read(f)]))

/**
 * The converters that turn a NodeSpec into a payload the plugin applies. A
 * module that calls one of these is a WRITE PATH and owes the gate.
 *
 * Matched as a CALL (`name(`), not as an import line (`name,`), so a module
 * that only re-exports or mentions one is not implicated.
 */
const CONVERTERS = [
  'specToFigmaForCreate',
  'specToFigma',
  'slotEntryToFigma',
  'convertTree',
]

/** The plugin commands that carry a converted spec. */
const SPEC_COMMANDS = [
  'COMMANDS.CREATE_NODE',
  'COMMANDS.CREATE_TREE',
  'COMMANDS.UPDATE_NODE',
  'COMMANDS.UPDATE_COMPONENT',
  'COMMANDS.BATCH',
]

const DOOR = 'sendConvertedWrite'

/** Strip line comments so a mention in prose never counts as a call. */
const code = (src: string): string =>
  src
    .split('\n')
    .filter(line => !line.trimStart().startsWith('//'))
    .join('\n')

const calls = (name: string, src: string): boolean =>
  code(src).includes(`${name}(`)

/** Every module that converts a spec — the write paths, discovered not listed. */
const writePaths = files.filter(f =>
  CONVERTERS.some(c => calls(c, sources.get(f) ?? '')),
)

describe('the converted-write gate', () => {
  it('found the write paths at all (liveness)', () => {
    // If this ever empties out, the scan is broken, not the codebase clean.
    expect(writePaths.sort()).toEqual([
      'batch.ts',
      'components.ts',
      'create-node.ts',
      'create-tree.ts',
      'update.ts',
    ])
  })

  it('tells a call from an import (liveness)', () => {
    expect(calls('specToFigma', 'specToFigma(spec)')).toBe(
      true,
    )
    expect(
      calls(
        'specToFigma',
        '  specToFigma,\n} from "./writer"',
      ),
    ).toBe(false)
    expect(
      calls('specToFigma', '// specToFigma(spec)'),
    ).toBe(false)
  })

  it('every write path imports the door', () => {
    expect(
      writePaths.filter(
        f => !(sources.get(f) ?? '').includes(DOOR),
      ),
    ).toEqual([])
  })

  it('every write path actually CALLS the door', () => {
    expect(
      writePaths.filter(
        f => !calls(DOOR, sources.get(f) ?? ''),
      ),
    ).toEqual([])
  })

  // The other half: importing the door and then sending around it. A
  // spec-carrying command must never appear as a direct sendCommand argument.
  it('no spec-carrying command is sent by any other route', () => {
    const offenders: string[] = []
    for (const [file, src] of sources) {
      const body = code(src)
      for (const command of SPEC_COMMANDS) {
        // EVERY occurrence, not the first. A command name appears in
        // non-send positions too — `batch.ts` keys its CONVERTERS map by
        // `COMMANDS.UPDATE_NODE` long before anything is sent — so checking
        // only `indexOf` lets a bypass added further down the same file hide
        // behind the innocent mention above it, and the guard stays green on
        // exactly the file most likely to grow a sixth write path.
        for (
          let at = body.indexOf(command);
          at !== -1;
          at = body.indexOf(command, at + 1)
        ) {
          // The characters before the command name carry the call it is an
          // argument to — `sendCommand(` or `sendConvertedWrite(client,`.
          const before = body.slice(
            Math.max(0, at - 60),
            at,
          )
          if (
            before.includes('sendCommand(') &&
            !before.includes(DOOR)
          ) {
            offenders.push(`${file}: ${command}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  // The matcher, exercised on the two shapes that matter, so the scan is
  // proven rather than trusted: a bare bypass, and a bypass SHADOWED by an
  // innocent earlier mention of the same command (the shape a first-occurrence
  // scan silently passed).
  const bypasses = (body: string): number => {
    let found = 0
    for (
      let at = body.indexOf('COMMANDS.UPDATE_NODE');
      at !== -1;
      at = body.indexOf('COMMANDS.UPDATE_NODE', at + 1)
    ) {
      const before = body.slice(Math.max(0, at - 60), at)
      if (
        before.includes('sendCommand(') &&
        !before.includes(DOOR)
      ) {
        found += 1
      }
    }
    return found
  }

  it('would catch a bypass (liveness)', () => {
    expect(
      bypasses(
        'const r = await client.sendCommand(COMMANDS.UPDATE_NODE, { nodeId, spec })',
      ),
    ).toBe(1)
    expect(
      bypasses(
        'const r = await sendConvertedWrite(client, COMMANDS.UPDATE_NODE, p)',
      ),
    ).toBe(0)
  })

  it('would catch a bypass SHADOWED by an earlier innocent mention (liveness)', () => {
    // Exactly `batch.ts`'s shape: the command is named in a map key first, and
    // the offending send comes later in the same file.
    expect(
      bypasses(
        '[COMMANDS.UPDATE_NODE]: convertUpdateNode,\n' +
          'const r = await client.sendCommand(COMMANDS.UPDATE_NODE, { nodeId, spec })',
      ),
    ).toBe(1)
  })
})
