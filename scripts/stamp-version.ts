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
) => {
  const p = join(root, relPath)
  const o = JSON.parse(await readFile(p, 'utf8'))
  mutate(o)
  await writeFile(p, JSON.stringify(o, null, 2) + '\n')
  console.log(`stamped ${relPath} -> ${version}`)
}

await stampJson('plugin/.claude-plugin/plugin.json', o => {
  o.version = version
})
await stampJson('.claude-plugin/marketplace.json', o => {
  const plugins = o.plugins as Record<string, unknown>[]
  for (const pl of plugins) {
    pl.version = version
  }
})
console.log(`version-of-record: ${version}`)
