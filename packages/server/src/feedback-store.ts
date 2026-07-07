import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import type { FeedbackCategory, FeedbackItem, FeedbackStatus } from '@figma-agent-bridge/shared'
import { FEEDBACK_CATEGORIES } from '@figma-agent-bridge/shared'

export const resolveFeedbackDir = (): string =>
  process.env.FEEDBACK_DIR ?? join(homedir(), '.figma-agent-bridge', 'feedbacks')

const slugify = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item'

const compactStamp = (iso: string): string => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

interface Frontmatter {
  title: string
  status: FeedbackStatus
  version: string
  created: string
  tool?: string
  sent_at?: string
  comment_url?: string
}

const serialize = (fm: Frontmatter, body: string): string =>
  `---\n${YAML.stringify(fm)}---\n\n${body.trim()}\n`

export interface RecordFeedbackInput {
  category: FeedbackCategory
  title: string
  description: string
  tool?: string
}

export const recordFeedback = async (
  input: RecordFeedbackInput,
  version: string,
): Promise<FeedbackItem> => {
  const created = new Date().toISOString()
  const relPath = `${input.category}/${compactStamp(created)}-${slugify(input.title)}.md`
  const absPath = join(resolveFeedbackDir(), relPath)
  const fm: Frontmatter = {
    title: input.title,
    status: 'pending',
    version,
    created,
    ...(input.tool ? { tool: input.tool } : {}),
  }
  await mkdir(join(resolveFeedbackDir(), input.category), { recursive: true })
  await writeFile(absPath, serialize(fm, input.description), 'utf8')
  return {
    path: relPath,
    category: input.category,
    title: input.title,
    description: input.description,
    version,
    created,
    ...(input.tool ? { tool: input.tool } : {}),
    status: 'pending',
  }
}

// ── Read / List / Mark ────────────────────────────────────────────────────────

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/

const parse = (relPath: string, raw: string): FeedbackItem => {
  const m = FRONTMATTER.exec(raw)
  if (!m) throw new Error(`Malformed feedback file: ${relPath}`)
  const fm = YAML.parse(m[1]) as Frontmatter
  const category = relPath.split('/')[0] as FeedbackCategory
  return {
    path: relPath,
    category,
    title: fm.title,
    description: m[2].trim(),
    version: fm.version,
    created: fm.created,
    ...(fm.tool ? { tool: fm.tool } : {}),
    status: fm.status,
    ...(fm.sent_at ? { sentAt: fm.sent_at } : {}),
    ...(fm.comment_url ? { commentUrl: fm.comment_url } : {}),
  }
}

export const readItem = async (relPath: string): Promise<FeedbackItem> => {
  const raw = await readFile(join(resolveFeedbackDir(), relPath), 'utf8')
  return parse(relPath, raw)
}

export const listPending = async (limit: number): Promise<FeedbackItem[]> => {
  const root = resolveFeedbackDir()
  const items: FeedbackItem[] = []
  for (const category of FEEDBACK_CATEGORIES) {
    let files: string[]
    try { files = await readdir(join(root, category)) } catch { continue }
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      const relPath = `${category}/${file}`
      const item = parse(relPath, await readFile(join(root, relPath), 'utf8'))
      if (item.status === 'pending') items.push(item)
    }
  }
  items.sort((a, b) => b.created.localeCompare(a.created))
  return items.slice(0, limit)
}

const rewrite = async (
  relPath: string,
  patch: Partial<Pick<Frontmatter, 'status' | 'sent_at' | 'comment_url'>>,
): Promise<FeedbackItem> => {
  const absPath = join(resolveFeedbackDir(), relPath)
  const raw = await readFile(absPath, 'utf8')
  const m = FRONTMATTER.exec(raw)
  if (!m) throw new Error(`Malformed feedback file: ${relPath}`)
  const fm = { ...(YAML.parse(m[1]) as Frontmatter), ...patch }
  await writeFile(absPath, serialize(fm, m[2].trim()), 'utf8')
  return parse(relPath, await readFile(absPath, 'utf8'))
}

export const markSent = (relPath: string, commentUrl: string): Promise<FeedbackItem> =>
  rewrite(relPath, { status: 'sent', sent_at: new Date().toISOString(), comment_url: commentUrl })

export const markFailed = (relPath: string): Promise<FeedbackItem> =>
  rewrite(relPath, { status: 'failed' })
