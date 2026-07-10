import { test, expect } from 'bun:test'
import {
  mkdir,
  writeFile,
  readFile,
} from 'node:fs/promises'

const root = new URL('../', import.meta.url).pathname // test/ → repo root
const SCRIPT = `${root}plugin/hooks/presence`

const freshStateDir = () =>
  `/tmp/presence-${Date.now()}-${Math.random().toString(36).slice(2)}`

test('formats online files', async () => {
  const channels = JSON.stringify([
    {
      channel: 'file-a',
      fileName: 'Design A',
      fileKey: 'a',
      connectedAt: 0,
      version: '0.2.0',
      currentPage: 'Icons',
      selected: 2,
    },
  ])
  const proc = Bun.spawn(['bash', SCRIPT], {
    env: {
      ...process.env,
      PRESENCE_TEST_CHANNELS: channels,
      PRESENCE_STATE_DIR: freshStateDir(),
    },
    stdout: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  expect(out).toContain('figma_bridge:')
  expect(out).toContain('name: "Design A"') // @json-quoted → YAML-safe
  expect(out).toContain('current_page: "Icons"')
  expect(out).toContain('selected: 2')
})

test('recently_offline: file dropped since last baseline', async () => {
  const stateDir = freshStateDir()
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    `${stateDir}/last-online.json`,
    JSON.stringify({
      online: [{ fileKey: 'gone', name: 'Old File' }],
    }),
  )
  const channels = JSON.stringify([
    {
      channel: 'file-b',
      fileName: 'Design B',
      fileKey: 'b',
      connectedAt: 0,
    },
  ])
  const proc = Bun.spawn(['bash', SCRIPT], {
    env: {
      ...process.env,
      PRESENCE_TEST_CHANNELS: channels,
      PRESENCE_STATE_DIR: stateDir,
    },
    stdout: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  expect(out).toContain('recently_offline:')
  expect(out).toContain('name: "Old File"')
  expect(out).toContain('fileKey: "gone"')
})

test('relay unreachable: no PRESENCE_TEST_CHANNELS, dead port', async () => {
  const proc = Bun.spawn(['bash', SCRIPT], {
    env: {
      ...process.env,
      PRESENCE_TEST_CHANNELS: '',
      FIGMA_BRIDGE_RELAY_PORT: '1',
      PRESENCE_STATE_DIR: freshStateDir(),
    },
    stdout: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  expect(out).toContain('relay: unreachable')
  expect(out).toContain('online: []')
})

test('empty online: literal empty list, not YAML null', async () => {
  const proc = Bun.spawn(['bash', SCRIPT], {
    env: {
      ...process.env,
      PRESENCE_TEST_CHANNELS: '[]',
      PRESENCE_STATE_DIR: freshStateDir(),
    },
    stdout: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  expect(out).toContain('relay: connected')
  expect(out).toContain('online: []')
})

test('baseline rewrite: last-online.json holds current {fileKey,name} pairs', async () => {
  const stateDir = freshStateDir()
  const channels = JSON.stringify([
    {
      channel: 'file-c',
      fileName: 'Design C',
      fileKey: 'c',
      connectedAt: 0,
    },
  ])
  const proc = Bun.spawn(['bash', SCRIPT], {
    env: {
      ...process.env,
      PRESENCE_TEST_CHANNELS: channels,
      PRESENCE_STATE_DIR: stateDir,
    },
    stdout: 'pipe',
  })
  await new Response(proc.stdout).text()
  const baseline = JSON.parse(
    await readFile(`${stateDir}/last-online.json`, 'utf8'),
  )
  expect(baseline).toEqual({
    online: [{ fileKey: 'c', name: 'Design C' }],
  })
})

test('corrupt baseline self-heals: garbage last-online.json does not wedge the hook', async () => {
  const stateDir = freshStateDir()
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    `${stateDir}/last-online.json`,
    'not json{',
  )
  const channels = JSON.stringify([
    {
      channel: 'file-d',
      fileName: 'Design D',
      fileKey: 'd',
      connectedAt: 0,
    },
  ])
  const proc = Bun.spawn(['bash', SCRIPT], {
    env: {
      ...process.env,
      PRESENCE_TEST_CHANNELS: channels,
      PRESENCE_STATE_DIR: stateDir,
    },
    stdout: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  expect(code).toBe(0)
  expect(out).toContain('figma_bridge:')
  // baseline is now valid JSON (self-healed by the atomic rewrite)
  const baseline = JSON.parse(
    await readFile(`${stateDir}/last-online.json`, 'utf8'),
  )
  expect(baseline).toEqual({
    online: [{ fileKey: 'd', name: 'Design D' }],
  })
})
