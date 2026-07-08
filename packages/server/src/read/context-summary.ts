import { CONTEXT_SUMMARY_MAX_BYTES } from '@figma-agent-bridge/shared'

/** Extract the inner frontmatter of a context markdown value as a capped, read-only summary.
 * Returns undefined when there is no byte-0 `---` fence or the fence is never closed. */
export const contextSummaryOf = (
  raw: string | undefined,
): string | undefined => {
  if (typeof raw !== 'string') return undefined
  const body = raw.startsWith('---\r\n')
    ? raw.slice(5)
    : raw.startsWith('---\n')
      ? raw.slice(4)
      : null
  if (body === null) return undefined
  const lines = body.split('\n')
  const closeIdx = lines.findIndex(
    l => l === '---' || l === '---\r',
  )
  if (closeIdx === -1) return undefined
  const inner = lines
    .slice(0, closeIdx)
    .join('\n')
    .replace(/\r$/, '')
    .trimEnd()
  return capBytes(inner, CONTEXT_SUMMARY_MAX_BYTES)
}

/** Truncate to at most `max` UTF-8 bytes on a codepoint boundary; append '…' within budget when cut. */
const capBytes = (s: string, max: number): string => {
  if (Buffer.byteLength(s, 'utf8') <= max) return s
  const marker = '…' // 3 UTF-8 bytes
  const budget = max - Buffer.byteLength(marker, 'utf8')
  let out = ''
  for (const ch of s) {
    if (Buffer.byteLength(out + ch, 'utf8') > budget) break
    out += ch
  }
  return out + marker
}
