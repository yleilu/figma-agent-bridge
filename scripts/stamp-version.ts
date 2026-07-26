// Stamp the single version-of-record (root package.json)
// into the plugin manifests.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isBareSemver } from './release-version'

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
)
const pkg = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8'),
)
const version = pkg.version as string
// The release turns this number into the git tag `vX.Y.Z`, an
// `npm view` argument and a tarball filename, so a malformed one
// stops here rather than reaching the registry (§6.1, §6.4).
if (!isBareSemver(version)) {
  throw new Error(
    `the root manifest's version is not a bare semver number: ${JSON.stringify(version)}`,
  )
}

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
// The published package's npm metadata — one of the four fields the
// lockstep table names (§6.3). Required, not optional: a tree without
// it would publish a package manifest no release ever stamped.
await stampJson('plugin/package.json', o => {
  o.version = version
})
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
