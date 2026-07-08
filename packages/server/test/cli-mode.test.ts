import { describe, it, expect, afterAll } from 'bun:test'
import { APP_VERSION } from '@figma-agent-bridge/shared'

describe('binary CLI modes', () => {
  it('--version prints APP_VERSION and exits 0', async () => {
    const proc = Bun.spawn(
      ['bun', 'run', 'src/index.ts', '--version'],
      {
        cwd: `${import.meta.dir}/..`,
        stdout: 'pipe',
      },
    )
    const out = (
      await new Response(proc.stdout).text()
    ).trim()
    const code = await proc.exited
    expect(code).toBe(0)
    expect(out).toBe(APP_VERSION)
  })

  it('--relay starts HTTP relay and serves /channels', async () => {
    const port = 19871 // unique port for this test
    const proc = Bun.spawn(
      ['bun', 'run', 'src/index.ts', '--relay'],
      {
        cwd: `${import.meta.dir}/..`,
        env: { ...process.env, PORT: String(port) },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    // Ensure process is killed regardless of test outcome
    afterAll(() => {
      try {
        proc.kill()
      } catch {
        // already dead
      }
    })

    // Poll /channels until the relay is up (max ~3s)
    let res: Response | undefined
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      try {
        res = await fetch(
          `http://localhost:${port}/channels`,
        )
        break
      } catch {
        await new Promise(r => setTimeout(r, 100))
      }
    }

    proc.kill()

    expect(res).toBeDefined()
    expect(res!.status).toBe(200)
    const body = await res!.json()
    expect(Array.isArray(body)).toBe(true)
  })
})
