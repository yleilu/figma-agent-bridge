// Stamp the single version-of-record (root package.json)
// into the plugin manifests.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
)
const pkg = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8'),
)
const version = pkg.version as string

const stampJson = async (
  relPath: string,
  mutate: (o: Record<string, unknown>) => void,
  { optional = false }: { optional?: boolean } = {},
) => {
  const p = join(root, relPath)
  let raw: string
  try {
    raw = await readFile(p, 'utf8')
  } catch (err) {
    const { code } = err as NodeJS.ErrnoException
    if (optional && code === 'ENOENT') {
      console.log(`skipped ${relPath} (absent)`)
      return
    }
    throw err
  }
  const o = JSON.parse(raw)
  mutate(o)
  await writeFile(p, JSON.stringify(o, null, 2) + '\n')
  console.log(`stamped ${relPath} -> ${version}`)
}

await stampJson('plugin/.claude-plugin/plugin.json', o => {
  o.version = version
})
// The published package's npm metadata. Optional so the stamp
// still runs on a tree that predates it.
await stampJson(
  'plugin/package.json',
  o => {
    o.version = version
  },
  { optional: true },
)
await stampJson('.claude-plugin/marketplace.json', o => {
  const plugins = o.plugins as Record<string, unknown>[]
  for (const pl of plugins) {
    pl.version = version
    // `source` is either a bare path/URL string (nothing of
    // its own to stamp) or a source object — the npm form
    // pins the exact package version to fetch.
    const src = pl.source
    if (src && typeof src === 'object') {
      const s = src as Record<string, unknown>
      if (s.source === 'npm') {
        s.version = version
      }
    }
  }
})
console.log(`version-of-record: ${version}`)
