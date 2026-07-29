import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sanitizeKey } from '@figma-agent-bridge/shared/paths'

export const resolveIndexDir = (): string =>
  process.env.COMPONENT_INDEX_DIR ??
  join(homedir(), '.figma-agent-bridge', 'component-index')

/** Sanitize a fileKey for use as a filename. The `.json` is the CALLER's. */
const fileName = (fileKey: string): string =>
  `${sanitizeKey(fileKey)}.json`

type CachePayload = {
  version: string
  serialized: string
}

/**
 * Persist the serialized MiniSearch index for a
 * file, stamped with `version`.
 */
export const saveIndex = async (
  fileKey: string,
  payload: CachePayload,
): Promise<void> => {
  const dir = resolveIndexDir()
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, fileName(fileKey)),
    JSON.stringify(payload),
    'utf8',
  )
}

/**
 * Load the serialized index if present AND its
 * version matches; else null.
 */
export const loadCachedIndex = async (
  fileKey: string,
  currentVersion: string,
): Promise<string | null> => {
  let raw: string
  try {
    raw = await readFile(
      join(resolveIndexDir(), fileName(fileKey)),
      'utf8',
    )
  } catch {
    return null
  }
  let parsed: CachePayload
  try {
    parsed = JSON.parse(raw) as CachePayload
  } catch {
    return null
  }
  if (parsed.version !== currentVersion) {
    return null
  }
  return parsed.serialized
}
