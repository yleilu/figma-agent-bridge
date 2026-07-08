import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtemp, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The bootstrap must honor overrides for testability:
//   BOOTSTRAP_BASE_URL (release base), CLAUDE_PLUGIN_DATA (bin dir), BOOTSTRAP_ASSET (name)
describe('hooks/bootstrap', () => {
  let server: ReturnType<typeof Bun.serve> | undefined
  afterEach(() => server?.stop())

  it('downloads + checksum-verifies + chmods, then skips on re-run', async () => {
    const rel = await mkdtemp(join(tmpdir(), 'rel-'))
    const dataDir = await mkdtemp(join(tmpdir(), 'data-'))
    const fakeBin = '#!/bin/sh\necho 0.0.1\n'
    await writeFile(join(rel, 'figma-mcp-test'), fakeBin)
    const sha = new Bun.CryptoHasher('sha256')
      .update(fakeBin)
      .digest('hex')
    await writeFile(
      join(rel, 'figma-mcp-test.sha256'),
      `${sha}  figma-mcp-test\n`,
    )
    server = Bun.serve({
      port: 0,
      fetch: req =>
        new Response(
          Bun.file(
            join(rel, new URL(req.url).pathname.slice(1)),
          ),
        ),
    })
    const base = `http://localhost:${server.port}`
    const env = {
      ...process.env,
      BOOTSTRAP_BASE_URL: base,
      BOOTSTRAP_ASSET: 'figma-mcp-test',
      CLAUDE_PLUGIN_DATA: dataDir,
    }

    const run = () =>
      Bun.spawn(
        [
          'bash',
          `${import.meta.dir}/../../../plugin/hooks/bootstrap`,
        ],
        { env, stdout: 'pipe', stderr: 'pipe' },
      ).exited
    expect(await run()).toBe(0)
    const bin = join(dataDir, 'bin', 'figma-mcp')
    expect(await Bun.file(bin).exists()).toBe(true)
    const mtime1 = (await stat(bin)).mtimeMs
    expect(await run()).toBe(0) // idempotent second run (version matches → no re-download)
    expect((await stat(bin)).mtimeMs).toBe(mtime1) // proves it was NOT re-downloaded, just skipped
  })
})
