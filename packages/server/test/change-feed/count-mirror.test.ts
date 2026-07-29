import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCountMirror } from '@figma-agent-bridge/server/change-feed/count-mirror'

let dir: string
let prevDir: string | undefined
beforeEach(async () => {
  // process.env is PROCESS-wide (unlike the module registry, which bun test
  // gives each file fresh), so leaving this set points every later test file
  // at a deleted temp directory.
  prevDir = process.env.FIGMA_BRIDGE_CHANGES_DIR
  dir = await mkdtemp(join(tmpdir(), 'cf-'))
  process.env.FIGMA_BRIDGE_CHANGES_DIR = dir
})
afterEach(async () => {
  if (prevDir === undefined) {
    delete process.env.FIGMA_BRIDGE_CHANGES_DIR
  } else {
    process.env.FIGMA_BRIDGE_CHANGES_DIR = prevDir
  }
  await rm(dir, { recursive: true, force: true })
})

const read = async (p: string) =>
  JSON.parse(await readFile(join(dir, p), 'utf8'))

describe('count mirror', () => {
  it('writes the sentinel when NO sessionId was ever received', async () => {
    const m = createCountMirror({
      writer: 'srv-1',
      debounceMs: 0,
      sessionId: () => undefined,
    })
    await m.write('fk/a', 3, 'gap')
    const rec = await read('fk_a/_unattributed.json')
    expect(rec).toMatchObject({
      schema: 1,
      fileKey: 'fk/a',
      writer: 'srv-1',
      pendingCount: 3,
      state: 'gap',
    })
    expect(typeof rec.updatedAt).toBe('number')
  })

  it('keys on the sanitized sessionId once known', async () => {
    const m = createCountMirror({
      writer: 'srv-1',
      debounceMs: 0,
      sessionId: () => '4b8e-1f60/x',
    })
    await m.write('fk', 0, 'ok')
    expect(await read('fk/4b8e-1f60_x.json')).toMatchObject(
      { pendingCount: 0, state: 'ok' },
    )
  })

  it('leaves NO .tmp behind (atomic write+rename)', async () => {
    const m = createCountMirror({
      writer: 'srv-1',
      debounceMs: 0,
      sessionId: () => 'sid',
    })
    await m.write('fk', 1, 'ok')
    expect(
      (await readdir(join(dir, 'fk'))).some(f =>
        f.endsWith('.tmp'),
      ),
    ).toBe(false)
  })

  it('migrates a sentinel this process wrote', async () => {
    const mine = createCountMirror({
      writer: 'srv-mine',
      debounceMs: 0,
      sessionId: () => undefined,
    })
    await mine.write('fk-a', 5, 'gap')
    await mine.migrate('sess-1')

    expect(await read('fk-a/sess-1.json')).toMatchObject({
      pendingCount: 5,
      state: 'gap',
    })
    await expect(
      read('fk-a/_unattributed.json'),
    ).rejects.toThrow()
  })

  it('never lets a stale sentinel overwrite a NEWER session file', async () => {
    // Adoption is not instantaneous: a write can land under the real session
    // id before migrate() gets to the sentinel it left behind. Copying the
    // sentinel over that fresher record is the defect this whole feature
    // exists to avoid — {0, ok} on disk reads as "safe to act".
    const ident: { sid?: string } = {}
    const m = createCountMirror({
      writer: 'srv-1',
      debounceMs: 0,
      sessionId: () => ident.sid,
    })
    await m.write('fk', 0, 'ok') // sentinel, quiet
    ident.sid = 'sess-1'
    await m.write('fk', 5, 'gap') // the id is known: session file, 5 pending
    await m.migrate('sess-1')

    expect(await read('fk/sess-1.json')).toMatchObject({
      pendingCount: 5,
      state: 'gap',
    })
    await expect(
      read('fk/_unattributed.json'),
    ).rejects.toThrow()
  })

  it('REFUSES a sentinel another process overwrote (the ownership branch)', async () => {
    // Both processes write the sentinel for the SAME file — which is what
    // makes `mine`'s sentinels map contain fk-a while the file on disk
    // belongs to srv-theirs. This is the only shape that reaches the
    // `rec.writer !== opts.writer` guard; delete the guard and this test
    // goes red.
    const mine = createCountMirror({
      writer: 'srv-mine',
      debounceMs: 0,
      sessionId: () => undefined,
    })
    await mine.write('fk-a', 5, 'gap')

    const theirs = createCountMirror({
      writer: 'srv-theirs',
      debounceMs: 0,
      sessionId: () => undefined,
    })
    await theirs.write('fk-a', 2, 'ok') // overwrites the same sentinel

    await mine.migrate('sess-1')

    // The sentinel stays, still owned by the other process...
    expect(
      await read('fk-a/_unattributed.json'),
    ).toMatchObject({
      writer: 'srv-theirs',
      pendingCount: 2,
    })
    // ...and no session file was minted from it.
    await expect(read('fk-a/sess-1.json')).rejects.toThrow()
  })

  it('discards a session file left by a PREVIOUS server process', async () => {
    // The count file is keyed on the SESSION, not the process. An MCP server
    // that crashes / is /mcp-reconnected mid-session leaves its last record
    // behind, and the next process starts with NO buffers at all — so the
    // presence hook would read the dead writer's `{0, ok}` at the START of the
    // next turn and render "safe to act" over a server watching nothing.
    const dead = createCountMirror({
      writer: 'srv-dead',
      debounceMs: 0,
      sessionId: () => 'sess-1',
    })
    await dead.write('fk-a', 0, 'ok')

    const live = createCountMirror({
      writer: 'srv-live',
      debounceMs: 0,
      sessionId: () => 'sess-1',
    })
    await live.migrate('sess-1')

    // A MISSING file reads as "no signal" (both fields omitted) — the honest
    // answer for a process that holds no buffers.
    await expect(read('fk-a/sess-1.json')).rejects.toThrow()
  })

  it('KEEPS its OWN session file across the adoption sweep', async () => {
    const m = createCountMirror({
      writer: 'srv-1',
      debounceMs: 0,
      sessionId: () => 'sess-1',
    })
    await m.write('fk-a', 4, 'gap')
    await m.migrate('sess-1')
    expect(await read('fk-a/sess-1.json')).toMatchObject({
      writer: 'srv-1',
      pendingCount: 4,
    })
  })

  it('REFUSES to unlink a sentinel another process overwrote (shutdown)', async () => {
    // The mirror image of migrate's ownership guard: two concurrent
    // unattributed sessions share the sentinel last-writer-wins, so this
    // process's clean exit must not delete the record the OTHER just wrote.
    const mine = createCountMirror({
      writer: 'srv-mine',
      debounceMs: 0,
      sessionId: () => undefined,
    })
    await mine.write('fk-a', 5, 'gap')
    const theirs = createCountMirror({
      writer: 'srv-theirs',
      debounceMs: 0,
      sessionId: () => undefined,
    })
    await theirs.write('fk-a', 2, 'ok')

    mine.shutdown()

    expect(
      await read('fk-a/_unattributed.json'),
    ).toMatchObject({
      writer: 'srv-theirs',
      pendingCount: 2,
    })
  })

  it('unlinks its OWN sentinels on shutdown', async () => {
    const m = createCountMirror({
      writer: 'srv-1',
      debounceMs: 0,
      sessionId: () => undefined,
    })
    await m.write('fk', 1, 'ok')
    m.shutdown()
    await expect(
      read('fk/_unattributed.json'),
    ).rejects.toThrow()
  })

  it('debounces positive→positive but writes 0→positive immediately', async () => {
    const m = createCountMirror({
      writer: 'srv-1',
      debounceMs: 200,
      sessionId: () => 'sid',
    })
    await m.write('fk', 1, 'ok') // leading edge: 0 → positive
    expect((await read('fk/sid.json')).pendingCount).toBe(1)
    await m.write('fk', 2, 'ok') // positive → positive: debounced
    expect((await read('fk/sid.json')).pendingCount).toBe(1)
    await Bun.sleep(260)
    expect((await read('fk/sid.json')).pendingCount).toBe(2)
  })

  it('a STATE change is always immediate', async () => {
    const m = createCountMirror({
      writer: 'srv-1',
      debounceMs: 5000,
      sessionId: () => 'sid',
    })
    await m.write('fk', 1, 'ok')
    await m.write('fk', 2, 'gap')
    expect(await read('fk/sid.json')).toMatchObject({
      pendingCount: 2,
      state: 'gap',
    })
  })

  it('a TRUNCATED drain writes immediately (positive → positive, state unchanged)', async () => {
    // The spec's trigger table lists `drain → immediate` UNCONDITIONALLY. A
    // truncated drain leaves the count positive with the state unchanged, so
    // the condition list alone would route it to the trailing debounce and an
    // agent draining in a loop would read a stale-high count next turn. The
    // mirror cannot infer "this came from a drain" — the caller must say so.
    const m = createCountMirror({
      writer: 'srv-1',
      debounceMs: 5000,
      sessionId: () => 'sid',
    })
    await m.write('fk', 9, 'ok')
    await m.write('fk', 4, 'ok', { immediate: true })
    expect((await read('fk/sid.json')).pendingCount).toBe(4)
  })
})
